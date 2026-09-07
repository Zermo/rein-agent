import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, linkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readInstallation, runEditionSetup, parseEdition } from "../src/harness/installation.ts";
const exec = promisify(execFile);
function fixture(t: test.TestContext) {
 const home = mkdtempSync(join(tmpdir(), "rein-edition-")), events: string[] = [], logs: string[] = [];
 t.after(() => rmSync(home, { recursive: true, force: true }));
 const deps = { home, log: (text: string) => logs.push(text), installCloud: async () => { events.push("app-install"); }, assessOS: async () => { events.push("read-only-assessment"); } };
 return { home, events, logs, deps };
}
test("gateway is the unattended base and changes only edition/surface preferences", async t => {
 const f = fixture(t); writeFileSync(join(f.home, "config.json"), '{"model":"fixture","apiKey":"private-fixture"}'); writeFileSync(join(f.home, "session.jsonl"), "preserve history");
 assert.equal(await runEditionSetup({ yes: true }, f.deps), "gateway");
 assert.deepEqual(f.events, []); assert.equal(readInstallation(f.home)?.edition, "gateway");
 assert.equal(JSON.parse(readFileSync(join(f.home, "desktop.json"), "utf8")).surface, "terminal");
 assert.equal(readFileSync(join(f.home, "config.json"), "utf8"), '{"model":"fixture","apiKey":"private-fixture"}');
 assert.equal(readFileSync(join(f.home, "session.jsonl"), "utf8"), "preserve history");
 assert.doesNotMatch(f.logs.join("\n"), /private-fixture/);
 if (process.platform !== "win32") assert.equal(statSync(join(f.home, "installation.json")).mode & 0o777, 0o600);
});
test("interactive choice discloses all editions and installs an app only after cloud selection", async t => {
 const f = fixture(t), answers = ["bad", "4", "2"];
 const prompt = { async ask() { assert.match(f.logs.join("\n"), /not available yet/); assert.deepEqual(f.events, []); return answers.shift()!; }, async secret() { assert.fail("No credentials needed"); }, close() { assert.fail("Caller owns this prompt"); } };
 assert.equal(await runEditionSetup({}, { ...f.deps, prompt }), "cloud");
 assert.deepEqual(f.events, ["app-install"]);
 assert.equal(readInstallation(f.home)?.edition, "cloud");
 assert.equal(JSON.parse(readFileSync(join(f.home, "desktop.json"), "utf8")).surface, "klaud");
 assert.match(f.logs.join("\n"), /separately enabled autonomy/);
});
test("OS choice performs only the assessment and records a development selection", async t => {
 const f = fixture(t);
 await runEditionSetup({ edition: "os", yes: true }, f.deps);
 assert.deepEqual(f.events, ["read-only-assessment"]); assert.equal(readInstallation(f.home)?.edition, "os");
 assert.match(f.logs.join("\n"), /physical-machine migration are not available/);
 assert.deepEqual(readdirSync(f.home).sort(), ["desktop.json", "installation.json"]);
});
test("failed app install preserves previous selection and has an actionable recovery path", async t => {
 const f = fixture(t); await runEditionSetup({ edition: "gateway" }, f.deps);
 const before = readFileSync(join(f.home, "installation.json"), "utf8");
 await assert.rejects(runEditionSetup({ edition: "cloud" }, { ...f.deps, installCloud: async () => { throw new Error("download unavailable"); } }), /download unavailable/);
 assert.equal(readFileSync(join(f.home, "installation.json"), "utf8"), before);
 assert.equal(JSON.parse(readFileSync(join(f.home, "desktop.json"), "utf8")).surface, "terminal");
});
test("cancelled selection and invalid editions perform no writes or installs", async t => {
 const f = fixture(t);
 await assert.rejects(runEditionSetup({}, { ...f.deps, prompt: { async ask() { throw new Error("Setup input closed"); }, async secret() { return undefined; }, close() {} } }), /input closed/);
 for (const value of ["unknown", "", true, "cloud; touch nope"]) assert.throws(() => parseEdition(value), /must be/);
 await assert.rejects(runEditionSetup({ edition: "unknown" as any }, f.deps), /must be/);
 assert.deepEqual(f.events, []); assert.deepEqual(readdirSync(f.home), []);
});
test("malformed, oversized and linked settings are preserved and never trigger installation", async t => {
 for (const kind of ["invalid", "oversized", "symlink", "hardlink"]) {
  const f = fixture(t), target = join(f.home, "private.txt"), file = join(f.home, "installation.json");
  writeFileSync(target, "private-fixture");
  if (kind === "symlink") symlinkSync(target, file);
  else if (kind === "hardlink") linkSync(target, file);
  else writeFileSync(file, kind === "oversized" ? " ".repeat(4097) : '{"schemaVersion":1,"edition":"secret-value"}');
  const before = readFileSync(file, "utf8");
  await assert.rejects(runEditionSetup({ edition: "cloud" }, f.deps), error => !/secret-value|private-fixture/.test(String(error)));
  assert.deepEqual(f.events, []); assert.equal(readFileSync(file, "utf8"), before); assert.equal(readFileSync(target, "utf8"), "private-fixture");
 }
});
test("real edition CLI supports offline status and gateway setup without a model", async t => {
 const f = fixture(t), cli = new URL("../bin/rein.js", import.meta.url).pathname;
 const run = (args: string[]) => exec(process.execPath, [cli, ...args], { env: { ...process.env, REIN_HOME: f.home }, timeout: 10000 });
 assert.equal((await run(["setup", "edition", "--status", "--id"])).stdout.trim(), "gateway");
 assert.deepEqual(readdirSync(f.home), []);
 await run(["setup", "edition", "--edition", "gateway", "--yes"]);
 assert.equal(readInstallation(f.home)?.edition, "gateway");
 for (const args of [["setup", "edition", "--edition", "cloud", "--status"], ["setup", "--edition", "cloud", "--connection-only"], ["setup", "--edition", "invalid"], ["setup", "edition", "--wipe"]]) await assert.rejects(run(args));
 assert.deepEqual(readdirSync(f.home).sort(), ["desktop.json", "installation.json"]);
});
