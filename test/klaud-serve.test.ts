import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { startKlaudServe } from "../src/harness/klaud/serve.ts";
import type { ServeOptions } from "../src/harness/klaud/serve.ts";
import type { AgentTool } from "../src/agent/agent-loop.ts";
import type { AssistantMessage, AssistantMessageEvent, Tool } from "../src/ai/types.ts";

const partial = (stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
	role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "ok" }],
	provider: "fixture", model: "fixture", usage: { input: 0, output: 0, totalTokens: 0 }, stopReason, timestamp: 0,
});
const delta = (text = "ok"): AssistantMessageEvent => ({ type: "text_delta", contentIndex: 0, delta: text, partial: partial() });
async function* simpleRun() { yield delta(); }
const frontend: Tool = { name: "navigateTo", description: "Navigate", parameters: { type: "object", properties: { dest: { type: "string" } } } };
async function fixture(t: test.TestContext, opts: ServeOptions = {}) {
	const home = mkdtempSync(join(tmpdir(), "rein-klaud-serve-"));
	const server = await startKlaudServe({ home, run: simpleRun, ...opts });
	t.after(async () => { await server.close(); rmSync(home, { recursive: true, force: true }); });
	const headers = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
	return { ...server, home, headers, get: (path: string) => fetch(server.url + path, { headers }),
		post: (path: string, body: unknown) => fetch(server.url + path, { method: "POST", headers, body: JSON.stringify(body) }) };
}
function parseEvents(body: string): Record<string, any>[] {
	return body.split("\n\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));
}
async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>, predicate: (event: any) => boolean) {
	let buffer = "";
	while (true) {
		const chunk = await reader.read();
		assert.equal(chunk.done, false);
		buffer += new TextDecoder().decode(chunk.value);
		let index: number;
		while ((index = buffer.indexOf("\n\n")) !== -1) {
			const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
			if (line.startsWith("data: ") && line !== "data: [DONE]") {
				const event = JSON.parse(line.slice(6));
				if (predicate(event)) return event;
			}
		}
	}
}

test("health is public; state needs bearer auth; generated token is private and removed on close", async t => {
	const server = await fixture(t);
	assert.deepEqual(await (await fetch(server.url + "/health")).json(), { ok: true, name: "rein-klaud" });
	assert.equal((await fetch(server.url + "/state")).status, 401);
	assert.equal((await fetch(server.url + "/state", { headers: { Authorization: "Bearer wrong" } })).status, 401);
	const state = await (await server.get("/state")).json();
	assert.equal(state.shell.version, 1);
	assert.deepEqual(state.bots, []);
	assert.match(server.token, /^[a-f0-9]{48}$/);
	const path = join(server.home, "klaud", `serve-${new URL(server.url).port}.token`);
	assert.equal(readFileSync(path, "utf8").trim(), server.token);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	await server.close();
	assert.ok(!readdirSync(join(server.home, "klaud")).some(name => name.endsWith(".token")));
});

test("strict Host and Origin checks also protect health", async t => {
	const server = await fixture(t);
	for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { Host: "localhost:" + new URL(server.url).port }]) {
		const status = await new Promise(resolve => {
			const req = request(server.url + "/health", { headers }, res => { res.resume(); resolve(res.statusCode); });
			req.end();
		});
		assert.equal(status, 403);
	}
	assert.equal((await fetch(server.url + "/health", { headers: { Origin: server.url } })).status, 200);
});

test("state patches are atomic, persisted, and limited to shell paths", async t => {
	const server = await fixture(t);
	assert.equal((await server.post("/state", { patch: [{ op: "replace", path: "/chrome/tray", value: "quiet" }] })).status, 200);
	assert.equal((await (await server.get("/state")).json()).shell.chrome.tray, "quiet");
	assert.equal((await server.post("/state", { patch: [{ op: "replace", path: "/theme/dark", value: false }, { op: "test", path: "/chrome/tray", value: "hidden" }] })).status, 400);
	assert.equal((await (await server.get("/state")).json()).shell.theme.dark, true);
	assert.equal((await server.post("/state", { patch: [{ op: "replace", path: "/bots", value: [] }] })).status, 400);
});

test("invalid and oversized request bodies fail before run starts", async t => {
	const server = await fixture(t);
	for (const body of ["{", "null", "[]"]) assert.equal((await fetch(server.url + "/run", { method: "POST", headers: server.headers, body })).status, 400);
	assert.equal((await server.post("/run", { threadId: "t", message: "x".repeat(300_000) })).status, 413);
	for (const body of [{ threadId: "", message: "hi" }, { threadId: "t", message: 42 }, { threadId: "t", message: "hi", tools: [frontend, frontend] }, { threadId: "t", message: "hi", tools: [{ ...frontend, name: "bash" }] }]) {
		assert.equal((await server.post("/run", body)).status, 400);
	}
	assert.equal((await server.get("/bots")).status, 200);
	assert.equal((await server.post("/bots", { name: "" })).status, 400);
});

