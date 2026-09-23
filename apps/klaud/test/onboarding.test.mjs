import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOnboarding, accountVerificationUrl, onboardingEnvironment } from "../onboarding.mjs";

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "klaudbot-setup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userHome = join(root, "user"), userData = join(userHome, "app-data"), sourceHome = join(userHome, ".rein"), target = join(userHome, ".klaudbot");
  mkdirSync(userHome, { mode: 0o700 });
  const write = (name, value) => { const file = join(sourceHome, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };
  const session = (id, extra = {}) => write(`sessions/${id}.jsonl`, JSON.stringify({ type: "header", version: 1, id, created: "2026-01-01T00:00:00.000Z", ...extra }) + '\n{"role":"user","content":"private transcript"}\n');
  return { root, userHome, userData, sourceHome, target, write, session, api: createOnboarding({ userHome, userData, sourceHome, ...options }), reopen: () => createOnboarding({ userHome, userData, sourceHome }) };
}
const config = { provider: "custom", baseUrl: "http://model-box.local:1234/v1", model: "sample-model", apiKey: "fixture-key-never-return", auth: { type: "api-key" }, maxTurns: 400 };
const oldBot = { id: "klaud-bot-12345678", name: "Existing bot", sessionId: "known-session", created: "2026-01-01T00:00:00.000Z" };

test("first inspection is read only and returns no user content or paths", t => {
  const f = fixture(t);
  assert.deepEqual(f.api.inspect(), { version: 1, completed: false, prepared: false, existing: { found: false, configured: false, sessionCount: 0, botCount: 0, profileFound: false } });
  assert.deepEqual(readdirSync(f.userHome), []);
  f.write("config.json", config); f.write("profile.yaml", "private profile"); f.session("known-session"); f.write("klaud/bots.json", { version: 1, bots: [oldBot] });
  assert.deepEqual(f.api.inspect().existing, { found: true, configured: true, sessionCount: 1, botCount: 1, profileFound: true });
  const output = JSON.stringify(f.api.inspect());
  for (const secret of [config.apiKey, config.model, config.baseUrl, f.sourceHome, "private transcript", "Existing bot"]) assert.ok(!output.includes(secret));
  assert.ok(!existsSync(f.userData)); assert.ok(!existsSync(f.target));
});

test("migration copies allowlisted data privately, registers user sessions, and keeps source unchanged", async t => {
  const f = fixture(t);
  f.write("config.json", config); f.write("SOUL.md", "operator voice"); f.write("notes/MEMORY.md", "durable note"); f.write("workspace/.pi/notes/MEMORY.md", "workspace note");
  f.session("known-session"); f.session("new-session"); f.session("background-session", { purpose: "autonomy" });
  f.write("sessions/invalid-session.jsonl", "not json\n"); f.session("mismatch", { id: "other" });
  f.write("klaud/bots.json", { version: 1, bots: [oldBot] }); f.write("cli-auth/codex/auth.json", { fixtureCredential: "private" });
  for (const file of ["repo/main.js", "config.json.lock", "klaud/serve-1234.token", "klaud/bots.json.lock", "autonomy/state.json", "cli-auth/codex/hooks.json", "cli-auth/codex/logs/run.json", "notes/task.lock"]) f.write(file, "must not migrate");
  const original = readFileSync(join(f.sourceHome, "config.json"));
  assert.equal(await f.api.prepare("migrate"), f.target);
  assert.deepEqual(readFileSync(join(f.target, "config.json")), original);
  assert.deepEqual(readFileSync(join(f.sourceHome, "config.json")), original);
  assert.equal(readFileSync(join(f.target, "notes/MEMORY.md"), "utf8"), "durable note");
  assert.ok(existsSync(join(f.target, "cli-auth/codex/auth.json")));
  for (const file of ["repo", "config.json.lock", "klaud/serve-1234.token", "klaud/bots.json.lock", "autonomy", "cli-auth/codex/hooks.json", "cli-auth/codex/logs", "notes/task.lock"]) assert.ok(!existsSync(join(f.target, file)), file);
  const bots = JSON.parse(readFileSync(join(f.target, "klaud/bots.json"), "utf8")).bots;
  assert.equal(bots.length, 2); assert.deepEqual(bots[0], oldBot); assert.equal(bots[1].sessionId, "new-session"); assert.match(bots[1].name, /^Imported session /);
  assert.ok(existsSync(join(f.target, "sessions/background-session.jsonl"))); // Preserved history; never made into a user bot.
  assert.equal(lstatSync(f.target).mode & 0o777, 0o700); assert.equal(lstatSync(join(f.target, "config.json")).mode & 0o777, 0o600);
});

