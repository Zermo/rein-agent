import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "../src/agent/agent-loop.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool } from "../src/ai/types.ts";
import { startKlaudMobileGateway, validateMobileBindHost, validateMobileTrustedOrigin } from "../src/harness/klaud/mobile.ts";
import type { MobileGatewayHandle, MobileGatewayOptions } from "../src/harness/klaud/mobile.ts";
import { mobileAdvertisementCommands, mobileAdvertisementHost } from "../src/harness/klaud/mdns.ts";

const assistant = (): AssistantMessage => ({
	role: "assistant", content: [{ type: "text", text: "fixture" }], provider: "fixture", model: "fixture",
	usage: { input: 0, output: 0, totalTokens: 0 }, stopReason: "stop", timestamp: 0,
});
const delta = (text: string): AssistantMessageEvent => ({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant() });
async function* simpleRun() { yield delta("fixture"); }

async function fixture(t: test.TestContext, options: Partial<MobileGatewayOptions> = {}) {
	const home = mkdtempSync(join(tmpdir(), "rein-klaud-mobile-"));
	const server = await startKlaudMobileGateway({ host: "127.0.0.1", port: 0, home, run: simpleRun, advertise: false, ...options });
	t.after(async () => { await server.close(); rmSync(home, { recursive: true, force: true }); });
	const headers = { Authorization: `Bearer ${server.token}` };
	return {
		...server, home, headers,
		get: (path: string, extra: Record<string, string> = {}) => fetch(server.url + path, { headers: { ...headers, ...extra } }),
		post: (path: string, input: unknown) => fetch(server.url + path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(input) }),
	};
}

interface Envelope { sequence: number; event: Record<string, any>; }

function eventReader(response: Response) {
	assert.equal(response.status, 200);
	const reader = response.body!.getReader(), decoder = new TextDecoder();
	let buffer = "";
	return {
		async next(predicate: (envelope: Envelope) => boolean): Promise<Envelope> {
			while (true) {
				const next = await reader.read();
				assert.equal(next.done, false, "event stream ended before the expected envelope");
				buffer += decoder.decode(next.value, { stream: true });
				let boundary: number;
				while ((boundary = buffer.indexOf("\n\n")) !== -1) {
					const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
					const line = block.split("\n").find(item => item.startsWith("data: "));
					if (!line || block.includes("event: rein.run.done")) continue;
					const envelope = JSON.parse(line.slice(6));
					if (predicate(envelope)) return envelope;
				}
			}
		},
		cancel: () => reader.cancel(),
	};
}

async function waitForStatus(server: { get(path: string): Promise<Response> }, runId: string, status: string | string[]) {
	const accepted = new Set(Array.isArray(status) ? status : [status]);
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const value = await (await server.get(`/v1/mobile/runs/${runId}`)).json();
		if (accepted.has(value.status)) return value;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.fail(`run ${runId} did not reach ${[...accepted].join(" or ")}`);
}

test("mobile bind validation allows private interfaces and refuses wildcard, hostnames, and public addresses", () => {
	for (const host of ["127.0.0.1", "10.40.0.8", "172.20.1.2", "192.168.50.4", "169.254.9.3", "100.100.10.8", "::1", "fd12:3456::8", "fe80::8%en0"]) {
		assert.equal(validateMobileBindHost(host), host);
	}
	assert.equal(validateMobileBindHost("0:0:0:0:0:0:0:1"), "::1");
	for (const host of ["0.0.0.0", "::", "localhost", "8.8.8.8", "203.0.113.10", "2001:4860:4860::8888", "fd12:3456::8%en0", " 127.0.0.1"] ) {
		assert.throws(() => validateMobileBindHost(host), /explicit numeric|only to|scope identifier/);
	}
});

