import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createRunner, type RunnerOptions } from "../src/harness/runner.ts";
import { createSession, loadSession } from "../src/agent/session.ts";
import { decideToolMode } from "../src/ai/compat.ts";

const user = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const defaults: RunnerOptions = { cwd: process.cwd(), modelOverride: "runner-fixture", baseUrlOverride: "http://fixture.invalid/v1", systemPrompt: "Test harness", maxTurns: 6 };
const reply = (content = "done") => Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
const call = (name: string, args: object = {}) => Response.json({ choices: [{ message: { tool_calls: [{ id: "call-fixture", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] });

async function isolated(fn: (directory: string) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "rein-runner-"));
	const prior = process.env.REIN_HOME;
	process.env.REIN_HOME = directory;
	try { await fn(directory); } finally {
		if (prior === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = prior;
		rmSync(directory, { recursive: true, force: true });
	}
}

test("default runner registers context tools and {} status calls keep native mode", async (t) => isolated(async () => {
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => requests++ === 0 ? call("get_context_remaining") : reply());
	const runner = await createRunner(defaults);
	for (const name of ["new_context", "get_context_remaining", "notes", "history", "bash"]) assert.ok(runner.tools.some(tool => tool.name === name));
	const messages = await runner.run(user("check status"));
	assert.equal(runner.toolsMode, "native");
	assert.ok(messages.some(m => m.role === "toolResult" && !m.isError && m.toolName === "get_context_remaining"));
	assert.equal(requests, 2);
}));

test("skill loading leaves the system prefix unchanged and returns reference bodies only on demand", async (t) => isolated(async () => {
	const bodies: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(init.body as string));
		return bodies.length === 1 ? call("skill", { name: "tdd", file: "tests.md" }) : reply();
	});
	const runner = await createRunner(defaults);
	const prefix = runner.systemPrompt;
	const messages = await runner.run(user("inspect the test workflow"));
	assert.equal(runner.systemPrompt, prefix);
	assert.equal(bodies[0].messages[0].content, bodies[1].messages[0].content);
	assert.ok(messages.some(m => m.role === "toolResult" && m.toolName === "skill" && !m.isError));
	const empty = await createRunner({ ...defaults, tools: [] });
	assert.doesNotMatch(empty.systemPrompt, /Bundled workflows/);
}));

test("{} new_context persists a boundary, removes old replay, and survives resume/followup", async (t) => isolated(async () => {
	const bodies: any[] = [];
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		bodies.push(JSON.parse(raw));
		const response = bodies.length === 1 ? call("new_context") : reply();
		res.writeHead(response.status, { "content-type": "application/json" });
		res.end(await response.text());
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
	const baseUrlOverride = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
	const id = createSession({ cwd: process.cwd() });
	const runner = await createRunner({ ...defaults, baseUrlOverride, sessionId: id });
	const messages = await runner.run(user("OLD REQUEST SENTINEL"));
	assert.equal(messages.length, 4);
	assert.equal(runner.toolsMode, "native");
	assert.equal(bodies.length, 2);
	assert.doesNotMatch(JSON.stringify(bodies[1].messages), /OLD REQUEST SENTINEL/);
	assert.ok(bodies[1].messages.every((message: any) => !message.tool_calls && message.role !== "tool"));
	const saved = loadSession(id);
	assert.equal(saved.messages.length, 4);
	assert.equal(saved.window?.start, 3);
	assert.equal(saved.window?.reason, "tool");
	const resumed = await createRunner({ ...defaults, baseUrlOverride, sessionId: id });
	await resumed.run(user("FOLLOWUP SENTINEL"));
	assert.doesNotMatch(JSON.stringify(bodies[2].messages), /OLD REQUEST SENTINEL/);
	assert.match(JSON.stringify(bodies[2].messages), /FOLLOWUP SENTINEL/);
	assert.equal(loadSession(id).messages.length, 6);
}));

