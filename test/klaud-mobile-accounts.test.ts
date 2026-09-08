import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMobileAccounts, mobileDeviceChallenge, MobileAccountError } from "../src/harness/klaud/mobile-accounts.ts";
import { startKlaudMobileGateway } from "../src/harness/klaud/mobile.ts";
import { PROVIDER_PRESETS } from "../src/ai/models.ts";
import { readConfig, saveConfig } from "../src/ai/config.ts";

function fixture(t: test.TestContext, extra: Record<string, unknown> = {}) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "rein-mobile-accounts-")));
	const names = ["REIN_HOME", "REIN_BASE_URL", "REIN_MODEL", "REIN_API", "REIN_API_KEY", ...Object.values(PROVIDER_PRESETS).map(item => item.keyEnv)];
	const previous = new Map(names.map(name => [name, process.env[name]]));
	for (const name of names) delete process.env[name];
	process.env.REIN_HOME = home;
	const executable = join(home, "fake-cli.mjs");
	writeFileSync(executable, `#!${process.execPath}
import {appendFileSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const args = process.argv.slice(2), mode = process.env.FIXTURE_MODE || 'wait';
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({args, cwd:process.cwd(), home:process.env.REIN_HOME, codexHome:process.env.CODEX_HOME, copilotHome:process.env.COPILOT_HOME, grokHome:process.env.GROK_HOME, browser:process.env.BROWSER, apiKey:process.env.OPENAI_API_KEY, githubToken:process.env.GITHUB_TOKEN})+'\\n');
if(args[0] === '--version') {
 if(mode === 'status-stall') { spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:'inherit'}); process.exit(0); }
 process.exit(0);
}
if(args[1] === 'status') process.exit(0);
if(mode === 'overflow') { process.stdout.write('x'.repeat(70000)); setInterval(()=>{}, 1000); }
else if(mode === 'terminal') { process.stderr.write('TTY required. Secret fixture-private-token'); process.exit(1); }
else if(mode === 'no-challenge') { setInterval(()=>{},1000); }
else {
 const url = process.env.GROK_HOME ? 'https://auth.x.ai/device' : process.env.COPILOT_HOME ? 'https://github.com/login/device' : 'https://auth.openai.com/codex/device';
 process.stdout.write('Signing in: '+url.slice(0,12));
 setTimeout(()=> { process.stdout.write(url.slice(12)+'\\nCode: ABCD-EFGH\\nSecret fixture-private-token\\n'); if(mode === 'success') process.exit(0); }, 25);
 if(mode === 'descendant') {
  const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
  writeFileSync(process.env.FIXTURE_PID, String(child.pid));
 }
 setInterval(()=>{},1000);
}
`);
	chmodSync(executable, 0o700);
	const log = join(home, "commands.jsonl"), pid = join(home, "descendant.pid");
	// Normal auth-flow tests allow slow fixture startup. Deadline tests below
	// override these limits explicitly and still check prompt cancellation.
	const accounts = createMobileAccounts({ home, executables: { codex: executable, copilot: executable, grok: executable }, loginTimeoutMs: 20_000, challengeTimeoutMs: 10_000, ...extra, env: { FIXTURE_LOG: log, FIXTURE_PID: pid, OPENAI_API_KEY: "fixture-not-for-cli", GITHUB_TOKEN: "fixture-not-for-cli", ...(extra.env as NodeJS.ProcessEnv ?? {}) } });
	t.after(async () => { await accounts.close(); for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } rmSync(home, { recursive: true, force: true }); });
	return { home, accounts, log, pid, rows: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}
