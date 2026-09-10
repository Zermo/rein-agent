import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startKlaudServe } from "../src/harness/klaud/serve.ts";
import { appendMessage, loadSession, sessionPath } from "../src/agent/session.ts";
import { DEFAULT_KLAUD_SHELL } from "../src/harness/klaud/shell.ts";
import { klaudPrompt } from "../src/harness/klaud/prompt.ts";

const answer = (text = "Fixture answer") => ({ choices: [{ message: { content: text, reasoning_content: "PRIVATE_THINKING_SENTINEL" }, finish_reason: "stop" }] });
const call = (name: string, args: object, id = "fixture-call") => ({ choices: [{ message: { tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] });
const events = (body: string) => body.split("\n\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));

async function fixture(t: test.TestContext, respond: (body: any, count: number) => object = () => answer()) {
	const home = mkdtempSync(join(tmpdir(), "rein-klaud-integrate-")), workspace = join(home, "work");
	mkdirSync(workspace);
	const previous = Object.fromEntries(["REIN_HOME", "REIN_BASE_URL", "REIN_MODEL", "REIN_API"].map(key => [key, process.env[key]]));
	const requests: any[] = [];
	const model = createServer(async (req, res) => {
		try {
			let raw = ""; for await (const chunk of req) raw += chunk;
			const body = JSON.parse(raw); requests.push(body);
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(respond(body, requests.length)));
		} catch { res.writeHead(500).end(); }
	});
	await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
	process.env.REIN_HOME = home; process.env.REIN_BASE_URL = baseUrl; process.env.REIN_MODEL = "integration-fixture"; process.env.REIN_API = "chat-completions";
	writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", model: "integration-fixture", baseUrl, toolsMode: "native", maxTurns: 6 }), { mode: 0o600 });
	let server = await startKlaudServe({ home, cwd: workspace });
	t.after(async () => {
		await server.close();
		await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(home, { recursive: true, force: true });
	});
	return {
		home, workspace, requests,
		get server() { return server; },
		get: (path: string) => fetch(server.url + path, { headers: { Authorization: `Bearer ${server.token}` } }),
		post: (path: string, body: unknown) => fetch(server.url + path, { method: "POST", headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		restart: async () => { await server.close(); server = await startKlaudServe({ home, cwd: workspace }); },
	};
}

async function readerFor(response: Response) {
	assert.equal(response.status, 200);
	const reader = response.body!.getReader(), received: any[] = [];
	let buffer = "";
	return {
		received,
		async until(predicate: (event: any) => boolean) {
			while (true) {
				const match = received.find(predicate); if (match) return match;
				const next = await reader.read(); assert.equal(next.done, false, "stream ended before expected event");
				buffer += new TextDecoder().decode(next.value);
				let boundary;
				while ((boundary = buffer.indexOf("\n\n")) >= 0) {
					const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
					if (block.startsWith("data: ") && block !== "data: [DONE]") received.push(JSON.parse(block.slice(6)));
				}
			}
		},
		async finish() { try { while (!(await reader.read()).done) {} } finally { reader.releaseLock(); } },
	};
}

test("real runner patches live shell and resumes the same bot transcript after restart", { timeout: 15_000 }, async t => {
	const f = await fixture(t, (_body, count) => count === 1 ? call("klaud_patch_shell", { patch: [{ op: "replace", path: "/theme/density", value: "compact" }] }) : answer());
	const created = await f.post("/bots", { name: "  Fixture bot  " }); assert.equal(created.status, 201);
	const bot = await created.json(); assert.equal(bot.name, "Fixture bot");
	assert.equal(loadSession(bot.sessionId).header?.cwd, f.workspace);
	assert.equal((await (await f.get("/bots")).json())[0].id, bot.id);
	assert.equal((await f.post("/prefs", { key: "lastBotId", value: bot.id })).status, 200);
	assert.equal((await f.post("/prefs", { key: "lastBotId", value: "klaud-bot-ffffffff" })).status, 404);
	assert.equal((await f.post("/run", { botId: bot.id, threadId: "wrong-thread", message: "Hi" })).status, 400);
	const run = await f.post("/run", { botId: bot.id, threadId: bot.sessionId, message: "FIRST_QUESTION_SENTINEL" });
	const stream = await run.text(), output = events(stream);
	assert.ok(!stream.includes("PRIVATE_THINKING_SENTINEL"));
	assert.equal(output.filter(event => event.type === "RUN_FINISHED").length, 1);
	assert.ok(!output.some(event => event.type === "RUN_ERROR"));
	assert.equal(output.find(event => event.type === "STATE_DELTA").delta[0].path, "/shell/theme/density");
	const toolNames = f.requests[0].tools.map((tool: any) => tool.function.name);
	assert.equal(toolNames.filter((name: string) => name === "klaud_patch_shell").length, 1);
	assert.equal(f.requests[0].messages[0].content.split("You're in rein-klaʊd.").length - 1, 1);
	assert.ok(Buffer.byteLength(klaudPrompt(DEFAULT_KLAUD_SHELL)) < 1200);
	const history = await (await f.get(`/bots/${bot.id}/messages`)).json();
	assert.deepEqual(history.messages.map((message: any) => message.role), ["user", "assistant", "tool", "assistant"]);
	assert.ok(!JSON.stringify(history).includes("PRIVATE_THINKING_SENTINEL"));
	assert.equal(history.messages[1].toolCalls[0].function.name, "klaud_patch_shell");
	assert.equal(statSync(sessionPath(bot.sessionId)).mode & 0o777, 0o600);
	await f.restart();
	const state = await (await f.get("/state")).json();
	assert.equal(state.prefs.lastBotId, bot.id); assert.equal(state.shell.theme.density, "compact");
	assert.deepEqual(await (await f.get(`/bots/${bot.id}/messages`)).json(), history);
	await (await f.post("/run", { botId: bot.id, threadId: bot.sessionId, message: "FOLLOWUP_SENTINEL" })).text();
	// Posthorse resumes with fresh workspace context; old turns stay in durable history.
	assert.ok(!JSON.stringify(f.requests.at(-1).messages).includes("FIRST_QUESTION_SENTINEL"));
	assert.ok(JSON.stringify(f.requests.at(-1).messages).includes("FOLLOWUP_SENTINEL"));
	assert.equal(loadSession(bot.sessionId).window?.reason, "resume");
	assert.ok(JSON.stringify(loadSession(bot.sessionId).messages[0]).includes("FIRST_QUESTION_SENTINEL"));
	assert.match(f.requests.at(-1).messages[0].content, /"density":"compact"/);
	assert.equal(loadSession(bot.sessionId).messages.length, 6);
});

test("bot history preserves safe assistant completion metadata across restart", async t => {
	const f = await fixture(t);
	const bot = await (await f.post("/bots", { name: "Completion history" })).json();
	appendMessage(bot.sessionId, {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "PRIVATE_COMPLETION_THINKING" },
			{ type: "text", text: "Visible completed reply" },
		],
		provider: "PRIVATE_PROVIDER",
		model: "PRIVATE_MODEL",
		usage: { input: 11, output: 9, totalTokens: 20, reasoning: 7 },
		stopReason: "stop",
		errorMessage: "PRIVATE_ERROR_DETAIL",
		timestamp: 1,
	});
	appendMessage(bot.sessionId, {
		role: "assistant", content: [{ type: "text", text: "Legacy reply" }], timestamp: 2,
	} as any);
	appendMessage(bot.sessionId, {
		role: "assistant",
		content: [{ type: "thinking", thinking: "PRIVATE_INVALID_THINKING" }, { type: "text", text: "Invalid metadata reply" }],
		provider: "PRIVATE_INVALID_PROVIDER", model: "PRIVATE_INVALID_MODEL",
		usage: { input: 0, output: 0, totalTokens: 0, reasoning: Number.MAX_SAFE_INTEGER + 1 },
		stopReason: "private-provider-status",
		errorMessage: "PRIVATE_INVALID_ERROR",
		timestamp: 3,
	} as any);

	const history = await (await f.get(`/bots/${bot.id}/messages`)).json();
	assert.deepEqual(history.messages.map((message: any) => message.content), ["Visible completed reply", "Legacy reply", "Invalid metadata reply"]);
	assert.deepEqual(history.messages[0].completion, { stopReason: "stop", reasoningTokens: 7 });
	assert.equal("completion" in history.messages[1], false);
	assert.equal("completion" in history.messages[2], false);
	for (const privateValue of ["PRIVATE_COMPLETION_THINKING", "PRIVATE_PROVIDER", "PRIVATE_MODEL", "PRIVATE_ERROR_DETAIL", "PRIVATE_INVALID_THINKING", "PRIVATE_INVALID_PROVIDER", "PRIVATE_INVALID_MODEL", "PRIVATE_INVALID_ERROR", "private-provider-status"]) {
		assert.ok(!JSON.stringify(history).includes(privateValue));
	}

	await f.restart();
	assert.deepEqual(await (await f.get(`/bots/${bot.id}/messages`)).json(), history);
});

test("native writes require an explicit decision; cancellation rejects late approvals", { timeout: 15_000 }, async t => {
	let target = "";
	const f = await fixture(t, (_body, count) => count % 2 === 1 ? call("write", { path: target, content: "approved fixture" }, `write-${count}`) : answer());
	target = join(f.workspace, "approved.txt");
	const bot = await (await f.post("/bots", { name: "Writer" })).json();
	for (const allow of [false, true]) {
		const stream = await readerFor(await f.post("/run", { botId: bot.id, threadId: bot.sessionId, message: "Write fixture" }));
		const approval = (await stream.until(event => event.name === "klaud.approval")).value;
		assert.equal(approval.tool, "write"); assert.equal(existsSync(target), false);
		assert.equal((await f.post("/run", { botId: bot.id, threadId: bot.sessionId, message: "Overlap" })).status, 409);
		assert.equal((await f.post(`/runs/${approval.runId}/approvals/${approval.id}`, { allow })).status, 200);
		await stream.finish(); assert.equal(existsSync(target), allow);
	}
	rmSync(target);
	const stream = await readerFor(await f.post("/run", { botId: bot.id, threadId: bot.sessionId, message: "Cancel this" }));
	const approval = (await stream.until(event => event.name === "klaud.approval")).value;
	assert.equal((await f.post(`/runs/${approval.runId}/cancel`, {})).status, 200);
	await stream.finish();
	assert.equal((await f.post(`/runs/${approval.runId}/approvals/${approval.id}`, { allow: true })).status, 404);
	assert.equal(existsSync(target), false);
	assert.ok(loadSession(bot.sessionId).messages.some(message => message.role === "toolResult" && message.isError));
});

test("session symlinks cannot be read or appended by bot history or real runner", { timeout: 10_000 }, async t => {
	const f = await fixture(t), target = join(f.home, "untouched.jsonl");
	writeFileSync(target, "untouched");
	const id = `klaud-thread-${createHash("sha256").update("linked").digest("hex").slice(0, 32)}`;
	mkdirSync(join(f.home, "sessions")); symlinkSync(target, sessionPath(id));
	const output = events(await (await f.post("/run", { threadId: "linked", message: "Do not touch" })).text());
	assert.equal(output.at(-1).type, "RUN_ERROR"); assert.match(output.at(-1).message, /symlink/);
	const bot = await (await f.post("/bots", { name: "Linked" })).json();
	rmSync(sessionPath(bot.sessionId)); symlinkSync(target, sessionPath(bot.sessionId));
	assert.equal((await f.get(`/bots/${bot.id}/messages`)).status, 500);
	assert.equal(events(await (await f.post("/run", { threadId: bot.sessionId, botId: bot.id, message: "No" })).text()).at(-1).type, "RUN_ERROR");
	assert.equal(readFileSync(target, "utf8"), "untouched"); assert.equal(f.requests.length, 0);
	rmSync(join(f.home, "sessions"), { recursive: true });
	const other = join(f.home, "other"); mkdirSync(other); symlinkSync(other, join(f.home, "sessions"));
	const response = await f.post("/run", { threadId: "directory", message: "No" });
	assert.ok(response.status === 500 || (await response.text()).includes("RUN_ERROR"));
	assert.deepEqual(readdirSync(other), []);
});

test("close drains real shell cancellation and all session writes before resolving", { timeout: 12_000 }, async t => {
	let marker = "";
	const f = await fixture(t, () => call("bash", { command: `printf started > '${marker}'; sleep 30` }));
	marker = join(f.workspace, "started");
	assert.equal((await f.post("/settings", { bashApproval: "ask" })).status, 200);
	const bot = await (await f.post("/bots", { name: "Shutdown" })).json();
	const stream = await readerFor(await f.post("/run", { botId: bot.id, threadId: bot.sessionId, message: "Start fixture" }));
	const approval = (await stream.until(event => event.name === "klaud.approval")).value;
	await f.post(`/runs/${approval.runId}/approvals/${approval.id}`, { allow: true });
	const deadline = Date.now() + 2000;
	while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
	assert.ok(existsSync(marker), "fixture command must start before shutdown");
	await f.server.close(); await stream.finish().catch(() => {});
	const transcript = loadSession(bot.sessionId).messages;
	assert.ok(transcript.some(message => message.role === "toolResult"), "tool cleanup and persistence must finish before close resolves");
	assert.equal(transcript.at(-1)?.role, "toolResult");
});

test("Bash auto-approval skips popups, persists, and can be changed back to ask", { timeout: 15000 }, async t => {
	const f = await fixture(t, (_body, count) => count % 2 === 1 ? call("bash", { command: "printf 'approved fixture'" }, `shell-${count}`) : answer());
	const bot = await (await f.post("/bots", { name: "Shell policy" })).json();
	assert.equal((await (await f.get("/settings")).json()).bashApproval, "auto");
	const automatic = events(await (await f.post("/run", { threadId: bot.sessionId, botId: bot.id, message: "Run fixture" })).text());
	assert.equal(automatic.some(event => event.name === "klaud.approval"), false);
	assert.ok(automatic.some(event => event.type === "TOOL_CALL_RESULT" && event.content === "approved fixture"));
	assert.equal((await f.post("/settings", { bashApproval: "ask" })).status, 200);
	await f.restart();
	assert.equal((await (await f.get("/settings")).json()).bashApproval, "ask");
	const stream = await readerFor(await f.post("/run", { threadId: bot.sessionId, botId: bot.id, message: "Review fixture" }));
	const approval = (await stream.until(event => event.name === "klaud.approval")).value;
	assert.equal(approval.tool, "bash");
	assert.equal((await f.post(`/runs/${approval.runId}/approvals/${approval.id}`, { allow: false })).status, 200);
	await stream.finish();
	assert.equal((await f.post("/settings", { bashApproval: "auto" })).status, 200);
	assert.equal((await f.post("/settings", { bashApproval: "invalid" })).status, 400);
	assert.equal((await f.post("/settings", { secret: "fixture-secret" })).status, 400);
	assert.equal((await (await f.get("/settings")).json()).bashApproval, "auto");
	assert.equal((await fetch(f.server.url + "/settings")).status, 401);
	assert.equal((await fetch(f.server.url + "/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bashApproval: "ask" }) })).status, 401);
	assert.equal(statSync(join(f.home, "klaud/run-settings.json")).mode & 0o777, 0o600);
});

test("saved desktop reasoning effort controls the next model request without changing task budgets", { timeout: 15000 }, async t => {
	const f = await fixture(t), configFile = join(f.home, "config.json");
	const config = { ...JSON.parse(readFileSync(configFile, "utf8")), maxTurns: 120, maxIterations: 17, maxTokens: 2048 };
	writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	const configBytes = readFileSync(configFile);
	const initial = await (await f.get("/settings")).json();
	assert.equal(initial.reasoningEffort, "default"); assert.equal(initial.reasoningControl.mode, "server-dependent");
	assert.ok(initial.reasoningControl.supported.includes("high")); assert.equal(f.requests.length, 0, "reading settings must not contact a model server");
	const bot = await (await f.post("/bots", { name: "Reasoning control" })).json();
	for (const [effort, expected] of [["high", "high"], ["off", "none"], ["default", undefined]] as const) {
		const saved = await f.post("/settings", { reasoningEffort: effort }); assert.equal(saved.status, 200);
		assert.equal((await saved.json()).reasoningEffort, effort);
		if (effort === "high") { await f.restart(); assert.equal((await (await f.get("/settings")).json()).reasoningEffort, "high"); }
		const output = events(await (await f.post("/run", { botId: bot.id, threadId: bot.sessionId, message: `Exercise ${effort} with a synthetic model.` })).text());
		assert.equal(output.some(event => event.type === "RUN_ERROR"), false);
		assert.equal(output.filter(event => event.type === "RUN_FINISHED").length, 1);
		const request = f.requests.at(-1);
		assert.equal(request.reasoning_effort, expected);
		if (effort === "default") assert.equal(Object.hasOwn(request, "reasoning_effort"), false, "provider default must remove the previous explicit wire override");
		assert.deepEqual(readFileSync(configFile), configBytes, "desktop controls must preserve provider configuration and turn/iteration/token budgets");
	}
	assert.equal(f.requests.length, 3);
});

test("settings reject unsupported subscription CLI effort atomically without saving or launching a model", async t => {
	const f = await fixture(t), configFile = join(f.home, "config.json"), settingsFile = join(f.home, "klaud", "run-settings.json");
	assert.equal((await f.post("/settings", { bashApproval: "ask", reasoningEffort: "default" })).status, 200);
	const originalSettings = readFileSync(settingsFile), base = JSON.parse(readFileSync(configFile, "utf8"));
	delete process.env.REIN_BASE_URL; delete process.env.REIN_MODEL;
	for (const provider of ["codex", "copilot", "grok"]) {
		writeFileSync(configFile, JSON.stringify({ ...base, provider, baseUrl: `cli://${provider}`, model: "default", maxTurns: 120, maxIterations: 17 }));
		const configBytes = readFileSync(configFile), status = await (await f.get("/settings")).json();
		assert.equal(status.reasoningControl.mode, "unsupported"); assert.deepEqual(status.reasoningControl.supported, ["default"]);
		const rejected = await f.post("/settings", { reasoningEffort: "high", bashApproval: "auto" });
		assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /subscription CLI manages its own reasoning/);
		assert.deepEqual(readFileSync(settingsFile), originalSettings, "an invalid effort cannot partially change the Bash approval preference");
		assert.deepEqual(readFileSync(configFile), configBytes); assert.equal((await (await f.get("/settings")).json()).bashApproval, "ask");
	}
	assert.equal(f.requests.length, 0);
});

test("first-run settings work before model setup without discovery or writing provider config", async t => {
	const f = await fixture(t), configFile = join(f.home, "config.json"), settingsFile = join(f.home, "klaud", "run-settings.json");
	rmSync(configFile); delete process.env.REIN_BASE_URL; delete process.env.REIN_MODEL; delete process.env.REIN_API;
	await f.restart();
	const originalFetch = globalThis.fetch, unexpectedRequests: string[] = [];
	globalThis.fetch = ((input, init) => {
		const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!target.startsWith(f.server.url + "/")) { unexpectedRequests.push(target); return Promise.reject(new Error("First-run settings cannot discover or contact a model endpoint.")); }
		return originalFetch(input, init);
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	const response = await f.get("/settings"); assert.equal(response.status, 200);
	const settings = await response.json();
	assert.equal(settings.bashApproval, "auto"); assert.equal(settings.reasoningEffort, "default");
	assert.equal(settings.reasoningControl.mode, "unsupported"); assert.deepEqual(settings.reasoningControl.supported, ["default"]);
	assert.match(settings.reasoningControl.description, /Connect a model/);
	assert.equal(existsSync(settingsFile), false, "reading defaults must not write a settings file");
	const saved = await f.post("/settings", { bashApproval: "ask" }); assert.equal(saved.status, 200); assert.equal((await saved.json()).bashApproval, "ask");
	const settingsBytes = readFileSync(settingsFile), rejected = await f.post("/settings", { reasoningEffort: "high" });
	assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /Connect a model/);
	assert.deepEqual(readFileSync(settingsFile), settingsBytes); assert.equal((await (await f.get("/settings")).json()).bashApproval, "ask");
	assert.equal(existsSync(configFile), false, "desktop preferences cannot invent provider configuration");
	assert.equal(f.requests.length, 0); assert.deepEqual(unexpectedRequests, []);
});

test("activity requires authentication and observing a fresh install creates no state", async t => {
	const f = await fixture(t), configFile = join(f.home, "config.json");
	rmSync(configFile); delete process.env.REIN_BASE_URL; delete process.env.REIN_MODEL; delete process.env.REIN_API;
	await f.restart();
	const inventory = (directory: string, prefix = ""): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const relative = prefix + entry.name;
		return [relative, ...(entry.isDirectory() ? inventory(join(directory, entry.name), relative + "/") : [])];
	}).sort();
	const before = inventory(f.home);
	assert.equal((await fetch(f.server.url + "/activity")).status, 401);
	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await f.get("/activity"); assert.equal(response.status, 200);
		const activity = await response.json(); assert.equal(typeof activity, "object"); assert.ok(activity !== null);
	}
	assert.deepEqual(inventory(f.home), before, "observing activity cannot bootstrap helper, model or autonomy state");
	assert.equal(existsSync(configFile), false); assert.equal(f.requests.length, 0);
});

test("large histories page without exceeding the app response cap or altering saved content", async t => {
	const f = await fixture(t);
	const bot = await (await f.post("/bots", { name: "Long history" })).json();
	for (let index = 0; index < 120; index++) appendMessage(bot.sessionId, { role: "user", content: `${index}:` + "x".repeat(40_000), timestamp: index });
	let before: number | null | undefined, count = 0;
	const ids = new Set();
	do {
		const response = await f.get(`/bots/${bot.id}/messages${before === undefined ? "" : `?before=${before}`}`);
		const raw = await response.text(); assert.ok(Buffer.byteLength(raw) < 4 * 1024 * 1024);
		const page = JSON.parse(raw); before = page.before;
		assert.ok(page.messages.length > 0);
		for (const message of page.messages) { assert.ok(!ids.has(message.id)); ids.add(message.id); count++; assert.equal(message.truncated, true); }
	} while (before !== null);
	assert.equal(count, 120);
	assert.equal(loadSession(bot.sessionId).messages[0].content.length, 40_002);
});