test("forced native survives malformed tool arguments without runtime fallback", async (t) => isolated(async () => {
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => requests++ === 0 ? call("read") : reply());
	const runner = await createRunner({ ...defaults, toolsMode: "native" });
	const messages = await runner.run(user("try read"));
	assert.equal(runner.toolsMode, "native");
	assert.equal(runner.toolsModeSource, "forced");
	assert.ok(messages.some(m => m.role === "toolResult" && m.isError));
	assert.equal(decideToolMode("custom", "runner-fixture").mode, "native");
}));

test("custom empty toolset remains empty, disables auto context, and supports small windows", async (t) => isolated(async () => {
	let body: any;
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { body = JSON.parse(init.body as string); return reply(); });
	const runner = await createRunner({ ...defaults, tools: [], contextWindow: 2048, autoContext: false });
	assert.deepEqual(runner.tools, []);
	assert.equal(JSON.parse(runner.contextStatus()).automatic, false);
	assert.equal(runner.model.maxTokens, 512);
	await runner.run(user("hello"));
	assert.equal(body.tools, undefined);
	assert.equal(body.max_tokens, 512);
}));

test("explicit output budget is retained and invalid oversized output config errors clearly", async (t) => isolated(async directory => {
	writeFileSync(join(directory, "config.json"), JSON.stringify({ maxTokens: 256 }));
	let body: any;
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { body = JSON.parse(init.body as string); return reply(); });
	const runner = await createRunner({ ...defaults, tools: [], contextWindow: 2048 });
	await runner.run(user("hello"));
	assert.equal(body.max_tokens, 256);
	writeFileSync(join(directory, "config.json"), JSON.stringify({ maxTokens: 4096 }));
	await assert.rejects(createRunner({ ...defaults, tools: [], contextWindow: 2048 }), /maxTokens.*smaller than contextWindow/);
}));

test("auto-context opt out is reflected in prompt and status", async () => isolated(async () => {
	const runner = await createRunner({ ...defaults, autoContext: false });
	assert.equal(JSON.parse(runner.contextStatus()).automatic, false);
	assert.match(runner.systemPrompt, /Automatic rollover is disabled/);
	assert.doesNotMatch(runner.systemPrompt, /Automatic rollover starts/);
}));

test("threshold rollover preserves new input, bounds replay, and keeps full saved history", async (t) => isolated(async () => {
	const bodies: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(init.body as string));
		return reply(bodies.length === 1 ? "OLD_OUTPUT_SENTINEL".repeat(4000) : "done");
	});
	const id = createSession({ cwd: process.cwd() });
	const runner = await createRunner({ ...defaults, sessionId: id, contextWindow: 16000 });
	await runner.run(user("original goal"));
	await runner.run(user("EXACT NEW INPUT"));
	assert.equal(loadSession(id).window?.reason, "threshold");
	assert.equal(bodies[1].messages.at(-1).content, "EXACT NEW INPUT");
	assert.doesNotMatch(JSON.stringify(bodies[1].messages), /OLD_OUTPUT_SENTINEL/);
	assert.equal(loadSession(id).messages.length, 4);
	assert.equal(JSON.parse(runner.contextStatus()).windowId, loadSession(id).window?.id);
}));

test("provider overflow retries one fresh window and never resends failed assistant content", async (t) => isolated(async () => {
	const bodies: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(init.body as string));
		if (bodies.length === 2) return Response.json({ error: { message: "context_length_exceeded: maximum context reached" } }, { status: 400 });
		return reply();
	});
	const id = createSession({ cwd: process.cwd() });
	const runner = await createRunner({ ...defaults, sessionId: id });
	await runner.run(user("old goal"));
	await runner.run(user("current goal"));
	assert.equal(bodies.length, 3);
	assert.equal(loadSession(id).window?.reason, "overflow");
	assert.equal(bodies[2].messages.at(-1).content, "current goal");
	assert.doesNotMatch(JSON.stringify(bodies[2].messages), /context_length_exceeded/);
	assert.equal(loadSession(id).messages.filter(m => m.role === "assistant" && m.stopReason === "error").length, 1);
}));