test("SSE sends snapshot, content, exactly one whole-run finish, and DONE without reasoning", async t => {
	const server = await fixture(t, { run: async function* () {
		yield { type: "thinking_delta", contentIndex: 0, delta: "private reasoning", partial: partial() };
		yield delta();
		yield { type: "done", reason: "toolUse", message: partial("toolUse") };
		yield delta("continued");
		yield { type: "done", reason: "stop", message: partial() };
	} });
	const res = await server.post("/run", { threadId: "test", message: "hello" });
	assert.match(res.headers.get("content-type")!, /text\/event-stream/);
	const body = await res.text(), events = parseEvents(body);
	assert.equal(events[0].type, "RUN_STARTED");
	assert.ok(events.some(e => e.type === "STATE_SNAPSHOT"));
	const texts = events.filter(e => e.type === "TEXT_MESSAGE_CONTENT");
	assert.deepEqual(texts.map(e => e.delta), ["ok", "continued"]);
	assert.notEqual(texts[0].messageId, texts[1].messageId);
	assert.equal(events.filter(e => e.type === "RUN_FINISHED").length, 1);
	assert.equal(events.at(-1)!.type, "RUN_FINISHED");
	assert.deepEqual(events.at(-1)!.outcome, { type: "success" });
	assert.ok(body.endsWith("data: [DONE]\n\n"));
	assert.ok(!body.includes("private reasoning"));
});

test("terminal failures don't emit success and recovered model errors can finish", async t => {
	const error: AssistantMessageEvent = { type: "error", reason: "error", error: { ...partial("error"), errorMessage: "fixture failed" } };
	for (const recover of [false, true]) {
		const server = await fixture(t, { run: async function* () { yield error; if (recover) { yield delta(); yield { type: "done", reason: "stop", message: partial() }; } } });
		const events = parseEvents(await (await server.post("/run", { threadId: "t", message: "hi" })).text());
		assert.equal(events.filter(e => e.type === "RUN_ERROR").length, recover ? 0 : 1);
		assert.equal(events.filter(e => e.type === "RUN_FINISHED").length, recover ? 1 : 0);
	}
});