test("fresh setup has no original config, sessions, credentials or profile", async t => {
  const f = fixture(t); f.write("config.json", config); f.session("old"); f.write("profile.yaml", "private");
  await f.api.prepare("fresh");
  assert.deepEqual(readdirSync(f.target), [".klaudbot-home.json"]);
  assert.ok(existsSync(join(f.sourceHome, "config.json")));
  assert.deepEqual(f.reopen().inspect(), { ...f.api.inspect(), prepared: true, completed: false, choice: "fresh" });
  assert.equal(f.api.home(), f.target);
});

test("setup resumes same choice without replacing edited data and completes only explicitly", async t => {
  const f = fixture(t); await f.api.prepare("fresh");
  writeFileSync(join(f.target, "config.json"), JSON.stringify(config));
  const reopened = f.reopen(); assert.equal(reopened.inspect().completed, false);
  await reopened.prepare("fresh"); assert.equal(JSON.parse(readFileSync(join(f.target, "config.json"), "utf8")).model, "sample-model");
  await assert.rejects(reopened.prepare("migrate"), /already has a home/);
  assert.equal(reopened.complete().completed, true); assert.equal(f.reopen().inspect().completed, true);
  await assert.rejects(reopened.prepare("fresh"), /complete/);
});

test("completion and runtime home selection refuse unprepared setup", t => {
  const f = fixture(t); assert.throws(() => f.api.complete(), /Prepare/); assert.throws(() => f.api.home(), /first setup step/);
  assert.ok(!existsSync(f.userData));
});

test("malformed old config stays private and does not prevent choosing fresh", async t => {
  const f = fixture(t); f.write("config.json", '{"apiKey":"fixture-key-never-return",broken');
  assert.equal(f.api.inspect().existing.found, true); assert.equal(f.api.inspect().existing.configured, false);
  await assert.rejects(f.api.prepare("migrate"), error => /malformed/.test(error.message) && !error.message.includes("fixture-key"));
  assert.ok(!existsSync(f.target)); assert.ok(!existsSync(f.userData));
  assert.ok(!readdirSync(f.userHome).some(name => name.startsWith(".klaudbot-setup")));
  await f.api.prepare("fresh");
});

test("blank installed config is valid but unconfigured", async t => {
  const f = fixture(t); f.write("config.json", "\n  ");
  assert.equal(f.api.inspect().existing.configured, false); await f.api.prepare("migrate");
  assert.equal(readFileSync(join(f.target, "config.json"), "utf8"), "\n  ");
});

test("unsafe symlink files abort the entire migration without changing source", async t => {
  const f = fixture(t); f.write("config.json", config); f.write("notes/good.md", "safe");
  const external = join(f.root, "external-secret"); writeFileSync(external, "private external"); symlinkSync(external, join(f.sourceHome, "notes/linked.md"));
  await assert.rejects(f.api.prepare("migrate"), /symbolic links/);
  assert.ok(!existsSync(f.target)); assert.equal(readFileSync(external, "utf8"), "private external");
  assert.ok(!readdirSync(f.userHome).some(name => name.startsWith(".klaudbot-setup")));
});

test("symlinked source and profile can still be skipped with fresh setup", async t => {
  const f = fixture(t), outside = join(f.root, "original"); mkdirSync(outside); writeFileSync(join(outside, "config.json"), JSON.stringify(config));
  symlinkSync(outside, f.sourceHome);
  assert.equal(f.api.inspect().existing.found, true);
  await assert.rejects(f.api.prepare("migrate"), /symbolic links/);
  await f.api.prepare("fresh");
});

test("target data without this app's setup marker is never overwritten", async t => {
  const f = fixture(t); mkdirSync(f.target); writeFileSync(join(f.target, "keep.txt"), "existing");
  await assert.rejects(f.api.prepare("fresh"), /already exists/);
  assert.equal(readFileSync(join(f.target, "keep.txt"), "utf8"), "existing");
});

test("target symlink is refused without touching its destination", async t => {
  const f = fixture(t), external = join(f.root, "outside"); mkdirSync(external); symlinkSync(external, f.target);
  await assert.rejects(f.api.prepare("fresh"), /symbolic links/); assert.deepEqual(readdirSync(external), []);
});

