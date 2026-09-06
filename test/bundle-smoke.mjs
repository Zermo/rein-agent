// Runs the shipped bundle on Node 18+ with no dev dependencies or provider credentials.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "rein-bundle-"));
let requests = 0;
let meatRequests = 0;
let webRequests = 0;
const cliEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NODETERM_"))), REIN_HOME: dir, REIN_API: "", REIN_API_KEY: "", REIN_BASE_URL: "", REIN_MODEL: "" };
const runCli = (args, extraEnv = {}, input = "") => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, "dist/rein.js"), ...args], { cwd: dir, env: { ...cliEnv, ...extraEnv } });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
  child.on("error", reject);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  child.stdin.end(input);
});
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  assert.equal(req.url, "/v1/chat/completions");
  if (body.model === "bundle-web") {
    webRequests++;
    assert.ok(body.tools.some(tool => tool.function.name === "web_search"));
    assert.ok(body.tools.some(tool => tool.function.name === "web_fetch"));
    if (webRequests === 2) assert.ok(body.messages.some(message => message.role === "tool" && message.content.includes("Native browser fixture")));
    const message = webRequests === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "fetch", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://example.com/" }) } }] } : { role: "assistant", content: "native web bundle OK" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message, finish_reason: webRequests === 1 ? "tool_calls" : "stop" }] })); return;
  }
  if (body.model === "bundle-meat") {
    meatRequests++;
    assert.ok(body.tools.some(tool => tool.function.name === "submit"));
    if (meatRequests === 2) assert.ok(body.messages.some(message => message.role === "tool" && message.content.includes("new_value = 2")), "Bundled worker must dispatch source reads through the host.");
    const call = meatRequests === 1 ? { name: "read_file", arguments: JSON.stringify({ path: "value.txt", start_line: 1, end_line: 1 }) }
      : { name: "submit", arguments: JSON.stringify({ remove: [], replace: [], fold: [], summary: "Update the value." }) };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: `meat-${meatRequests}`, type: "function", function: call }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    return;
  }
  requests++;
  assert.ok(body.tools.some(tool => tool.function.name === "new_context"));
  if (requests === 2) {
    assert.ok(body.messages.some(message => typeof message.content === "string" && message.content.includes("bundle handoff")));
    assert.ok(!body.messages.some(message => message.content === "original bundle prompt"));
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: requests === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "roll", type: "function", function: { name: "new_context", arguments: JSON.stringify({ handoff: "bundle handoff" }) } }] } : { role: "assistant", content: "bundle rollover OK" }, finish_reason: requests === 1 ? "tool_calls" : "stop" }] }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const result = await runCli(["--api", "chat-completions", "--base-url", endpoint, "--model", "bundle-mock", "--tools", "native", "-p", "original bundle prompt", "--save"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /bundle rollover OK/);
  assert.equal(requests, 2);
  // The distributed build exposes the new provider routes without starting login.
  const help = await runCli(["--help"]);
  assert.match(help.stdout, /--provider grok/); assert.match(help.stdout, /--provider xai/);
  assert.match(help.stdout, /--discover-network/);
  const budgetHome = join(dir, "budget-settings");
  const initialBudgets = await runCli(["setup", "budgets", "--json"], { REIN_HOME: budgetHome });
  assert.equal(initialBudgets.code, 0, initialBudgets.stdout + initialBudgets.stderr);
  assert.equal(JSON.parse(initialBudgets.stdout).maxTurns, 300);
  assert.equal(JSON.parse(initialBudgets.stdout).maxIterations, 25);
  const budgetSetup = await runCli(["setup", "budgets"], { REIN_HOME: budgetHome }, "4\n450\n35\n");
  assert.equal(budgetSetup.code, 0, budgetSetup.stdout + budgetSetup.stderr);
  const savedBudgets = JSON.parse((await runCli(["setup", "budgets", "--json"], { REIN_HOME: budgetHome })).stdout);
  assert.equal(savedBudgets.maxTurns, 450); assert.equal(savedBudgets.maxIterations, 35);
  assert.equal(savedBudgets.source.maxTurns, "saved");
  assert.equal(requests, 2, "The budget wizard runs offline without a model account or discovery.");
  const invalidPort = await runCli(["models", "--discover-ports", "70000"]);
  assert.equal(invalidPort.code, 1); assert.match(invalidPort.stderr, /1 to 65535/);
  const hardware = await runCli(["hardware", "--focus", "everyday", "--json"]);
  assert.equal(hardware.code, 0, hardware.stderr);
  const hardwarePlan = JSON.parse(hardware.stdout);
  assert.equal(hardwarePlan.scope, "current-machine"); assert.equal(hardwarePlan.focus, "everyday");
  assert.ok(Array.isArray(hardwarePlan.recipes));
  const invalidApi = await runCli(["--api", "responses", "--base-url", endpoint, "--model", "bundle-mock", "-p", "must not send"]);
  assert.notEqual(invalidApi.code, 0); assert.match(invalidApi.stderr, /Supported HTTP API/);
  const health = await runCli(["doctor", "--silent", "--json"], { REIN_HOME: join(dir, "health"), PATH: "/usr/bin:/bin" });
  const report = JSON.parse(health.stdout);
  assert.equal(health.code, 1, "Missing configuration must remain a failure in silent mode.");
  assert.equal(report.checks.find(check => check.name === "node").status, "ok");
  const compatibilityRuntime = [18, 20, 22, 24].includes(Number(process.versions.node.split(".")[0]));
  assert.equal(report.flags.length, compatibilityRuntime ? 1 : 0);
  if (compatibilityRuntime) assert.equal(report.flags[0].silent, true);
  assert.ok(report.failures >= 1);
  if (process.platform !== "win32") {
    const updateBin = join(dir, "update-bin"); mkdirSync(updateBin);
    const updateScript = '#!/bin/bash\ntest "$1" = --skip-setup || exit 9\nprintf updated > "$REIN_HOME/update-marker"\n';
    writeFileSync(join(updateBin, "curl"), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.writeFileSync(args[args.indexOf('--output') + 1], ${JSON.stringify(updateScript)});\n`, { mode: 0o700 });
    const updated = await runCli(["update"], { PATH: `${updateBin}:/usr/bin:/bin` });
    assert.equal(updated.code, 0, updated.stdout + updated.stderr);
    assert.match(updated.stdout, /Rein update complete/);
    assert.equal(readFileSync(join(dir, "update-marker"), "utf8"), "updated");
  }
  for (const args of [["autonomy", "init", "--daily-budget", "2"], ["autonomy", "status", "--json"], ["autonomy", "tui"], ["skills"], ["skills", "diagnosing-bugs"], ["skills", "tdd", "tests.md"], ["debug", join(dir, "sessions"), "--json"]]) {
    const result = await runCli(args);
    assert.equal(result.code, 0, result.stderr);
    if (args[1] === "status") { const state = JSON.parse(result.stdout); assert.equal(state.paused, true); assert.equal(state.maxRunsPerDay, 2); assert.equal(state.runs.length, 0); }
    if (args[1] === "tui") assert.match(result.stdout, /Rein autonomy/);
    if (args[0] === "skills") assert.match(result.stdout, args[1] === "tdd" ? /test/i : /diagnos/i);
    if (args[0] === "debug") { const report = JSON.parse(result.stdout); assert.equal(report.sessions, 1); assert.equal(report.totals.toolResults, 1); }
  }
  const guardian = await runCli(["autonomy", "guardian", "status", "--json"]);
  assert.equal(guardian.code, 0, guardian.stdout + guardian.stderr);
  const guardianState = JSON.parse(guardian.stdout);
  assert.equal(guardianState.mode, "rules"); assert.equal(guardianState.cloudFallback, false);
  const rulesScan = await runCli(["autonomy", "scan"]); assert.equal(rulesScan.code, 0, rulesScan.stderr);
  const planner = await runCli(["autonomy", "planner", "main"]); assert.equal(planner.code, 0, planner.stderr);
  assert.equal(JSON.parse((await runCli(["autonomy", "status", "--json"])).stdout).planner, "main");
  assert.equal((await runCli(["autonomy", "planner", "rules"])).code, 0);
  assert.equal(requests, 2, "autonomy controls do not start inference");
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
  git("init"); git("config", "user.name", "Bundle Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(dir, "value.txt"), "old_value = 1\n"); git("add", "value.txt"); git("commit", "-m", "fixture");
  writeFileSync(join(dir, "value.txt"), "new_value = 2\n");
  const noGo = join(dir, "no-go"); mkdirSync(noGo);
  writeFileSync(join(noGo, "go"), '#!/bin/sh\nprintf invoked > "$REIN_HOME/go-invoked"\nexit 99\n', { mode: 0o755 });
  const reviewed = await runCli(["meat", "--working-tree", "--json", "--api", "chat-completions", "--base-url", endpoint, "--model", "bundle-meat", "--tools", "native"], { PATH: `${noGo}:${process.env.PATH}` });
  assert.equal(reviewed.code, 0, reviewed.stderr);
  const review = JSON.parse(reviewed.stdout);
  assert.equal(review.summary, "Update the value."); assert.match(review.smart_diff, /\+new_value = 2/);
  assert.equal(review.input_tokens, 20); assert.equal(review.output_tokens, 10); assert.equal(meatRequests, 2);
  assert.equal(readFileSync(join(dir, "value.txt"), "utf8"), "new_value = 2\n");
  assert.equal(existsSync(join(dir, "go-invoked")), false, "Installed Meat must run without invoking Go.");
  const browser = join(dir, "obscura-fixture");
  const browserPage = { kind: "page", title: "Native fixture", url: "https://example.com/", text: "Native browser fixture", chars: 22, truncated: false };
  writeFileSync(browser, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(browserPage))});\n`, { mode: 0o700 });
  const web = await runCli(["--api", "chat-completions", "--base-url", endpoint, "--model", "bundle-web", "--tools", "native", "-p", "read the fixture"], { OBSCURA_BIN: browser });
  assert.equal(web.code, 0, web.stderr); assert.equal(webRequests, 2); assert.match(web.stdout, /native web bundle OK/);
  const invalidWeb = await runCli(["web", "search", "fixture", "--language", "fr"], { OBSCURA_BIN: browser });
  assert.notEqual(invalidWeb.code, 0); assert.match(invalidWeb.stderr, /does not support --language/);
  const profileSetup = await runCli(["setup", "profile"], {}, "a\na\nc\na\na\na\n3\n1\n");
  assert.equal(profileSetup.code, 0, profileSetup.stdout + profileSetup.stderr);
  const profile = JSON.parse((await runCli(["profile", "--json"])).stdout);
  assert.equal(profile.recommended_pack, "ship"); assert.equal(profile.enabled_pack, null);
  for (const name of ["SOUL.md", "USER.md", "AGENTS.md", "profile.yaml"]) assert.ok(existsSync(join(dir, name)));
  const enablePack = await runCli(["profile", "pack", "ship"]); assert.equal(enablePack.code, 0, enablePack.stderr);
  const nativeSkill = await runCli(["skills", "code-change"]); assert.equal(nativeSkill.code, 0, nativeSkill.stderr);
  assert.match(nativeSkill.stdout, /Original Rein-native workflow/);
  const disablePack = await runCli(["profile", "pack", "none"]); assert.equal(disablePack.code, 0, disablePack.stderr);
  assert.equal((await runCli(["skills", "code-change"])).code, 1);
  console.log(`bundle smoke OK (${process.version})`);
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
