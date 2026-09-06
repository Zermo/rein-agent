import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARDIAN_LIMITS, GUARDIAN_MODEL, configureGuardian, defaultGuardianConfig, guardianBaseUrl, guardianFilter, guardianPlan, guardianStatus, guardianOwnsRuntime, guardianPortAvailable, guardianRuntimeEnvironment, installGuardianModel, localGuardianRequest, readGuardianConfig, runGuardianInstallCommand, runGuardianServer, setupGuardian, type GuardianDependencies, type GuardianRequest } from "../src/harness/autonomy/guardian.ts";
import { acquireLock, autonomyDirectory, readState, setPlannerMode, updateState } from "../src/harness/autonomy/state.ts";
import { ruleProposals } from "../src/harness/autonomy/rules.ts";
import { servicePlan } from "../src/harness/autonomy/service.ts";
import { runAutonomyCommand } from "../src/harness/autonomy/command.ts";
import type { HardwareProfile } from "../src/hardware/profile.ts";
import type { AutonomyEvidence } from "../src/harness/autonomy/history.ts";

function fixture(t: { after: (fn: () => void) => void }) {
	const directory = mkdtempSync(join(tmpdir(), "rein-guardian-test-")), original = process.env.REIN_HOME;
	process.env.REIN_HOME = directory;
	t.after(() => { if (original === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = original; rmSync(directory, { recursive: true, force: true }); });
	return directory;
}
const GiB = 2 ** 30;
const hardware = (available = 12, os = "linux"): HardwareProfile => ({ os, arch: "x64", cpu: { name: "Synthetic CPU", cores: 4, physicalCores: 2, features: [] }, ram: { totalBytes: 16 * GiB, availableBytes: available * GiB }, gpus: [], unifiedMemory: false });
const tags = () => ({ models: [{ name: GUARDIAN_MODEL.tag, digest: GUARDIAN_MODEL.digest }] });
const evidence = (user = "Please review my weekly planning routine every week."): AutonomyEvidence => ({ digest: "fixture", text: "fixture", sources: [{ id: "user-1", sessionId: "session-1", workspace: "/synthetic/work", timestamp: 100, role: "user", excerpt: user }] });
const candidates = () => ruleProposals(evidence());
const signal = () => new AbortController().signal;
const offline: GuardianRequest = async () => { throw new Error("offline fixture"); };
const deps: GuardianDependencies = { profile: async () => hardware(), findRuntime: () => undefined, request: offline, ownedRuntime: () => false, portAvailable: async () => true, installRuntime: async () => { throw new Error("Unapproved runtime download"); } };
const owned = { ownedRuntime: () => true };

test("rules default is ready without keys, network, or model discovery", async t => {
	fixture(t); let requests = 0;
	assert.deepEqual(readGuardianConfig(), defaultGuardianConfig());
	const status = await guardianStatus({}, { request: async () => { requests++; throw new Error(); } });
	assert.equal(status.ready, true); assert.equal(status.mode, "rules"); assert.equal(requests, 0);
	assert.equal((await guardianFilter(candidates(), signal(), { request: async () => { requests++; throw new Error(); } })).inference, false);
	assert.equal(requests, 0);
});
test("guardian endpoint is credential-free literal loopback and isolated from main config", t => {
	const home = fixture(t);
	writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "cloud-fixture", apiKey: "private_fixture_value", baseUrl: "https://cloud.invalid/v1" }));
	const before = readFileSync(join(home, "config.json"), "utf8");
	assert.equal(guardianBaseUrl("http://localhost:11434/"), "http://127.0.0.1:11434");
	assert.equal(guardianBaseUrl("http://[::1]:11434"), "http://[::1]:11434");
	for (const url of ["https://api.example.invalid", "http://10.0.0.4:11434", "http://user:secret@127.0.0.1", "http://127.0.0.1/v1", "http://127.0.0.1?api_key=x", "http://localhost.invalid"]) assert.throws(() => guardianBaseUrl(url));
	configureGuardian({ mode: "local" });
	assert.equal(statSync(join(autonomyDirectory(), "guardian.json")).mode & 0o777, 0o600);
	assert.equal(readFileSync(join(home, "config.json"), "utf8"), before);
});
test("hardware plan is an estimate with useful unsupported and memory fallback", () => {
	assert.equal(guardianPlan(hardware()).readyForLocal, true);
	assert.equal(guardianPlan(hardware(0.5)).readyForLocal, false);
	assert.equal(guardianPlan(hardware(12, "unsupported")).readyForLocal, false);
	assert.match(guardianPlan(hardware()).description, /No quality benchmark/);
	assert.equal(guardianPlan(hardware()).limits.contextTokens, 2048);
});
test("local triage has one bounded tool-free call and cannot create or approve tasks", async t => {
	fixture(t); configureGuardian({ mode: "local" });
	const expected = candidates(); let calls = 0;
	const result = await guardianFilter(expected, signal(), { ...owned, request: async (url, path, opts) => {
		calls++; assert.equal(url, "http://127.0.0.1:11435");
		if (path === "/api/tags") return tags();
		assert.equal(path, "/api/chat"); const body = opts!.body as any;
		assert.equal(body.model, GUARDIAN_MODEL.tag); assert.equal(body.tools, undefined); assert.equal(body.think, false);
		assert.equal(body.stream, false); assert.equal(body.keep_alive, "30s"); assert.equal(opts!.timeoutMs, 20_000);
		assert.equal(body.options.num_predict, 192); assert.equal(body.options.num_ctx, 2048); assert.equal(body.options.num_thread, 2);
		assert.ok(body.messages[1].content.length <= GUARDIAN_LIMITS.maxInputChars);
		return { done: true, done_reason: "stop", message: { role: "assistant", content: JSON.stringify({ keep: [expected[0].id] }) } };
	} });
	assert.deepEqual(result.keep, [expected[0].id]); assert.equal(result.inference, true); assert.equal(calls, 2);
	assert.equal(readState().proposals.length, 0);
});
test("missing, changed and cloud-backed local aliases never reach inference", async t => {
	fixture(t); configureGuardian({ mode: "local" });
	for (const inventory of [{ models: [] }, { models: [{ name: GUARDIAN_MODEL.tag, digest: "modified" }] }, { models: [{ ...tags().models[0], remote_host: "cloud.invalid" }] }]) {
		let calls = 0;
		const result = await guardianFilter(candidates(), signal(), { ...owned, request: async (_url, path) => { calls++; assert.equal(path, "/api/tags"); return inventory; } });
		assert.equal(result.inference, false); assert.equal(calls, 1); assert.deepEqual(result.keep, candidates().map(c => c.id));
	}
});
test("invalid selection, incomplete and tool replies fall back to rules without execution", async t => {
	fixture(t); configureGuardian({ mode: "local" });
	for (const response of [
		{ done: true, done_reason: "stop", message: { role: "assistant", content: '{"keep":["new-task"]}' } },
		{ done: true, done_reason: "length", message: { role: "assistant", content: '{"keep":[]}' } },
		{ done: true, done_reason: "stop", message: { role: "assistant", content: '{"keep":[]}', tool_calls: [{ name: "bash" }] } },
		{ done: true, done_reason: "stop", message: { role: "assistant", content: '{"keep":[],"execute":"bash"}' } },
	]) {
		const result = await guardianFilter(candidates(), signal(), { ...owned, request: async (_u, p) => p === "/api/tags" ? tags() : response });
		assert.deepEqual(result.keep, candidates().map(c => c.id)); assert.match(result.detail, /rules-only/);
	}
});
test("guardian is serialized and cancellation releases its lock", async t => {
	fixture(t); configureGuardian({ mode: "local" }); const unlock = acquireLock("guardian")!;
	assert.equal((await guardianFilter(candidates(), signal(), { request: offline })).inference, false); unlock();
	const controller = new AbortController();
	await assert.rejects(guardianFilter(candidates(), controller.signal, { ...owned, request: async () => { controller.abort(); throw new Error("canceled fixture"); } }));
	const next = acquireLock("guardian"); assert.ok(next); next!();
});
test("setup verifies before enabling and preserves configuration on failed verification", async t => {
	fixture(t); configureGuardian({ mode: "rules" });
	await assert.rejects(setupGuardian({}, { ...owned, request: async () => ({ models: [] }) }), /explicit model download/);
	assert.equal(readGuardianConfig().mode, "rules");
	await setupGuardian({}, { ...owned, request: async () => tags() }); assert.equal(readGuardianConfig().mode, "local");
});
test("install starts only an owned worker and requires explicit binary download permission", async t => {
	fixture(t);
	assert.equal((await installGuardianModel({}, deps)).installed, false);
	assert.equal((await installGuardianModel({ installRuntime: true }, { ...deps, profile: async () => hardware(0.1) })).installed, false);
	let starts = 0;
	const idle = { ...deps, findRuntime: () => "/synthetic/ollama", startRuntime: async () => { starts++; return false; } };
	await installGuardianModel({}, idle); assert.equal(starts, 1);
	await installGuardianModel({ startRuntime: true }, idle); assert.equal(starts, 2); assert.equal(readGuardianConfig().mode, "rules");
});
test("canceling discovery never installs, starts a runtime or enables the model", async t => {
	fixture(t); const controller = new AbortController(); let starts = 0;
	await assert.rejects(installGuardianModel({ startRuntime: true, signal: controller.signal }, { ...deps, ...owned, findRuntime: () => "/synthetic/ollama", request: async () => { controller.abort(); throw new Error("canceled fixture"); }, startRuntime: async () => { starts++; return true; } }));
	assert.equal(starts, 0); assert.equal(readGuardianConfig().mode, "rules");
	await assert.rejects(guardianStatus({ probe: true, signal: controller.signal }, deps));
});
test("explicit install downloads only the pinned local model and preserves conflicting tags", async t => {
	fixture(t); let pulled = false;
	const request: GuardianRequest = async (_url, path, opts) => {
		if (path === "/api/tags") return pulled ? tags() : { models: [] };
		assert.equal(path, "/api/pull"); assert.deepEqual(opts!.body, { model: GUARDIAN_MODEL.tag, stream: true }); pulled = true; return { status: "success" };
	};
	assert.equal((await installGuardianModel({}, { ...deps, ...owned, request })).installed, true);
	assert.equal(readGuardianConfig().mode, "local");
	configureGuardian({ mode: "rules" });
	await assert.rejects(installGuardianModel({}, { ...deps, ...owned, request: async (_url, path) => { assert.equal(path, "/api/tags"); return { models: [{ name: GUARDIAN_MODEL.tag, digest: "user-customized" }] }; } }), /It was preserved/);
	assert.equal(readGuardianConfig().mode, "rules");
});
test("install uses a custom loopback endpoint and commits it only after verified success", async t => {
	fixture(t); const url = "http://127.0.0.1:12456";
	assert.equal((await installGuardianModel({ baseUrl: url }, deps)).installed, false);
	assert.equal(readGuardianConfig().baseUrl, defaultGuardianConfig().baseUrl);
	await installGuardianModel({ baseUrl: url }, { ...deps, ...owned, request: async base => { assert.equal(base, url); return tags(); } });
	assert.equal(readGuardianConfig().baseUrl, url);
});
test("unowned servers are never contacted or adopted, even at the helper port", async t => {
	fixture(t); configureGuardian({ mode: "local" }); let requests = 0, starts = 0, downloads = 0;
	const unrelated = { ...deps, request: async () => { requests++; return tags(); }, portAvailable: async () => false, startRuntime: async () => { starts++; return true; }, installRuntime: async () => { downloads++; return "/synthetic/ollama"; } };
	assert.equal((await guardianStatus({ probe: true }, unrelated)).localReady, false);
	assert.equal((await guardianFilter(candidates(), signal(), unrelated)).inference, false);
	await assert.rejects(installGuardianModel({ installRuntime: true }, unrelated), /occupied.*unrelated/);
	assert.equal(requests, 0); assert.equal(starts, 0); assert.equal(downloads, 0);
});
test("helper install starts a private worker before downloading and verifies ownership", async t => {
	fixture(t); let running = false, pulled = false; const actions: string[] = [];
	const result = await installGuardianModel({ installRuntime: true }, { ...deps,
		ownedRuntime: () => running,
		installRuntime: async () => { actions.push("private-runtime"); return "/synthetic/headless/ollama"; },
		startRuntime: async executable => { assert.equal(executable, "/synthetic/headless/ollama"); actions.push("owned-service"); running = true; return true; },
		request: async (_url, path) => { assert.equal(running, true); if (path === "/api/pull") { actions.push("model"); pulled = true; return { status: "success" }; } return pulled ? tags() : { models: [] }; },
	});
	assert.equal(result.installed, true); assert.deepEqual(actions, ["private-runtime", "owned-service", "model"]);
});
test("failed or canceled setup stops only the worker it just started", async t => {
	fixture(t);
	for (const cancel of [false, true]) {
		let running = false, stops = 0; const controller = new AbortController();
		await assert.rejects(installGuardianModel({ signal: controller.signal }, { ...deps,
			findRuntime: () => "/synthetic/ollama", ownedRuntime: () => running,
			startRuntime: async () => { running = true; return true; }, stopRuntime: async () => { stops++; running = false; },
			request: async (_url, path) => { if (path === "/api/pull") { if (cancel) controller.abort(); throw new Error("Fixture download failed"); } return { models: [] }; },
		}));
		assert.equal(stops, 1); assert.equal(running, false); assert.equal(readGuardianConfig().mode, "rules");
	}
	let stops = 0;
	await assert.rejects(installGuardianModel({}, { ...deps, ...owned, stopRuntime: async () => { stops++; }, request: async (_url, path) => { if (path === "/api/pull") throw new Error("Fixture download failed"); return { models: [] }; } }));
	assert.equal(stops, 0, "preexisting worker must survive failed download");
});
test("changing an active worker endpoint is refused before installation or mutation", async t => {
	fixture(t); configureGuardian({ mode: "local", baseUrl: "http://127.0.0.1:12456" });
	await assert.rejects(installGuardianModel({ baseUrl: "http://127.0.0.1:12457", installRuntime: true }, { ...deps, activeRuntimeBaseUrl: () => "http://127.0.0.1:12456" }), /disable before changing/);
	assert.equal(readGuardianConfig().baseUrl, "http://127.0.0.1:12456");
});
test("ownership requires a matching private worker record and active named service", t => {
	fixture(t); configureGuardian({ mode: "local" });
	const url = readGuardianConfig().baseUrl;
	const active = () => ({ manager: "launchd" as const, path: "/synthetic/guardian.plist", installed: true, active: true, message: "fixture" });
	assert.equal(guardianOwnsRuntime(url, active), false);
	writeFileSync(join(autonomyDirectory(), "guardian-runtime.json"), JSON.stringify({ version: 1, kind: "rein-headless-guardian", executable: "/synthetic/ollama", baseUrl: url }));
	assert.equal(guardianOwnsRuntime(url, active), true);
	assert.equal(guardianOwnsRuntime("http://127.0.0.1:12456", active), false);
	assert.equal(guardianOwnsRuntime(url, () => ({ ...active(), active: false })), false);
});
test("headless worker environment has private storage and no primary account or desktop settings", t => {
	const home = fixture(t);
	const env = guardianRuntimeEnvironment(defaultGuardianConfig().baseUrl, { HOME: "/synthetic/operator-home", PATH: "/synthetic/bin", REIN_API_KEY: "fixture-secret", OPENAI_API_KEY: "fixture-secret", OLLAMA_MODELS: "/synthetic/main-models", OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_API_KEY: "fixture-secret", HTTPS_PROXY: "http://fixture.invalid", CUDA_VISIBLE_DEVICES: "1" });
	assert.equal(env.HOME, join(home, "autonomy", "guardian-home")); assert.equal(env.OLLAMA_MODELS, join(home, "autonomy", "guardian-models"));
	assert.equal(env.OLLAMA_HOST, "127.0.0.1:11435"); assert.equal(env.OLLAMA_NO_CLOUD, "1"); assert.equal(env.CUDA_VISIBLE_DEVICES, "1");
	assert.ok(!JSON.stringify(env).includes("fixture-secret")); assert.equal(env.HTTPS_PROXY, undefined); assert.equal(env.DISPLAY, undefined);
});
test("owned worker launches only serve and never an app or chat command", async t => {
	if (process.platform === "win32") return t.skip("Unix executable fixture");
	const home = fixture(t); configureGuardian({ mode: "rules" });
	const output = join(home, "started.json"), executable = join(home, "fake-runtime");
	writeFileSync(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,host:process.env.OLLAMA_HOST}));setInterval(()=>{},1000);\n`); chmodSync(executable, 0o700);
	const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as any).port; await new Promise<void>(resolve => server.close(() => resolve()));
	const baseUrl = `http://127.0.0.1:${port}`;
	assert.equal(await guardianPortAvailable(baseUrl), true);
	writeFileSync(join(autonomyDirectory(), "guardian-runtime.json"), JSON.stringify({ version: 1, kind: "rein-headless-guardian", executable, baseUrl }));
	const controller = new AbortController(), task = runGuardianServer(controller.signal);
	try { for (let attempt = 0; attempt < 100 && !existsSync(output); attempt++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(existsSync(output)); }
	finally { controller.abort(); await task; }
	const captured = JSON.parse(readFileSync(output, "utf8")); assert.deepEqual(captured.args, ["serve"]); assert.equal(captured.host, `127.0.0.1:${port}`); assert.equal(captured.home, join(home, "autonomy", "guardian-home"));
});
test("guardian runtime service has distinct identity and cannot replace the supervisor", t => {
	const home = fixture(t); const options = { home, userHome: home, cliPath: "/synthetic/rein.js", nodePath: "/synthetic/node", platform: "darwin" as const };
	const supervisor = servicePlan(options), guardian = servicePlan({ ...options, kind: "guardian" });
	assert.notEqual(supervisor.path, guardian.path); assert.match(guardian.path, /dev\.rein\.guardian/);
	assert.match(guardian.content, /<string>guardian<\/string>/); assert.match(guardian.content, /<string>serve<\/string>/);
	assert.match(supervisor.content, /<string>daemon<\/string>/); assert.ok(!guardian.content.includes("API_KEY"));
});
test("guardian disable preserves explicit main planner selection", async t => {
	fixture(t); configureGuardian({ mode: "local" }); await setPlannerMode("main");
	await runAutonomyCommand(["guardian", "disable"], {}, { stopGuardian: () => ({ manager: "foreground", path: "", installed: false, active: false, message: "No owned service" }) });
	assert.equal(readGuardianConfig().mode, "rules"); assert.equal(readState().planner, "main");
});
test("rules use explicit user requests, recent cancellation and prior decisions", () => {
	assert.equal(ruleProposals(evidence()).length, 1);
	assert.equal(ruleProposals(evidence("This review is not finished; remind me next time.")).length, 1);
	assert.equal(ruleProposals(evidence("Hello, what is the weather?")).length, 0);
	const source = evidence(); source.sources.push({ ...source.sources[0], id: "new", timestamp: 200, excerpt: "Cancel that recurring review." }); assert.equal(ruleProposals(source).length, 0);
	const assistant = evidence(); assistant.sources[0].role = "assistant"; assert.equal(ruleProposals(assistant).length, 0);
	const candidate = candidates()[0]; assert.equal(ruleProposals(evidence(), [{ ...candidate, status: "dismissed", created: 0, allowWrites: false }]).length, 0);
});
test("local transport refuses redirects and closes the rejected connection", { timeout: 10_000 }, async () => {
	const sockets = new Set<any>();
	let connectionClosed!: () => void;
	const closed = new Promise<void>(resolve => { connectionClosed = resolve; });
	const server = createServer((_req, res) => { res.writeHead(302, { location: "https://cloud.invalid" }); res.flushHeaders(); });
	server.on("connection", socket => { sockets.add(socket); socket.on("close", () => { sockets.delete(socket); connectionClosed(); }); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address() as { port: number };
		// Test redirect rejection, not a 50 ms scheduling deadline on a loaded CI
		// worker. The response deliberately never ends, so close must be client-driven.
		await assert.rejects(localGuardianRequest(`http://127.0.0.1:${address.port}`, "/api/tags", { timeoutMs: 5000 }), /HTTP 302/);
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { closeTimer = setTimeout(() => reject(new Error("Rejected redirect connection did not close.")), 2000); })]); }
		finally { clearTimeout(closeTimer); }
		assert.equal(sockets.size, 0);
	} finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("installer cancellation escalates even when owned child ignores TERM", async t => {
	if (process.platform === "win32") return t.skip("Unix process-group semantics");
	const controller = new AbortController();
	const task = runGuardianInstallCommand(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { signal: controller.signal, timeoutMs: 10_000 });
	setTimeout(() => controller.abort(), 100);
	const start = Date.now(); await assert.rejects(task, /cancelled/); assert.ok(Date.now() - start < 3000);
});