async function waitFor<T>(get: () => T, accept: (value: T) => boolean, timeout = 10_000): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) { const value = get(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
	assert.fail("Fixture did not reach the expected state.");
}
const expectHttp = (status: number) => (error: unknown) => error instanceof MobileAccountError && error.status === status;

test("mobile device challenges only expose official provider URLs and short codes", () => {
	assert.deepEqual(mobileDeviceChallenge("codex", "\x1b[32mhttps://auth.openai.com/codex/device\x1b[0m\nCode: ABCD-EFGH\nsecret-token"), { verificationURL: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" });
	assert.deepEqual(mobileDeviceChallenge("copilot", "https://github.com/login/device?user_code=ABCD-EFGH"), { verificationURL: "https://github.com/login/device?user_code=ABCD-EFGH", userCode: "ABCD-EFGH" });
	assert.deepEqual(mobileDeviceChallenge("grok", "https://auth.x.ai/device/verification-123"), { verificationURL: "https://auth.x.ai/device/verification-123" });
	for (const url of ["https://auth.openai.com.evil.example/codex/device", "https://user:secret@auth.openai.com/codex/device", "https://auth.openai.com/codex/device?access_token=secret", "https://auth.openai.com/codex/device#secret", "https://auth.openai.com/other", "http://auth.openai.com/codex/device", "https://github.com/login/device"]) assert.equal(mobileDeviceChallenge("codex", url).verificationURL, undefined);
	assert.deepEqual(mobileDeviceChallenge("grok", "https://auth.x.ai/device?token=secret\naccess_token=fixture-private-token"), {});
	assert.deepEqual(mobileDeviceChallenge("codex", "PASSWORD\nUNKNOWN1"), {});
});

test("API selection preserves budgets, uses Chat Completions and never returns the key", async t => {
	const f = fixture(t);
	saveConfig({ maxTurns: 400, maxIterations: 100, posthorse: { enabled: true }, provider: "custom", baseUrl: "http://model-a.example:1234/v1", apiKey: "fixture-old-key", sshHost: "fixture-host" });
	const selected = f.accounts.select({ provider: "custom", model: "fixture-model", baseUrl: "http://model-b.example:8000/v1/chat/completions", apiKey: "fixture-new-key" });
	assert.equal(selected.configured.baseUrl, "http://model-b.example:8000/v1");
	assert.equal(selected.configured.apiKeyConfigured, true);
	assert.equal(JSON.stringify(selected).includes("fixture-new-key"), false);
	assert.deepEqual(readConfig(), { provider: "custom", model: "fixture-model", baseUrl: "http://model-b.example:8000/v1", auth: { type: "api-key" }, api: "chat-completions", apiKey: "fixture-new-key", maxTurns: 400, maxIterations: 100, posthorse: { enabled: true } });
	assert.equal(statSync(join(f.home, "config.json")).mode & 0o777, 0o600);
});

test("same-endpoint edits retain the key while changed endpoints and CLI selections clear it", t => {
	const f = fixture(t);
	f.accounts.select({ provider: "custom", model: "fixture", baseUrl: "http://fixture.example:9000/v1", apiKey: "fixture-key" });
	f.accounts.select({ provider: "custom", model: "fixture-2", baseUrl: "http://fixture.example:9000/v1" });
	assert.equal(readConfig().apiKey, "fixture-key");
	f.accounts.select({ provider: "openai", model: "fixture-cloud" });
	assert.equal(readConfig().apiKey, undefined);
	assert.equal(readConfig().baseUrl, "https://api.openai.com/v1");
	f.accounts.select({ provider: "openai", model: "fixture-cloud", apiKey: "fixture-cloud-key" });
	const selected = f.accounts.select({ provider: "codex", model: "default" });
	assert.equal(selected.configured.auth, "cli");
	assert.equal(readConfig().apiKey, undefined); assert.equal(readConfig().api, undefined);
	assert.deepEqual(readConfig().auth, { type: "cli", provider: "codex" });
});

test("invalid provider settings preserve the existing configuration", t => {
	const f = fixture(t); saveConfig({ maxTurns: 200, apiKey: "fixture-private-key" });
	const original = readConfig();
	for (const input of [
		{ provider: "__proto__", model: "fixture" }, { provider: "github", model: "fixture" }, { provider: "custom", model: "fixture", baseUrl: "https://user:key@api.example/v1" },
		{ provider: "custom", model: "fixture", baseUrl: "https://api.example/v1?key=secret" }, { provider: "custom", model: "fixture", baseUrl: "file:///tmp/api" },
		{ provider: "openai", model: "\nfixture" }, { provider: "openai", model: "fixture", apiKey: "key\nother" },
		{ provider: "codex", model: "default", apiKey: "secret" }, { provider: "grok", model: "default", baseUrl: "https://api.x.ai/v1" },
		{ provider: "openai", model: "fixture", command: "fixture-command" },
	]) { assert.throws(() => f.accounts.select(input), expectHttp(400)); assert.deepEqual(readConfig(), original); }
});

test("environment overrides cannot make mobile setup silently ineffective", async t => {
	const f = fixture(t); saveConfig({ provider: "openai", model: "fixture" });
	for (const name of ["REIN_BASE_URL", "REIN_MODEL", "REIN_API", "REIN_API_KEY", "OPENAI_API_KEY"]) {
		process.env[name] = "fixture-environment-value";
		assert.throws(() => f.accounts.select({ provider: "openai", model: "fixture-2", apiKey: "fixture-key" }), expectHttp(409));
		assert.equal(readConfig().model, "fixture");
		delete process.env[name];
	}
	process.env.REIN_MODEL = "fixture-override";
	const accounts = await f.accounts.list();
	assert.deepEqual(accounts.environmentOverrides, ["REIN_MODEL"]);
	assert.equal(JSON.stringify(accounts).includes("fixture-override"), false);
});

test("account status uses only bounded read-only CLI checks and caches repeated requests", async t => {
	// This test checks argv/caching, not process-start latency under a parallel
	// suite. Short timeout and descendant cleanup have separate coverage below.
	const f = fixture(t, { statusTimeoutMs: 10_000 });
	const first = await f.accounts.list(); await f.accounts.list();
	assert.equal(first.subscriptions.length, 3);
	assert.deepEqual(f.rows().map(row => row.args).sort(), [["--version"], ["--version"], ["--version"], ["login", "status"]].sort());
	assert.equal(JSON.stringify(first).includes("fixture-not-for-cli"), false);
});

test("device sign-in is isolated, deduplicated, sanitized, and cancelled as a process group", async t => {
	const f = fixture(t);
	const login = f.accounts.start({ provider: "codex" });
	assert.equal(f.accounts.start({ provider: "codex" }).id, login.id);
	const waiting = await waitFor(() => f.accounts.get(login.id), value => value.status === "waiting");
	assert.equal(waiting.verificationURL, "https://auth.openai.com/codex/device"); assert.equal(waiting.userCode, "ABCD-EFGH");
	assert.equal(JSON.stringify(waiting).includes("fixture-private-token"), false);
	assert.deepEqual(f.rows()[0].args, ["login", "--device-auth"]);
	assert.equal(f.rows()[0].codexHome, join(f.home, "cli-auth", "codex"));
	assert.equal(f.rows()[0].cwd, join(f.home, "cli-auth", "codex"));
	assert.equal(f.rows()[0].browser, "false"); assert.equal(f.rows()[0].apiKey, undefined); assert.equal(f.rows()[0].githubToken, undefined);
	const cancelled = f.accounts.cancel(login.id); assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.userCode, undefined);
	assert.throws(() => f.accounts.start({ provider: "codex" }), expectHttp(409));
	await f.accounts.close();
});

test("all three subscriptions use their official device flags and separate profiles", async t => {
	const f = fixture(t);
	const logins = [f.accounts.start({ provider: "codex" }), f.accounts.start({ provider: "copilot" }), f.accounts.start({ provider: "grok" })];
	await Promise.all(logins.map(login => waitFor(() => f.accounts.get(login.id), value => value.status === "waiting")));
	const rows = f.rows(); assert.equal(rows.length, 3);
	assert.ok(rows.some(row => row.copilotHome === join(f.home, "cli-auth", "copilot") && row.args[1] === "--device-code"));
	assert.ok(rows.some(row => row.grokHome === join(f.home, "cli-auth", "grok") && row.args[1] === "--device-auth"));
});

test("CLI login failure cannot echo stderr, tokens or exception excerpts to mobile", async t => {
	const f = fixture(t, { env: { FIXTURE_MODE: "terminal" } });
	const login = f.accounts.start({ provider: "copilot" });
	const failed = await waitFor(() => f.accounts.get(login.id), value => value.status === "failed");
	assert.equal(JSON.stringify(failed).includes("fixture-private-token"), false);
	assert.match(failed.message, /terminal on the gateway/);
});

test("missing CLI installation reports only an actionable official installation command", async t => {
	const f = fixture(t, { executables: { codex: "/fixture-missing-cli" } });
	const login = f.accounts.start({ provider: "codex" });
	const failed = await waitFor(() => f.accounts.get(login.id), value => value.status === "failed");
	assert.match(failed.message, /npm install -g @openai\/codex/); assert.equal(failed.message.includes("fixture-missing-cli"), false);
});

test("device challenges expire and gateway shutdown reaps active login children", async t => {
	const f = fixture(t, { loginTimeoutMs: 150 });
	const login = f.accounts.start({ provider: "codex" });
	const expired = await waitFor(() => f.accounts.get(login.id), value => value.status === "expired", 2500);
	assert.equal(expired.verificationURL, undefined); assert.equal(expired.userCode, undefined);
	await f.accounts.close();
	assert.throws(() => f.accounts.get(login.id), expectHttp(503));
});

test("mobile account routes share gateway bearer checks and only alter next-run configuration", async t => {
	const f = fixture(t);
	const server = await startKlaudMobileGateway({ host: "127.0.0.1", port: 0, home: f.home, advertise: false, run: async function* () {} });
	t.after(() => server.close());
	const route = server.url + "/v1/mobile/accounts/provider", input = JSON.stringify({ provider: "custom", model: "fixture", baseUrl: "http://model.example:8000/v1", apiKey: "fixture-route-key" });
	assert.equal((await fetch(route, { method: "PUT", headers: { "Content-Type": "application/json" }, body: input })).status, 401);
	assert.deepEqual(readConfig(), {});
	const response = await fetch(route, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: input });
	assert.equal(response.status, 200); assert.equal((await response.text()).includes("fixture-route-key"), false);
	assert.equal(readConfig().apiKey, "fixture-route-key");
	const invalid = await fetch(server.url + "/v1/mobile/accounts/logins", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify({ provider: "fixture-command" }) });
	assert.equal(invalid.status, 400);
	assert.equal((await fetch(server.url + "/v1/mobile/accounts/logins/0000", { headers: { Authorization: `Bearer ${server.token}` } })).status, 404);
	await server.close();
});

