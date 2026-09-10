import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, saveConfig } from "../src/ai/config.ts";
import { readKlaudSetup, saveKlaudSetup, probeKlaudModel, discoverKlaudModels } from "../src/harness/klaud/setup.ts";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_TURNS } from "../src/harness/run-budgets.ts";
import { OPERATOR_FILES, readOperatorProfile } from "../src/harness/operator-profile.ts";
import { startKlaudServe } from "../src/harness/klaud/serve.ts";
import { createBot } from "../src/harness/klaud/bots.ts";
import { sessionPath } from "../src/agent/session.ts";
import { createServer } from "node:http";

test("GUI discovery includes the saved model endpoint at its nonstandard port", async t => {
  fixture(t);
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer fixture-discovery-key") { res.writeHead(401); res.end(); return; }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "saved-model" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  saveConfig({ provider: "custom", model: "saved-model", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, apiKey: "fixture-discovery-key" });
  const result = await discoverKlaudModels({ network: false });
  assert.ok(result.servers.some(server => server.source === "configured" && server.models.includes("saved-model")));
  assert.doesNotMatch(JSON.stringify(result), /fixture-discovery-key/);
});

function fixture(t: test.TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "rein-klaud-setup-"))), home = join(root, "rein-home");
	const names = ["REIN_HOME", "REIN_MODEL", "REIN_BASE_URL", "REIN_API", "REIN_API_KEY"];
	const original = new Map(names.map(name => [name, process.env[name]]));
	for (const name of names) delete process.env[name];
	process.env.REIN_HOME = home;
	t.after(() => { for (const [name, value] of original) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } rmSync(root, { recursive: true, force: true }); });
	return { root, home };
}
const answers = { q1: "d", q2: "e", q3: "b", q4: "a", q5: "b", q6: "d", q7: "b" };
const privateConfig = { provider: "custom", model: "fixture-model", baseUrl: "https://models.example.net/v1", apiKey: "fixture-private-api-key", auth: { type: "api-key", accessToken: "fixture-private-access-token" }, sshHost: "fixture-private-alias", maxTurns: 400, maxIterations: 40, posthorse: { enabled: true } };
function assertPublic(value: unknown) {
	const json = JSON.stringify(value);
	for (const secret of [privateConfig.apiKey, privateConfig.auth.accessToken, privateConfig.sshHost, "fixture-private-document", "fixture-private-broken-profile"]) assert.equal(json.includes(secret), false);
}

test("fresh setup reads useful defaults and fixed work-style choices without creating files", t => {
	const f = fixture(t), setup = readKlaudSetup(f.home);
	assert.deepEqual(setup.budgets, { maxTurns: DEFAULT_MAX_TURNS, maxIterations: DEFAULT_MAX_ITERATIONS });
	assert.equal(setup.profile, null); assert.equal(setup.profileNeedsReview, false);
	assert.ok(setup.items.some(item => item.id === "q2" && item.choices.some(choice => choice.id === "e")));
	assert.ok(setup.packs.everyday); assert.match(setup.fingerprint, /^[a-f0-9]{64}$/);
	assert.equal(existsSync(f.home), false);
	assert.deepEqual(readKlaudSetup(f.home), setup);
});

test("setup omits credentials and unmanaged notes while preserving existing configuration", t => {
	const f = fixture(t); saveConfig(privateConfig);
	writeFileSync(join(f.home, "USER.md"), "fixture-private-document\n");
	const before = readFileSync(join(f.home, "config.json"));
	assertPublic(readKlaudSetup(f.home)); assert.deepEqual(readFileSync(join(f.home, "config.json")), before);
	const result = saveKlaudSetup({ budgets: { maxTurns: 900 } }, f.home);
	assert.deepEqual(result.budgets, { maxTurns: 900, maxIterations: 40 }); assertPublic(result);
	assert.deepEqual(readConfig(), { ...privateConfig, maxTurns: 900 });
	assert.equal(readFileSync(join(f.home, "USER.md"), "utf8"), "fixture-private-document\n");
});

