import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { startKlaudServe } from "../src/harness/klaud/serve.ts";
import type { AssistantMessageEvent } from "../src/ai/types.ts";

test("a run starting during a slow setup body blocks configuration changes and probes", { timeout: 15_000 }, async t => {
  for (const [path, method, input] of [
    ["/accounts/provider", "PUT", { provider: "custom", model: "replacement-model", baseUrl: "https://models.example.invalid/v1", apiKey: "fixture-replacement-key" }],
    ["/setup", "POST", { budgets: { maxTurns: 900, maxIterations: 40 } }],
    ["/setup/probe", "POST", {}],
    // If the guard regresses, this invalid discovery body fails before making network calls.
    ["/setup/discover", "POST", { network: "invalid" }],
  ] as const) await t.test(path, async () => {
    const home = mkdtempSync(join(tmpdir(), "klaudbot-setup-race-")), previousHome = process.env.REIN_HOME;
    process.env.REIN_HOME = home;
    const configFile = join(home, "config.json");
    // CLI mode makes the probe fixture entirely offline if the guard regresses.
    const original = JSON.stringify({ provider: "codex", model: "default", baseUrl: "cli://codex", auth: { type: "cli", provider: "codex" }, maxTurns: 300, maxIterations: 25 });
    writeFileSync(configFile, original);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    async function* run(): AsyncGenerator<AssistantMessageEvent> { await waiting; }
    const server = await startKlaudServe({ home, run });
    const payload = JSON.stringify(input);
    const headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
    const slow = request(server.url + path, { method, headers: { ...headers, "Content-Length": Buffer.byteLength(payload), Expect: "100-continue" } });
    let consumed: Promise<string> | undefined;
    try {
      const result = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        slow.on("response", response => {
          let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
          response.on("end", () => resolve({ status: response.statusCode, body })); response.on("error", reject);
        });
        slow.on("error", reject);
      });
      const ready = once(slow, "continue");
      slow.flushHeaders();
      // HTTP's continue response establishes that this request reached the server
      // before the run; its complete JSON body is deliberately withheld.
      await ready;
      const active = await fetch(server.url + "/run", { method: "POST", headers, body: JSON.stringify({ threadId: "fixture-race-session", message: "fixture waiting task", tools: [] }) });
      assert.equal(active.status, 200);
      consumed = active.text();
      slow.end(payload);
      const response = await result;
      assert.equal(response.status, 409, response.body);
      assert.match(JSON.parse(response.body).error, /Finish or stop the current run/);
      assert.equal(readFileSync(configFile, "utf8"), original);
      assert.equal(existsSync(join(home, "profile.yaml")), false);
    } finally {
      slow.destroy(); release(); await consumed;
      await server.close();
      if (previousHome === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