test("a terminal-only hanging CLI fails promptly without waiting out the device deadline", async t => {
	const f = fixture(t, { env: { FIXTURE_MODE: "no-challenge" }, challengeTimeoutMs: 200 });
	const login = f.accounts.start({ provider: "codex" });
	const failed = await waitFor(() => f.accounts.get(login.id), value => value.status === "failed", 2500);
	assert.match(failed.message, /supported device challenge/);
	await f.accounts.close();
});

test("unbounded CLI output is stopped with a fixed sanitized error", async t => {
	const f = fixture(t, { env: { FIXTURE_MODE: "overflow" } });
	const login = f.accounts.start({ provider: "codex" });
	const failed = await waitFor(() => f.accounts.get(login.id), value => value.status === "failed");
	assert.match(failed.message, /output limit|unsupported response/); assert.ok(JSON.stringify(failed).length < 500);
	await f.accounts.close();
});

test("successful official login does not switch the configured provider implicitly", async t => {
	const f = fixture(t, { env: { FIXTURE_MODE: "success" } });
	saveConfig({ provider: "custom", model: "fixture", baseUrl: "http://model.example:8000/v1" });
	const login = f.accounts.start({ provider: "codex" });
	const result = await waitFor(() => f.accounts.get(login.id), value => value.status === "succeeded");
	assert.equal(result.verificationURL, undefined); assert.equal(result.userCode, undefined);
	assert.equal(readConfig().provider, "custom");
});