test("a copy failure before publish rolls back all staging and leaves first run retryable", async t => {
  const f = fixture(t, { beforePublish: () => { throw new Error("Injected disk failure"); } }); f.write("config.json", config);
  await assert.rejects(f.api.prepare("migrate"), /Injected disk failure/);
  assert.ok(!existsSync(f.target)); assert.ok(!existsSync(f.userData));
  assert.deepEqual(readdirSync(f.userHome), [".rein"]);
  await f.reopen().prepare("migrate"); assert.ok(existsSync(f.target));
});

test("durable prepared intent resumes a crash before home promotion", async t => {
  const f = fixture(t), transaction = "12345678-1234-1234-1234-123456789012", stage = join(f.userHome, `.klaudbot-setup-${transaction}`);
  mkdirSync(f.userData); mkdirSync(stage);
  const pending = { version: 1, transaction, choice: "fresh", prepared: false, completed: false };
  writeFileSync(join(f.userData, "klaudbot-onboarding.json"), JSON.stringify(pending));
  writeFileSync(join(stage, ".klaudbot-home.json"), JSON.stringify({ version: 1, transaction, choice: "fresh" }));
  assert.equal(f.api.inspect().prepared, false);
  await f.api.prepare("fresh"); assert.equal(f.api.inspect().prepared, true); assert.ok(!existsSync(stage));
});

test("receipt recovers promotion completed before native marker update", async t => {
  const f = fixture(t); await f.api.prepare("fresh");
  const path = join(f.userData, "klaudbot-onboarding.json"), marker = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...marker, prepared: false }));
  assert.equal(f.reopen().inspect().prepared, true); assert.equal(f.reopen().home(), f.target);
  assert.equal(f.reopen().complete().completed, true);
});

test("missing or foreign prepared home never silently starts a blank home", async t => {
  const f = fixture(t); await f.api.prepare("fresh");
  rmSync(f.target, { recursive: true }); assert.throws(() => f.reopen().home(), /missing/);
  mkdirSync(f.target); writeFileSync(join(f.target, ".klaudbot-home.json"), '{"transaction":"foreign"}');
  assert.throws(() => f.reopen().home(), /does not belong/);
});

test("concurrent preparation refuses the duplicate operation", async t => {
  let release; const paused = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { beforePublish: () => paused });
  const first = f.api.prepare("fresh"); await assert.rejects(f.api.prepare("fresh"), /already preparing/);
  release(); await first; assert.equal(f.api.inspect().prepared, true);
});

test("source cannot alias or contain destination home", async t => {
  const f = fixture(t);
  const api = createOnboarding({ userHome: f.userHome, userData: f.userData, sourceHome: f.userHome });
  await assert.rejects(api.prepare("fresh"), /separate private homes/);
});

test("model routing and keys cannot leak from inherited harness environment into fresh home", () => {
  const original = { PATH: "/usr/bin", REIN_BASE_URL: "http://old.local", REIN_API_KEY: "secret", REIN_MODEL: "old", REIN_HOME: "/old", OPENAI_API_KEY: "key", XAI_API_KEY: "key2", REIN_KLAUD_URL: "http://127.0.0.1:8000", KEEP: "ok" };
  const next = onboardingEnvironment(original);
  assert.deepEqual(next, { PATH: "/usr/bin", REIN_KLAUD_URL: "http://127.0.0.1:8000", KEEP: "ok" });
  assert.equal(original.REIN_API_KEY, "secret");
});

test("external login opener permits only official device challenges", () => {
  assert.equal(accountVerificationUrl("https://auth.openai.com/codex/device"), "https://auth.openai.com/codex/device");
  assert.equal(accountVerificationUrl("https://github.com/login/device?user_code=ABCD-1234"), "https://github.com/login/device?user_code=ABCD-1234");
  assert.equal(accountVerificationUrl("https://auth.x.ai/device"), "https://auth.x.ai/device");
  for (const value of ["file:///tmp/test", "http://github.com/login/device", "https://github.com.evil.example/login/device", "https://github.com/login/device?redirect=https://evil.example", "https://user:secret@github.com/login/device", "https://auth.openai.com/codex/device#fragment", "https://github.com/logout"]) assert.throws(() => accountVerificationUrl(value), /verification page/);
});