test("frontend tools wait for an authenticated result and are scoped to one run", async t => {
	let calls = 0;
	const server = await fixture(t, { run: async function* (_msg, tools) {
		if (++calls === 1) {
			const tool = (tools as AgentTool[]).find(tool => tool.name === "navigateTo")!;
			const result = await tool.execute("call-1", { dest: "settings" });
			assert.equal(result.content, "navigated");
		} else assert.ok(!tools!.some(tool => tool.name === "navigateTo"));
		yield delta();
	} });
	const response = await server.post("/run", { threadId: "one", message: "hi", tools: [frontend] });
	const reader = response.body!.getReader();
	const event = await nextEvent(reader, e => e.type === "CUSTOM" && e.name === "klaud.frontend_tool");
	const path = `/runs/${event.value.runId}/tools/call-1`;
	assert.equal((await fetch(server.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"result":"bad"}' })).status, 401);
	assert.equal((await server.post(path, { result: "navigated" })).status, 200);
	while (!(await reader.read()).done) {}
	assert.equal((await server.post(path, { result: "duplicate" })).status, 404);
	assert.equal((await server.post("/run", { threadId: "two", message: "hi" })).status, 200);
});

test("cancellation rejects pending frontend work and prevents overlapping thread runs", async t => {
	let settled = false;
	const server = await fixture(t, { run: async function* (_msg, tools) {
		try { await (tools as AgentTool[]).find(tool => tool.name === "navigateTo")!.execute("pending", { dest: "bots" }); }
		finally { settled = true; }
		yield delta("must not arrive");
	} });
	const response = await server.post("/run", { threadId: "same", message: "hi", tools: [frontend] });
	const reader = response.body!.getReader();
	const event = await nextEvent(reader, e => e.type === "CUSTOM" && e.name === "klaud.frontend_tool");
	assert.equal((await server.post("/run", { threadId: "same", message: "overlap" })).status, 409);
	assert.equal((await server.post(`/runs/${event.value.runId}/cancel`, {})).status, 200);
	let body = "";
	while (true) { const value = await reader.read(); if (value.done) break; body += new TextDecoder().decode(value.value); }
	assert.ok(settled);
	assert.ok(!body.includes("must not arrive"));
	assert.ok(body.includes("RUN_ERROR"));
	assert.equal((await server.post(`/runs/${event.value.runId}/tools/pending`, { result: "late" })).status, 404);
});

test("disconnect and close cancel pending tools without hanging", async t => {
	let finished!: () => void;
	const completion = new Promise<void>(resolve => { finished = resolve; });
	const server = await fixture(t, { run: async function* (_msg, tools) {
		try { await (tools as AgentTool[]).find(tool => tool.name === "navigateTo")!.execute("pending", { dest: "bots" }); }
		finally { finished(); }
	} });
	const response = await server.post("/run", { threadId: "t", message: "hi", tools: [frontend] });
	const reader = response.body!.getReader();
	await nextEvent(reader, e => e.type === "CUSTOM");
	await reader.cancel();
	await completion;
	await server.close();
});

test("production refuses a foreign home before model resolution and never changes environment", async t => {
	const home = mkdtempSync(join(tmpdir(), "rein-klaud-foreign-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const previous = process.env.REIN_HOME;
	await assert.rejects(startKlaudServe({ home }), /REIN_HOME.*before/i);
	assert.equal(process.env.REIN_HOME, previous);
});


test("setPref persists across server restart and emits the new shared snapshot", async t => {
	const prefTool: Tool = { name: "setPref", description: "Set preference", parameters: { type: "object" } };
	let botId: string;
	const server = await fixture(t, { run: async function* (_msg, tools) {
		await (tools as AgentTool[]).find(tool => tool.name === "setPref")!.execute("pref", { key: "lastBotId", value: botId });
		yield delta();
	} });
	botId = (await (await server.post("/bots", { name: "Fixture" })).json()).id;
	const response = await server.post("/run", { threadId: "prefs", message: "set preference", tools: [prefTool] });
	const reader = response.body!.getReader();
	const event = await nextEvent(reader, e => e.type === "CUSTOM");
	assert.equal((await server.post(`/runs/${event.value.runId}/tools/pref`, { result: "saved" })).status, 200);
	await nextEvent(reader, e => e.type === "STATE_SNAPSHOT" && e.snapshot.prefs.lastBotId === botId);
	while (!(await reader.read()).done) {}
	assert.equal(statSync(join(server.home, "klaud", "prefs.json")).mode & 0o777, 0o600);
	await server.close();
	const resumed = await startKlaudServe({ home: server.home, run: simpleRun });
	t.after(() => resumed.close());
	const state = await (await fetch(resumed.url + "/state", { headers: { Authorization: `Bearer ${resumed.token}` } })).json();
	assert.equal(state.prefs.lastBotId, botId);
});

test("backend shell tool changes emit shared-document deltas", async t => {
	const server = await fixture(t, { run: async function* (_msg, tools) {
		const tool = (tools as AgentTool[]).find(tool => tool.name === "klaud_patch_shell")!;
		const result = await tool.execute("patch", { patch: [{ op: "replace", path: "/theme/dark", value: false }] });
		assert.notEqual(result.isError, true);
		yield delta();
	} });
	const events = parseEvents(await (await server.post("/run", { threadId: "shell", message: "change" })).text());
	assert.deepEqual(events.find(e => e.type === "STATE_DELTA")!.delta, [{ op: "replace", path: "/shell/theme/dark", value: false }]);
	assert.equal((await (await server.get("/state")).json()).shell.theme.dark, false);
});

test("provided tokens are usable and symlink token files are refused without touching their target", async t => {
	const server = await fixture(t, { token: "fixture-token" });
	assert.equal((await server.get("/state")).status, 200);
	assert.equal(server.token, "fixture-token");
	const generated = await fixture(t);
	const port = Number(new URL(generated.url).port);
	await generated.close();
	const target = join(generated.home, "preserve.txt");
	writeFileSync(target, "preserve");
	symlinkSync(target, join(generated.home, "klaud", `serve-${port}.token`));
	await assert.rejects(startKlaudServe({ home: generated.home, port, run: simpleRun }), /symlink/);
	assert.equal(readFileSync(target, "utf8"), "preserve");
});

test("frontend failures and invalid arguments do not change preferences", async t => {
	let botId: string;
	const server = await fixture(t, { run: async function* (_msg, tools) {
		const tool = (tools as AgentTool[]).find(tool => tool.name === "setPref")!;
		await assert.rejects(tool.execute("invalid", { key: "unexpected", value: "x" }), /lastBotId/);
		await assert.rejects(tool.execute("missing", { key: "lastBotId", value: "klaud-bot-ffffffff" }), /No such bot/);
		const result = await tool.execute("denied", { key: "lastBotId", value: botId });
		assert.equal(result.isError, true);
		yield delta();
	} });
	botId = (await (await server.post("/bots", { name: "Fixture" })).json()).id;
	const response = await server.post("/run", { threadId: "denied", message: "hi", tools: [{ name: "setPref", description: "Pref", parameters: { type: "object" } }] });
	const reader = response.body!.getReader();
	const event = await nextEvent(reader, e => e.type === "CUSTOM");
	assert.equal((await server.post(`/runs/${event.value.runId}/tools/denied`, { result: "denied", isError: true })).status, 200);
	while (!(await reader.read()).done) {}
	assert.deepEqual((await (await server.get("/state")).json()).prefs, {});
});

test("a thrown run and truncated output emit RUN_ERROR without RUN_FINISHED", async t => {
	for (const run of [async function* () { throw new Error("fixture exception"); }, async function* () { yield { type: "done", reason: "length", message: partial("length") } as AssistantMessageEvent; }]) {
		const server = await fixture(t, { run });
		const events = parseEvents(await (await server.post("/run", { threadId: "failure", message: "hi" })).text());
		assert.equal(events.filter(e => e.type === "RUN_ERROR").length, 1);
		assert.ok(!events.some(e => e.type === "RUN_FINISHED"));
	}
});