test("scoped IPv6 bind validation preserves one raw zone and rejects malformed delimiters", () => {
	assert.equal(validateMobileBindHost("FE80:0:0:0:0:0:0:8%en-test.0"), "fe80::8%en-test.0");
	assert.equal(validateMobileBindHost("fe80::8%25"), "fe80::8%25", "a numeric zone is not URI-decoded");
	for (const host of ["fe80::8%", "fe80::8%en0%en1", "fe80::8%25en0%25en1", "fe80::8%en/0", "fe80::8%en 0", "fe80::8%en0#", "fe80::8%" + "a".repeat(65), "127.0.0.1%en0", "::1%en0"]) {
		assert.throws(() => validateMobileBindHost(host), /explicit numeric|scope identifier/);
	}
});

test("scoped IPv6 gateway URLs encode the zone delimiter and keep exact Host and Origin allowlists", async t => {
	const host = "fe80::8%en-test.0";
	const listen = Server.prototype.listen;
	// Keep this fixture portable: only replace the OS bind with loopback, then
	// exercise the gateway's real URL formatting and request authentication.
	t.mock.method(Server.prototype, "listen", function (this: Server, ...args: any[]) {
		if (args[1] === host) args[1] = "127.0.0.1";
		return Reflect.apply(listen, this, args);
	});
	const server = await fixture(t, { host: "FE80:0:0:0:0:0:0:8%en-test.0" });
	const port = server.url.slice(server.url.lastIndexOf(":") + 1);
	assert.equal(server.url, `http://[fe80::8%25en-test.0]:${port}`);
	const status = (authority: string, origin = `http://${authority}`) => new Promise<number | undefined>((resolve, reject) => {
		const req = request(`http://127.0.0.1:${port}/v1/mobile/health`, {
			headers: { Host: authority, Origin: origin, Authorization: `Bearer ${server.token}` },
		}, response => { response.resume(); resolve(response.statusCode); });
		req.on("error", reject); req.end();
	});
	const encoded = `[fe80::8%25en-test.0]:${port}`, raw = `[fe80::8%en-test.0]:${port}`;
	assert.equal(await status(encoded), 200);
	assert.equal(await status(raw), 200);
	for (const authority of [`[fe80::8%en-test.0%other]:${port}`, `[fe80::8%2525en-test.0]:${port}`, `[fe80::8%25other]:${port}`, `[fe80::9%25en-test.0]:${port}`]) {
		assert.equal(await status(authority), 403);
		assert.equal(await status(encoded, `http://${authority}`), 403);
	}
});

test("an explicit HTTPS mesh origin is accepted without permitting a public bind", async t => {
	assert.equal(validateMobileTrustedOrigin("https://rein.mesh.example:8443/"), "https://rein.mesh.example:8443");
	for (const value of ["http://rein.mesh.example", "https://*.mesh.example", "https://rein.mesh.example/path", "https://user@rein.mesh.example", "not a url"]) {
		assert.throws(() => validateMobileTrustedOrigin(value), /HTTPS origin/);
	}
	const trustedOrigin = "https://rein.mesh.example:8443", server = await fixture(t, { trustedOrigin });
	const status = (host: string, origin: string) => new Promise<number | undefined>(resolve => {
		const req = request(server.url + "/v1/mobile/health", { headers: { Host: host, Origin: origin, Authorization: `Bearer ${server.token}` } }, response => { response.resume(); resolve(response.statusCode); }); req.end();
	});
	assert.equal(await status("rein.mesh.example:8443", trustedOrigin), 200);
	assert.equal(await status("rein.mesh.example:8443", "https://other.mesh.example"), 403);
	assert.equal((await (await server.get("/v1/mobile")).json()).trustedOrigin, trustedOrigin);
});