test("automatic tool fallback still activates for missing required arguments", async (t) => isolated(async () => {
	const bodies: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(init.body as string));
		return bodies.length === 1 ? call("read") : reply();
	});
	const runner = await createRunner({ ...defaults, toolsMode: "auto" });
	await runner.run(user("read a file"));
	assert.equal(runner.toolsMode, "text");
	assert.equal(runner.toolsModeSource, "runtime");
	assert.ok(bodies[0].tools);
	assert.equal(bodies[1].tools, undefined);
	assert.ok(bodies[1].messages.every((m: any) => !m.tool_calls && m.role !== "tool"));
	assert.equal(decideToolMode("custom", "runner-fixture").mode, "text");
}));

test("known explicit endpoint selects its provider API key", async (t) => isolated(async () => {
	const prior = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "fixture-openai-key";
	try {
		let headers: any;
		t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { headers = init.headers; return reply(); });
		const runner = await createRunner({ ...defaults, tools: [], baseUrlOverride: "https://api.openai.com/v1" });
		await runner.run(user("hello"));
		assert.equal(runner.model.provider, "openai");
		assert.equal(headers.Authorization, "Bearer fixture-openai-key");
	} finally { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; }
}));

test("config context controls apply and explicit runner settings take precedence", async () => isolated(async directory => {
	writeFileSync(join(directory, "config.json"), JSON.stringify({ contextWindow: 8000, posthorse: { enabled: false, reserveTokens: 1024 } }));
	const configured = await createRunner(defaults);
	assert.equal(configured.model.contextWindow, 8000);
	assert.equal(configured.model.maxTokens, 1024);
	assert.equal(JSON.parse(configured.contextStatus()).automatic, false);
	assert.equal(JSON.parse(configured.contextStatus()).reserveTokens, 1024);
	const overridden = await createRunner({ ...defaults, contextWindow: 16000, reserveTokens: 2048, autoContext: true });
	assert.equal(overridden.model.contextWindow, 16000);
	assert.equal(overridden.model.maxTokens, 2048);
	assert.equal(JSON.parse(overridden.contextStatus()).automatic, true);
	assert.equal(JSON.parse(overridden.contextStatus()).reserveTokens, 2048);
}));

test("nodeterm approval timeout denies by default and only runs after local fallback approval", async (t) => isolated(async directory => {
	const nodetermKeys = ["NODETERM_NODE_ID", "NODETERM_HOOK_PORT", "NODETERM_HOOK_SOCK", "NODETERM_PENDING_DIR", "NODETERM_PERM_WAIT_SECS", "NODETERM_NODE_TOKEN_DIR"];
	const previous = new Map(nodetermKeys.map(key => [key, process.env[key]]));
	const hook = createServer((req, res) => { req.resume(); res.writeHead(204); res.end(); });
	await new Promise<void>(resolve => hook.listen(0, "127.0.0.1", resolve));
	let requestCount = 0;
	t.mock.method(globalThis, "fetch", async () => requestCount++ % 2 === 0 ? call("guarded") : reply());
	try {
		for (const key of nodetermKeys) delete process.env[key];
		process.env.NODETERM_NODE_ID = "runner-test-node";
		process.env.NODETERM_HOOK_PORT = String((hook.address() as { port: number }).port);
		process.env.NODETERM_PENDING_DIR = join(directory, "pending");
		process.env.NODETERM_PERM_WAIT_SECS = "1";
		let executions = 0;
		let fallbackCalls = 0;
		const tools = [{ name: "guarded", description: "fixture action", parameters: { type: "object" }, execute: async () => { executions++; return { content: "executed" }; } }];
		const denied = await createRunner({ ...defaults, tools, askTools: ["guarded"] });
		const deniedMessages = await denied.run(user("perform guarded action"));
		assert.equal(executions, 0);
		assert.ok(deniedMessages.some(message => message.role === "toolResult" && message.isError && /Denied/.test(message.content[0].text)));
		const allowed = await createRunner({ ...defaults, tools, askTools: ["guarded"], askFallback: async (name) => { fallbackCalls++; assert.equal(name, "guarded"); return true; } });
		await allowed.run(user("perform guarded action"));
		assert.equal(fallbackCalls, 1);
		assert.equal(executions, 1);
	} finally {
		for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await new Promise<void>((resolve, reject) => hook.close(error => error ? reject(error) : resolve()));
	}
}));