test("cancellation kills a TERM-resistant descendant after its parent exits", { skip: process.platform === "win32" }, async t => {
	const f = fixture(t, { env: { FIXTURE_MODE: "descendant" } });
	const login = f.accounts.start({ provider: "codex" });
	await waitFor(() => f.accounts.get(login.id), value => value.status === "waiting");
	const pid = Number(readFileSync(f.pid, "utf8"));
	process.kill(pid, 0);
	f.accounts.cancel(login.id); await f.accounts.close();
	await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, value => value, 2500);
});

test("account setup refuses a configuration home that differs from the live runner", t => {
	const f = fixture(t);
	const other = createMobileAccounts({ home: join(f.home, "other") });
	assert.throws(() => other.select({ provider: "codex", model: "default" }), expectHttp(409));
	assert.throws(() => other.start({ provider: "codex" }), expectHttp(409));
	assert.deepEqual(readConfig(), {});
});

test("status probes remain bounded when CLI descendants keep stdout open", { skip: process.platform === "win32" }, async t => {
	const f = fixture(t, { env: { FIXTURE_MODE: "status-stall" }, statusTimeoutMs: 500 });
	const started = Date.now();
	const result = await f.accounts.list();
	assert.ok(Date.now() - started < 5000);
	assert.equal(result.subscriptions.length, 3);
	assert.equal(result.subscriptions.every((item: any) => item.available === false), true);
	await f.accounts.close();
});