test("the versioned gateway authenticates every route and keeps a private reusable device token", async t => {
	const first = await fixture(t);
	assert.equal((await fetch(first.url + "/v1/mobile/health")).status, 401);
	assert.equal((await fetch(first.url + "/v1/mobile/health", { headers: { Authorization: "Bearer wrong" } })).status, 401);
	assert.deepEqual(await (await first.get("/v1/mobile/health")).json(), { ok: true, name: "rein-klaʊd-mobile", apiVersion: "v1" });
	const contract = await (await first.get("/v1/mobile", { Connection: "close" })).json();
	assert.equal(contract.apiVersion, "v1"); assert.ok(contract.capabilities.includes("resumable-events"));
	const advertisedStatus = await new Promise<number | undefined>(resolve => {
		const req = request(first.url + "/v1/mobile/health", { headers: { Host: `${mobileAdvertisementHost("127.0.0.1")}:${new URL(first.url).port}`, Authorization: `Bearer ${first.token}` } }, response => { response.resume(); resolve(response.statusCode); });
		req.end();
	});
	assert.equal(advertisedStatus, 200);
	assert.ok(first.tokenFile); assert.equal(readFileSync(first.tokenFile!, "utf8").trim(), first.token);
	assert.equal(statSync(first.tokenFile!).mode & 0o777, 0o600);
	const port = Number(new URL(first.url).port), token = first.token, file = first.tokenFile!;
	await first.close();
	await new Promise(resolve => setTimeout(resolve, 10));
	const again = await startKlaudMobileGateway({ host: "127.0.0.1", port, home: first.home, run: simpleRun, advertise: false });
	t.after(() => again.close());
	assert.equal(again.token, token); assert.equal(again.tokenFile, file);
	assert.equal((await fetch(again.url + "/v1/mobile/health", { headers: { Authorization: `Bearer ${token}` } })).status, 200);
});

test("mobile discovery advertises the exact Bonjour service contract and closes with the gateway", async t => {
	let published: any, closed = false;
	const server = await fixture(t, { advertise(service) { published = service; return { close() { closed = true; } }; } });
	assert.deepEqual(published, {
		name: "rein-klaʊd", serviceType: "_rein-klaud._tcp", domain: "local", host: "127.0.0.1",
		port: Number(new URL(server.url).port), txt: { path: "/v1/mobile", version: "1" },
	});
	await server.close(); assert.equal(closed, true);
	const [darwin] = mobileAdvertisementCommands(published, "darwin")!;
	assert.equal(darwin.command, "/usr/bin/dns-sd"); assert.equal(darwin.args[0], "-P");
	assert.deepEqual(darwin.args.slice(-3), ["127.0.0.1", "path=/v1/mobile", "version=1"]);
	const label = mobileAdvertisementHost("127.0.0.1");
	assert.deepEqual(mobileAdvertisementCommands(published, "linux"), [
		{ command: "avahi-publish-address", args: ["-f", label, "127.0.0.1"] },
		{ command: "avahi-publish-service", args: ["-f", "-H", label, "rein-klaʊd", "_rein-klaud._tcp", String(published.port), "path=/v1/mobile", "version=1"] },
	]);
	assert.equal(mobileAdvertisementCommands({ ...published, host: "fe80::8%eth0" }, "linux"), undefined);
	assert.equal(mobileAdvertisementCommands(published, "win32"), undefined);
	assert.match(label, /^rein-klaud-[a-f0-9]{8}\.local$/);
});

test("a linked persistent token is refused without reading or replacing its target", async t => {
	const server = await fixture(t), port = Number(new URL(server.url).port), file = server.tokenFile!;
	await server.close(); rmSync(file);
	const target = join(server.home, "do-not-read.txt"); writeFileSync(target, "PRIVATE_TARGET_SENTINEL"); symlinkSync(target, file);
	await assert.rejects(startKlaudMobileGateway({ host: "127.0.0.1", port, home: server.home, run: simpleRun, advertise: false }), /never symlinks/);
	assert.equal(readFileSync(target, "utf8"), "PRIVATE_TARGET_SENTINEL");
});

test("disconnecting a phone does not abort a run; reconnect cursors replay only missed numbered events", async t => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const server = await fixture(t, { run: async function* () { yield delta("before"); await gate; yield delta("after"); } });
	const started = await (await server.post("/v1/mobile/runs", { threadId: "resume-fixture", message: "continue while offline" })).json();
	const first = eventReader(await server.get(started.eventsUrl));
	const seen = await first.next(item => item.event.type === "TEXT_MESSAGE_CONTENT" && item.event.delta === "before");
	await first.cancel();
	release();
	await waitForStatus(server, started.runId, "completed");
	const resumed = eventReader(await server.get(`${started.eventsUrl}?after=${seen.sequence}`));
	const missed = await resumed.next(item => item.event.type === "TEXT_MESSAGE_CONTENT");
	assert.equal(missed.event.delta, "after"); assert.equal(missed.sequence, seen.sequence + 1);
	assert.equal((await server.get(`${started.eventsUrl}?after=${missed.sequence + 100}`)).status, 409);
});