test("guided profile and task budgets persist together and can skip suggested skills", t => {
	const f = fixture(t); saveConfig(privateConfig);
	const first = readKlaudSetup(f.home);
	const saved = saveKlaudSetup({ answers, enabledPack: "everyday", fingerprint: first.fingerprint, budgets: { maxTurns: 1200, maxIterations: 80 } }, f.home);
	assert.equal(saved.profile?.enabled_pack, "everyday");
	assert.equal(saved.profile?.operator_profile.focus, "everyday");
	assert.equal(saved.profile?.preferences.pacing, "small-steps");
	assert.deepEqual(saved.budgets, { maxTurns: 1200, maxIterations: 80 });
	assert.notEqual(saved.fingerprint, first.fingerprint);
	for (const name of OPERATOR_FILES) assert.equal(existsSync(join(f.home, name)), true);
	assert.deepEqual(readOperatorProfile(f.home).profile, saved.profile); assertPublic(saved);
	const skipped = saveKlaudSetup({ answers, enabledPack: null, fingerprint: saved.fingerprint }, f.home);
	assert.equal(skipped.profile?.enabled_pack, null); assert.deepEqual(skipped.profile?.enabled_skills, []);
	assert.deepEqual(skipped.budgets, saved.budgets); assert.equal(readConfig().apiKey, privateConfig.apiKey);
});

test("invalid setup submissions fail before changing configuration or operator files", t => {
	const f = fixture(t); saveConfig(privateConfig);
	const before = readFileSync(join(f.home, "config.json")), fingerprint = readKlaudSetup(f.home).fingerprint;
	const invalid: Record<string, unknown>[] = [
		{ apiKey: "fixture-rejected-key" }, { budgets: [] }, { budgets: null }, { budgets: { maxTokens: 100 } },
		{ budgets: { maxTurns: 0 } }, { budgets: { maxTurns: 10001 } }, { budgets: { maxTurns: "300" } },
		{ budgets: { maxIterations: 0 } }, { budgets: { maxIterations: 1001 } }, { budgets: { maxIterations: 1.5 } },
		{ answers }, { answers: [] }, { answers: { ...answers, q2: "missing" }, fingerprint },
		{ answers, enabledPack: "hermes-agent", fingerprint }, { answers: { ...answers, unknown: "a" }, fingerprint },
		{ answers, enabledPack: "everyday", fingerprint, budgets: { maxTurns: -1 } },
	];
	for (const input of invalid) {
		assert.throws(() => saveKlaudSetup(input, f.home));
		assert.deepEqual(readFileSync(join(f.home, "config.json")), before);
		for (const name of OPERATOR_FILES) assert.equal(existsSync(join(f.home, name)), false);
	}
});

test("stale profile preview prevents both profile replacement and budget changes", t => {
	const f = fixture(t); saveConfig(privateConfig);
	const fingerprint = readKlaudSetup(f.home).fingerprint;
	writeFileSync(join(f.home, "SOUL.md"), "Operator edited this after the preview.\n");
	assert.throws(() => saveKlaudSetup({ answers, fingerprint, budgets: { maxTurns: 900 } }, f.home), /changed after the preview/);
	assert.equal(readFileSync(join(f.home, "SOUL.md"), "utf8"), "Operator edited this after the preview.\n");
	assert.deepEqual(readConfig(), privateConfig);
	assert.equal(existsSync(join(f.home, "profile.yaml")), false);
});

test("broken profiles are flagged without exposing their contents or overwriting them", t => {
	const f = fixture(t); mkdirSync(f.home);
	const invalid = "fixture-private-broken-profile: not a valid profile\n";
	writeFileSync(join(f.home, "profile.yaml"), invalid);
	const result = readKlaudSetup(f.home);
	assert.equal(result.profileNeedsReview, true); assert.equal(result.profile, null); assertPublic(result);
	assert.equal(readFileSync(join(f.home, "profile.yaml"), "utf8"), invalid);
});

