import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Posthorse } from "../src/harness/posthorse.ts";
import { createSession, loadSession, appendMessage, appendSessionEntry, branchSession, sessionPath } from "../src/agent/session.ts";
import { agentLoop, type AgentMessage, type AgentTool } from "../src/agent/agent-loop.ts";
import type { AssistantMessage } from "../src/ai/types.ts";
import { AssistantMessageEventStream } from "../src/ai/event-stream.ts";
const model = { id: "test", provider: "test", baseUrl: "http://unused", contextWindow: 8000, maxTokens: 1000 };
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: Date.now() });
const assistant = (text = "ok", error?: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(), model: "test", provider: "test", usage: { input: 0, output: 0, totalTokens: 0 }, stopReason: error ? "error" : "stop", ...(error ? { errorMessage: error } : {}) });
const controller = (options: Partial<ConstructorParameters<typeof Posthorse>[0]> = {}) => new Posthorse({ model, prompt: () => "system", tools: () => [], ...options });
function isolated(fn: () => void) {
	const directory = mkdtempSync(join(tmpdir(), "rein-posthorse-"));
	const previous = process.env.REIN_HOME;
	process.env.REIN_HOME = directory;
	try { fn(); } finally { if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous; rmSync(directory, { recursive: true, force: true }); }
}

test("manual boundary survives resume and full history preserves message IDs", () => isolated(() => {
	const horse = controller(); const id = createSession({}); horse.setSession(id);
	horse.record(user("old task")); horse.record(assistant()); horse.rollover("checkpoint"); horse.record(user("pending new input"));
	const resumed = controller(); resumed.setSession(id);
	assert.equal(resumed.messages.length, 3);
	assert.equal(resumed.messages[0].id, horse.messages[0].id);
	assert.equal(resumed.window?.id, horse.window?.id);
	assert.equal(resumed.active().length, 2);
	assert.equal(resumed.active()[1].content, "pending new input");
	assert.match(String(resumed.active()[0].content), /checkpoint/);
}));

test("threshold rollover preserves verbatim pending input and carries prior checkpoint", () => {
	const horse = controller(); horse.record(user("original task")); horse.record(assistant()); horse.rollover("durable checkpoint");
	horse.record(assistant("x".repeat(25000))); const pending = user("exact pending input"); horse.record(pending);
	const active = horse.prepare(horse.messages);
	assert.equal(horse.window?.reason, "threshold");
	assert.equal(active.at(-1)?.content, pending.content);
	assert.match(String(active[0].content), /durable checkpoint/);
	assert.ok(horse.used() < horse.line);
});

test("first oversized completed tool batch rolls safely and keeps recovery references", () => {
	const horse = controller(); horse.record(user("read the file"));
	const message = assistant(); message.content = [{ type: "toolCall", id: "a", name: "read", arguments: {} }]; message.stopReason = "toolUse";
	horse.record(message); horse.record({ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "x".repeat(40000) }], isError: false, timestamp: Date.now() });
	const active = horse.prepare(horse.messages);
	assert.equal(horse.window?.start, 3);
	assert.equal(active.length, 1);
	assert.match(String(active[0].content), /read the file/);
	assert.match(String(active[0].content), /Unconsumed toolResult/);
	assert.ok(horse.used() < horse.line);
});

test("oversized fresh request stays intact and does not create rollover churn", () => {
	const horse = controller(); const request = user("x".repeat(50000)); horse.record(request);
	assert.equal(horse.prepare(horse.messages)[0].content, request.content);
	const error = assistant("", "context_length_exceeded"); horse.record(error);
	assert.equal(horse.recover(error, horse.messages), false);
	assert.equal(horse.window, undefined);
	assert.equal(horse.active().length, 1);
});

test("overflow recovery filters failed assistant and retries only once per request", () => {
	const horse = controller(); horse.record(user("old task")); horse.record(assistant()); horse.record(user("current task")); horse.prepare(horse.messages);
	const error = assistant("bad partial", "maximum context length exceeded"); horse.record(error);
	assert.equal(horse.recover(error, horse.messages), true);
	const active = horse.prepare(horse.messages);
	assert.equal(active.at(-1)?.content, "current task");
	assert.ok(active.every(message => message.role !== "assistant" || message.stopReason !== "error"));
	horse.record(error); assert.equal(horse.recover(error, horse.messages), false);
	assert.equal(horse.entries.filter(entry => "type" in entry && entry.type === "context_window").length, 1);
});

test("page reads share a per-request budget and reset on next prepare", () => {
	const horse = controller(); horse.prepare([]);
	let pages = 0;
	while (pages < 100) { try { horse.pageLimit(); pages++; } catch { break; } }
	assert.ok(pages > 0 && pages < 100);
	assert.throws(() => horse.pageLimit(), /Too little context/);
	horse.prepare([]); assert.ok(horse.pageLimit() > 0);
});