test("a client run id makes an ambiguous run POST idempotent", async t => {
	let executions = 0, release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const server = await fixture(t, { run: async function* () { executions++; await gate; yield delta("done"); } });
	const runId = "4d47ff0e-d50f-46e8-bf85-59e93279f859";
	const input = { runId, threadId: "idempotent-fixture", message: "survive an ambiguous response" };

	const first = await server.post("/v1/mobile/runs", input);
	assert.equal(first.status, 202);
	const firstReceipt = await first.json();
	assert.equal(firstReceipt.runId, runId);
	assert.equal(firstReceipt.statusUrl, `/v1/mobile/runs/${runId}`);

	const repeated = await server.post("/v1/mobile/runs", input);
	assert.equal(repeated.status, 202);
	const repeatedReceipt = await repeated.json();
	assert.equal(repeatedReceipt.runId, runId);
	assert.equal(repeatedReceipt.eventsUrl, firstReceipt.eventsUrl);
	const executionDeadline = Date.now() + 1000;
	while (executions === 0 && Date.now() < executionDeadline) await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(executions, 1);

	assert.equal((await server.post("/v1/mobile/runs", { ...input, message: "different input" })).status, 409);
	assert.equal((await server.post("/v1/mobile/runs", { ...input, runId: "not-a-uuid" })).status, 400);
	release();
	await waitForStatus(server, runId, "completed");
});