test("foreign homes fail closed and unconfigured or CLI checks do not probe a network", async t => {
	const f = fixture(t), other = join(f.root, "not-this-gateway");
	assert.throws(() => readKlaudSetup(other), /configuration directory/);
	assert.throws(() => saveKlaudSetup({ budgets: { maxTurns: 900 } }, other), /configuration directory/);
	await assert.rejects(probeKlaudModel(other), /configuration directory/);
	await assert.rejects(probeKlaudModel(f.home), /Save a model connection/);
	assert.equal(existsSync(f.home), false); assert.equal(existsSync(other), false);
	saveConfig({ ...privateConfig, provider: "codex", auth: { type: "cli", provider: "codex" } });
	assert.deepEqual(await probeKlaudModel(f.home), { status: "cli", models: [], message: "Subscription access is managed by the official CLI. Check its sign-in status below." });
	for (const input of [{ network: "yes" }, { network: null }, { hosts: ["not-scanned.example"] }]) await assert.rejects(discoverKlaudModels(input), /known network peers/);
});

test("setup and account routes enforce authentication and origin before any action", async t => {
	const f = fixture(t);
	const server = await startKlaudServe({ home: f.home, run: async function* () {} });
	try {
		const routes = [["GET", "/setup"], ["POST", "/setup"], ["POST", "/setup/probe"], ["POST", "/setup/discover"], ["POST", "/setup/hardware"], ["GET", "/accounts"], ["PUT", "/accounts/provider"], ["POST", "/accounts/logins"], ["PATCH", "/bots/klaud-bot-aaaaaaaa"]];
		const existing = readdirSync(join(f.home, "klaud"));
		for (const [method, path] of routes) {
			const headers = { "Content-Type": "application/json" }, body = method === "GET" ? undefined : "{}";
			assert.equal((await fetch(server.url + path, { method, headers, body })).status, 401);
			assert.equal((await fetch(server.url + path, { method, headers: { ...headers, Authorization: `Bearer ${server.token}`, Origin: "https://other.example" }, body })).status, 403);
		}
		assert.equal(existsSync(join(f.home, "config.json")), false);
		assert.deepEqual(readdirSync(join(f.home, "klaud")), existing);
	} finally { await server.close(); }
});

test("authenticated setup and avatar routes reject malformed requests and preserve session identity", async t => {
	const f = fixture(t); saveConfig(privateConfig);
	const bot = createBot("Sample bot", f.home), transcript = readFileSync(sessionPath(bot.sessionId, f.home));
	const server = await startKlaudServe({ home: f.home, run: async function* () {} });
	const headers = { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` };
	const request = (path: string, method: string, body: unknown) => fetch(server.url + path, { method, headers, body: JSON.stringify(body) });
	try {
		const setup = await (await fetch(server.url + "/setup", { headers })).json(); assertPublic(setup);
		for (const body of [null, [], { budgets: { maxTurns: 0 } }, { apiKey: "fixture-rejected-key" }]) assert.equal((await request("/setup", "POST", body)).status, 400);
		const saved = await request("/setup", "POST", { budgets: { maxTurns: 700, maxIterations: 60 } });
		assert.equal(saved.status, 200); assertPublic(await saved.json());
		for (const body of [{}, { avatar: "blob" }, { avatar: null }, { avatar: "builder", sessionId: "replacement" }, { name: "Replacement" }]) assert.equal((await request(`/bots/${bot.id}`, "PATCH", body)).status, 400);
		const update = await request(`/bots/${bot.id}`, "PATCH", { avatar: "builder" });
		assert.equal(update.status, 200); assert.deepEqual(await update.json(), { ...bot, avatar: "builder" });
		assert.deepEqual(readFileSync(sessionPath(bot.sessionId, f.home)), transcript);
		const state = await (await fetch(server.url + "/state", { headers })).json();
		assert.equal(state.bots[0].avatar, "builder"); assert.equal(state.bots[0].sessionId, bot.sessionId);
		assert.deepEqual(readConfig(), { ...privateConfig, maxTurns: 700, maxIterations: 60 });
	} finally { await server.close(); }
});