test("invalid and split-batch boundaries are rejected, handoff budgets enforced", () => {
	const horse = controller(); horse.record(user("task"));
	const call = assistant(); call.content = [{ type: "toolCall", id: "a", name: "read", arguments: {} }]; horse.record(call);
	assert.throws(() => horse.rollover(), /complete tool batch/);
	assert.throws(() => horse.rollover(undefined, "manual", -1), /boundary/);
	horse.record({ role: "toolResult", toolCallId: "a", toolName: "read", content: [], isError: false, timestamp: Date.now() });
	assert.throws(() => horse.rollover(undefined, "manual", 2), /boundary/);
	assert.throws(() => horse.rollover("x".repeat(horse.freshLimit() + 1)), /Handoff exceeds/);
	horse.rollover("valid"); assert.equal(horse.window?.start, 3);
});

test("session forks preserve eligible boundaries and ignore torn/malformed records", () => isolated(() => {
	const id = createSession({}); appendMessage(id, user("first")); appendMessage(id, assistant());
	appendSessionEntry(id, { type: "context_window", id: "window", start: 2, timestamp: 1, reason: "manual", handoff: "checkpoint" });
	appendFileSync(sessionPath(id), '{"role":'); appendMessage(id, user("after torn line"));
	appendFileSync(sessionPath(id), '\n{"role":"assistant","content":[null]}\n');
	const loaded = loadSession(id); assert.equal(loaded.messages.length, 3); assert.equal(loaded.window?.id, "window");
	const before = loadSession(branchSession(id, 0)); assert.equal(before.window, undefined); assert.equal(before.messages.length, 1);
	const atBoundary = loadSession(branchSession(id, 1)); assert.equal(atBoundary.window?.id, "window"); assert.equal(atBoundary.activeMessages.length, 1);
	const full = loadSession(branchSession(id)); assert.deepEqual(full.messages.map(m => m.id), loaded.messages.map(m => m.id));
}));

test("loop rollover records full batch before switching provider context", async () => {
	const horse = controller();
	const tools: AgentTool[] = [{ name: "new_context", description: "fresh", parameters: { type: "object" }, execute: async () => ({ content: "saved", newContext: { handoff: "carry this" } }) }];
	const response = assistant(); response.content = [{ type: "toolCall", id: "a", name: "new_context", arguments: {} }]; response.stopReason = "toolUse";
	const replies = [response, assistant("finished")]; let calls = 0;
	await agentLoop([user("task")], { systemPrompt: "system", messages: [], tools }, {
		model, maxTurns: 4, transformContext: async messages => horse.prepare(messages), afterToolBatch: info => horse.afterBatch(info),
		streamFn: (_model, context) => {
			if (calls++ === 1) { assert.equal(context.messages.length, 1); assert.match(String(context.messages[0].content), /carry this/); }
			const message = replies.shift()!; const stream = new AssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message }); return stream;
		},
	}, undefined, event => { if (event.type === "message_end") horse.record(event.message); });
	assert.equal(horse.messages.length, 4); assert.equal(horse.window?.start, 3); assert.equal(horse.active().length, 2);
});

test("loop overflow recovery keeps transcript while excluding provider errors", async () => {
	const horse = controller(); horse.record(user("earlier")); horse.record(assistant());
	let calls = 0;
	await agentLoop([user("pending")], { systemPrompt: "system", messages: horse.messages, tools: [] }, {
		model, maxTurns: 3, transformContext: async messages => horse.prepare(messages), recoverFromError: ({ message, context }) => horse.recover(message, context.messages),
		streamFn: (_model, context) => {
			const message = calls++ === 0 ? assistant("", "context_length_exceeded") : assistant("done");
			if (calls === 2) { assert.equal(context.messages.at(-1)?.content, "pending"); assert.ok(context.messages.every(m => m.role !== "assistant" || m.stopReason !== "error")); }
			const stream = new AssistantMessageEventStream();
			if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message }); else stream.push({ type: "done", reason: "stop", message }); return stream;
		},
	}, undefined, event => { if (event.type === "message_end") horse.record(event.message); });
	assert.equal(calls, 2); assert.equal(horse.messages.length, 5); assert.equal(horse.messages.filter(m => m.role === "assistant" && m.stopReason === "error").length, 1);
});


test("interrupted tool batch is repaired only in provider replay", () => isolated(() => {
	const horse = controller(); const id = createSession({}); horse.setSession(id); horse.record(user("task"));
	const message = assistant(); message.content = [{ type: "toolCall", id: "a", name: "write", arguments: {} }, { type: "toolCall", id: "b", name: "write", arguments: {} }];
	horse.record(message); horse.record({ role: "toolResult", toolCallId: "a", toolName: "write", content: [{ type: "text", text: "done" }], isError: false, timestamp: Date.now() });
	const resumed = controller(); resumed.setSession(id); const active = resumed.prepare(resumed.messages);
	assert.equal(resumed.messages.length, 3); assert.equal(active.length, 4);
	assert.equal(active.at(-1)?.role, "toolResult");
	assert.match(JSON.stringify(active.at(-1)?.content), /Execution outcome is unknown/);
	assert.equal(loadSession(id).messages.length, 3);
}));