test("evicted runs retain bounded receipts so a delayed idempotent retry cannot execute twice", async t => {
	let executions = 0;
	const server = await fixture(t, { run: async function* () { executions++; yield delta("done"); } });
	const ids = Array.from({ length: 65 }, (_, index) => `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
	for (const [index, runId] of ids.entries()) {
		const response = await server.post("/v1/mobile/runs", { runId, threadId: `receipt-${index}`, message: "run once" });
		assert.equal(response.status, 202);
		await waitForStatus(server, runId, "completed");
	}
	assert.equal(executions, 65);

	const retained = await server.get(`/v1/mobile/runs/${ids[0]}`);
	assert.equal(retained.status, 200);
	const snapshot = await retained.json();
	assert.equal(snapshot.status, "completed");
	assert.equal(snapshot.oldestSequence, snapshot.lastSequence + 1);

	const retry = await server.post("/v1/mobile/runs", { runId: ids[0], threadId: "receipt-0", message: "run once" });
	assert.equal(retry.status, 202);
	const receipt = await retry.json();
	assert.equal(receipt.status, "completed");
	const terminal = await server.get(receipt.eventsUrl);
	assert.equal(terminal.status, 200);
	const terminalBody = await terminal.text();
	assert.match(terminalBody, /event: rein\.run\.done/);
	assert.match(terminalBody, /"eventsRetained":false/);
	assert.equal(executions, 65);
	assert.equal((await server.post("/v1/mobile/runs", { runId: ids[0], threadId: "receipt-0", message: "different" })).status, 409);
});

test("pending frontend tools survive disconnect, can be recovered from run state, and resume execution", async t => {
	let result = "";
	const declaration: Tool = { name: "navigateTo", description: "Navigate", parameters: { type: "object", properties: { dest: { type: "string" } } } };
	const server = await fixture(t, { run: async function* (_message, tools) {
		const tool = (tools as AgentTool[]).find(item => item.name === "navigateTo")!;
		result = (await tool.execute("mobile-tool", { dest: "settings" })).content;
		yield delta("resumed");
	} });
	const started = await (await server.post("/v1/mobile/runs", { threadId: "tool-fixture", message: "navigate", tools: [declaration] })).json();
	const stream = eventReader(await server.get(started.eventsUrl));
	const pendingEvent = await stream.next(item => item.event.name === "klaud.frontend_tool");
	await stream.cancel();
	const state = await (await server.get(started.statusUrl)).json();
	assert.equal(state.status, "waiting");
	assert.deepEqual(state.pending, [{ id: "mobile-tool", kind: "tool", tool: "navigateTo", summary: '{"dest":"settings"}', args: { dest: "settings" } }]);
	assert.equal((await server.post(`/v1/mobile/runs/${started.runId}/tools/mobile-tool`, { result: "settings opened" })).status, 200);
	await waitForStatus(server, started.runId, "completed");
	assert.equal(result, "settings opened");
	const replay = eventReader(await server.get(started.eventsUrl, { "Last-Event-ID": String(pendingEvent.sequence) }));
	const resumed = await replay.next(item => item.event.type === "TEXT_MESSAGE_CONTENT");
	assert.equal(resumed.event.delta, "resumed");
});

test("scoped tool results clear the original pending action while the model continues after a lost answer receipt", { timeout: 15_000 }, async t => {
	const home = mkdtempSync(join(tmpdir(), "rein-mobile-scoped-tool-")), workspace = join(home, "work"); mkdirSync(workspace);
	const previous = Object.fromEntries(["REIN_HOME", "REIN_BASE_URL", "REIN_MODEL", "REIN_API"].map(key => [key, process.env[key]]));
	const providerId = "navigation-provider-fixture";
	let release!: () => void, continued!: () => void, requests = 0, droppedReceipts = 0;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const secondRequest = new Promise<void>(resolve => { continued = resolve; });
	const model = createServer(async (req, res) => {
		let raw = ""; for await (const chunk of req) raw += chunk;
		const input = JSON.parse(raw); requests++;
		if (requests === 1) {
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: providerId, type: "function", function: { name: "navigateTo", arguments: '{"dest":"settings"}' } }] }, finish_reason: "tool_calls" }] }));
			return;
		}
		assert.ok(input.messages.some((message: any) => message.role === "tool" && message.tool_call_id === providerId && message.content === "settings opened"));
		continued(); await gate;
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "Navigation finished." }, finish_reason: "stop" }] }));
	});
	await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
	process.env.REIN_HOME = home; process.env.REIN_BASE_URL = baseUrl; process.env.REIN_MODEL = "scoped-tool-fixture"; process.env.REIN_API = "chat-completions";
	writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", model: "scoped-tool-fixture", baseUrl, toolsMode: "native", maxTurns: 4 }), { mode: 0o600 });
	const originalFetch = globalThis.fetch;
	let gateway: MobileGatewayHandle | undefined, events: ReturnType<typeof eventReader> | undefined;
	try {
		gateway = await startKlaudMobileGateway({ host: "127.0.0.1", port: 0, home, cwd: workspace, advertise: false });
		const headers = { Authorization: `Bearer ${gateway.token}` };
		const get = (path: string) => fetch(gateway!.url + path, { headers });
		const post = (path: string, input: unknown) => fetch(gateway!.url + path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(input) });
		// Lose the bridge's successful receipt so POST cannot clear the pending
		// map itself. The real scoped TOOL_CALL_RESULT must reconcile it instead.
		t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (target.endsWith(`/tools/${providerId}`) && !target.startsWith(gateway!.url)) {
				const response = await originalFetch(input, init);
				assert.equal(response.status, 200); await response.arrayBuffer(); droppedReceipts++;
				throw new Error("Fixture lost the receipt after the backend accepted the answer.");
			}
			return originalFetch(input, init);
		});
		const started = await (await post("/v1/mobile/runs", { threadId: "scoped-tool-fixture", message: "Open settings", tools: [{ name: "navigateTo", description: "Navigate", parameters: { type: "object", properties: { dest: { type: "string" } } } }] })).json();
		events = eventReader(await get(started.eventsUrl));
		await events.next(item => item.event.name === "klaud.frontend_tool");
		const pending = await (await get(started.statusUrl)).json();
		assert.equal(pending.status, "waiting"); assert.deepEqual(pending.pending.map((item: any) => item.id), [providerId]);
		assert.equal((await post(`/v1/mobile/runs/${started.runId}/tools/${providerId}`, { result: "settings opened" })).status, 500);
		const result = await events.next(item => item.event.type === "TOOL_CALL_RESULT");
		assert.equal(result.event.providerToolCallId, providerId);
		assert.match(result.event.toolCallId, /^tool-[a-f0-9]{64}$/);
		assert.notEqual(result.event.toolCallId, providerId);
		await secondRequest;
		const continuing = await (await get(started.statusUrl)).json();
		assert.equal(droppedReceipts, 1); assert.equal(requests, 2);
		assert.equal(continuing.status, "running"); assert.deepEqual(continuing.pending, []);
		assert.equal(continuing.completedAt, undefined, "run completion must not be responsible for clearing the action");
		release(); await waitForStatus({ get }, started.runId, "completed");
	} finally {
		release(); await events?.cancel(); await gateway?.close();
		await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(home, { recursive: true, force: true });
	}
});

test("cancellation is independent of the event socket and rejects late pending answers", async t => {
	const declaration: Tool = { name: "navigateTo", description: "Navigate", parameters: { type: "object" } };
	const server = await fixture(t, { run: async function* (_message, tools) {
		await (tools as AgentTool[]).find(item => item.name === "navigateTo")!.execute("cancel-tool", { dest: "bots" });
		yield delta("must not arrive");
	} });
	const started = await (await server.post("/v1/mobile/runs", { threadId: "cancel-fixture", message: "wait", tools: [declaration] })).json();
	const stream = eventReader(await server.get(started.eventsUrl));
	await stream.next(item => item.event.name === "klaud.frontend_tool"); await stream.cancel();
	assert.equal((await server.post(`/v1/mobile/runs/${started.runId}/cancel`, {})).status, 202);
	const state = await waitForStatus(server, started.runId, "cancelled");
	assert.equal(state.error, "Run cancelled."); assert.deepEqual(state.pending, []);
	assert.equal((await server.post(`/v1/mobile/runs/${started.runId}/tools/cancel-tool`, { result: "late" })).status, 404);
});

test("a lost cancel response still reconciles an accepted host cancellation", async t => {
	const declaration: Tool = { name: "navigateTo", description: "Navigate", parameters: { type: "object" } };
	const server = await fixture(t, { run: async function* (_message, tools) {
		await (tools as AgentTool[]).find(item => item.name === "navigateTo")!.execute("ambiguous-cancel-tool", { dest: "bots" });
		yield delta("must not arrive");
	} });
	const originalFetch = globalThis.fetch;
	let droppedResponses = 0;
	globalThis.fetch = async (input, init) => {
		const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (target.endsWith("/cancel") && !target.startsWith(server.url)) {
			const response = await originalFetch(input, init);
			await response.arrayBuffer();
			droppedResponses++;
			throw new Error("simulated response loss after the bridge accepted cancellation");
		}
		return originalFetch(input, init);
	};
	try {
		const started = await (await server.post("/v1/mobile/runs", { threadId: "ambiguous-cancel-fixture", message: "wait", tools: [declaration] })).json();
		await waitForStatus(server, started.runId, "waiting");
		const response = await server.post(`/v1/mobile/runs/${started.runId}/cancel`, {});
		assert.equal(response.status, 502);
		assert.match((await response.json()).error, /outcome is unknown/);
		const state = await waitForStatus(server, started.runId, "cancelled");
		assert.equal(droppedResponses, 1);
		assert.equal(state.error, "Run cancelled.");
	} finally { globalThis.fetch = originalFetch; }
});

test("an ambiguous cancel that never reached the bridge does not mask a later run failure", async t => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const server = await fixture(t, { run: async function* () { yield delta("working"); await gate; throw new Error("provider failed"); } });
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (target.endsWith("/cancel") && !target.startsWith(server.url)) throw new Error("simulated request loss before the bridge");
		return originalFetch(input, init);
	};
	try {
		const started = await (await server.post("/v1/mobile/runs", { threadId: "unreached-cancel-fixture", message: "wait" })).json();
		await waitForStatus(server, started.runId, "running");
		assert.equal((await server.post(`/v1/mobile/runs/${started.runId}/cancel`, {})).status, 502);
		release();
		const state = await waitForStatus(server, started.runId, "failed");
		assert.equal(state.error, "provider failed");
	} finally { globalThis.fetch = originalFetch; release(); }
});

test("mobile admission rejects an overlapping thread and caps active detached runs", async t => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const server = await fixture(t, { run: async function* () { await gate; yield delta("done"); } });
	const first = await server.post("/v1/mobile/runs", { threadId: "active-0", message: "wait" }); assert.equal(first.status, 202);
	assert.equal((await server.post("/v1/mobile/runs", { threadId: "active-0", message: "overlap" })).status, 409);
	for (let index = 1; index < 8; index++) assert.equal((await server.post("/v1/mobile/runs", { threadId: `active-${index}`, message: "wait" })).status, 202);
	assert.equal((await server.post("/v1/mobile/runs", { threadId: "active-8", message: "too many" })).status, 429);
	release();
});

test("native approvals remain recoverable after disconnect and route to the original host run", { timeout: 15_000 }, async t => {
	const home = mkdtempSync(join(tmpdir(), "rein-klaud-mobile-approval-")), workspace = join(home, "work"); mkdirSync(workspace);
	const previous = Object.fromEntries(["REIN_HOME", "REIN_BASE_URL", "REIN_MODEL", "REIN_API"].map(key => [key, process.env[key]]));
	const model = createServer(async (req, res) => {
		let raw = ""; for await (const chunk of req) raw += chunk;
		const input = JSON.parse(raw), hasResult = input.messages.some((message: any) => message.role === "tool");
		const output = hasResult
			? { choices: [{ message: { content: "done" }, finish_reason: "stop" }] }
			: { choices: [{ message: { tool_calls: [{ id: "write-mobile", type: "function", function: { name: "write", arguments: JSON.stringify({ path: join(workspace, "approval.txt"), content: "fixture" }) } }] }, finish_reason: "tool_calls" }] };
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(output));
	});
	await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
	process.env.REIN_HOME = home; process.env.REIN_BASE_URL = baseUrl; process.env.REIN_MODEL = "approval-fixture"; process.env.REIN_API = "chat-completions";
	writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", model: "approval-fixture", baseUrl, toolsMode: "native", maxTurns: 4 }), { mode: 0o600 });
	let gateway: MobileGatewayHandle | undefined;
	try {
		gateway = await startKlaudMobileGateway({ host: "127.0.0.1", port: 0, home, cwd: workspace, token: "approval-fixture-token-1234567890", advertise: false });
		const headers = { Authorization: `Bearer ${gateway.token}` }, post = (path: string, input: unknown) => fetch(gateway!.url + path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(input) });
		const bot = await (await post("/v1/mobile/bots", { name: "Approval fixture" })).json();
		const started = await (await post("/v1/mobile/runs", { botId: bot.id, threadId: bot.sessionId, message: "write" })).json();
		const stream = eventReader(await fetch(gateway.url + started.eventsUrl, { headers }));
		const approval = await stream.next(item => item.event.name === "klaud.approval"); await stream.cancel();
		const pending = await (await fetch(gateway.url + started.statusUrl, { headers })).json();
		assert.equal(pending.status, "waiting"); assert.equal(pending.pending[0].kind, "approval"); assert.equal(pending.pending[0].tool, "write");
		assert.equal((await post(`/v1/mobile/runs/${started.runId}/approvals/${approval.event.value.id}`, { allow: false })).status, 200);
		const deadline = Date.now() + 4000;
		let status: any;
		do { status = await (await fetch(gateway.url + started.statusUrl, { headers })).json(); if (status.status !== "completed") await new Promise(resolve => setTimeout(resolve, 10)); } while (status.status !== "completed" && Date.now() < deadline);
		assert.equal(status.status, "completed"); assert.equal(existsSync(join(workspace, "approval.txt")), false);
	} finally {
		await gateway?.close();
		await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(home, { recursive: true, force: true });
	}
});
