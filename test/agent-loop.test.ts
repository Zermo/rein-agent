import assert from "node:assert/strict";
import test from "node:test";
import { agentLoop, type AgentLoopConfig, type AgentTool, type AgentToolResult, type AgentEvent } from "../src/agent/agent-loop.ts";
import { AssistantMessageEventStream } from "../src/ai/event-stream.ts";
import type { AssistantMessage, Context, ToolCall } from "../src/ai/types.ts";

const model = { id: "test", provider: "test", baseUrl: "http://unused", contextWindow: 4096, maxTokens: 100 };
const call = (id: string, name = "test"): ToolCall => ({ type: "toolCall", id, name, arguments: {} });
const reply = (content: AssistantMessage["content"] = [], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
	role: "assistant", content, stopReason, model: model.id, provider: model.provider,
	usage: { input: 0, output: 0, totalTokens: 0 }, timestamp: Date.now(),
});
const tool = (execute: AgentTool["execute"]): AgentTool => ({ name: "test", description: "test", parameters: { type: "object" }, execute });
function setup(responses: AssistantMessage[], tools: AgentTool[] = [], extra: Partial<AgentLoopConfig> = {}, signal?: AbortSignal) {
	const inputs: Context[] = [];
	const events: AgentEvent[] = [];
	const config: AgentLoopConfig = {
		model, maxTurns: 10,
		streamFn: (_model, context) => {
			inputs.push({ ...context, messages: [...context.messages] });
			const message = responses.shift();
			assert.ok(message, "unexpected model call");
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
			else stream.push({ type: "done", reason: message.stopReason as "stop", message });
			return stream;
		}, ...extra,
	};
	return { inputs, events, run: () => agentLoop([], { systemPrompt: "test", messages: [], tools }, config, signal, (event) => { events.push(event); }) };
}

test("tool isError reaches hooks, events and model context", async () => {
	let observed: boolean | undefined;
	const harness = setup([reply([call("a")], "toolUse"), reply()], [tool(async () => ({ content: "failure", isError: true }))], {
		afterToolCall: ({ isError }) => { observed = isError; },
	});
	const messages = await harness.run();
	assert.equal(observed, true);
	assert.equal(messages.find((m) => m.role === "toolResult")?.isError, true);
	assert.equal(harness.events.find((e) => e.type === "tool_execution_end")?.isError, true);
	assert.equal(harness.inputs[1].messages.find((m) => m.role === "toolResult")?.isError, true);
});

test("final allowed turn still executes and pairs all tool calls", async () => {
	let executed = 0;
	const harness = setup([reply([call("a"), call("b")], "toolUse")], [tool(async () => { executed++; return { content: "ok" }; })], { maxTurns: 1 });
	const messages = await harness.run();
	assert.equal(executed, 2);
	assert.deepEqual(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId), ["a", "b"]);
	assert.equal(harness.inputs.length, 1);
});

test("sequential abort pairs unexecuted tools and does not drain followups", async () => {
	const controller = new AbortController();
	let executed = 0;
	let followups = 0;
	let requested: unknown;
	const harness = setup([reply([call("a"), call("b")], "toolUse")], [tool(async () => {
		executed++; controller.abort(); return { content: "ok", newContext: {} };
	})], {
		toolExecution: "sequential", getFollowUpMessages: () => { followups++; return []; },
		afterToolBatch: ({ newContext }) => { requested = newContext; },
	}, controller.signal);
	const results = (await harness.run()).filter((m) => m.role === "toolResult");
	assert.equal(executed, 1);
	assert.equal(results.length, 2);
	assert.equal(results[1].isError, true);
	assert.equal(followups, 0);
	assert.equal(requested, undefined);
});

test("followups survive next iteration and each assistant turn starts an event", async () => {
	let polls = 0;
	const followup = { role: "user" as const, content: "continue", timestamp: Date.now() };
	const harness = setup([reply(), reply()], [], { getFollowUpMessages: () => polls++ === 0 ? [followup] : [] });
	await harness.run();
	assert.ok(harness.inputs[1].messages.includes(followup));
	assert.equal(harness.events.filter((e) => e.type === "turn_start").length, 2);
});

test("fresh context hook sees all recorded results and replaces context for next call", async () => {
	const harness = setup([reply([call("a"), call("b")], "toolUse"), reply()], [tool(async (id) => ({ content: id, ...(id === "a" ? { newContext: { handoff: "next" } } : {}) }))], {
		afterToolBatch: ({ context, toolResults, newContext }) => {
			assert.deepEqual(newContext, { handoff: "next" });
			assert.equal(toolResults.length, 2);
			assert.deepEqual(context.messages.slice(-2), toolResults);
			context.messages = [{ role: "user", content: "fresh", timestamp: Date.now() }];
		},
	});
	await harness.run();
	assert.equal(harness.inputs[1].messages.length, 1);
	assert.equal(harness.inputs[1].messages[0].content, "fresh");
});

for (const [label, results] of [
	["failed sibling", [{ content: "ok", newContext: {} }, { content: "bad", isError: true }]],
	["duplicate requests", [{ content: "ok", newContext: {} }, { content: "ok", newContext: {} }]],
	["failed requester", [{ content: "bad", newContext: {}, isError: true }, { content: "ok" }]],
] as [string, AgentToolResult[]][]) {
	test(`fresh context denied for ${label}`, async () => {
		let called = false;
		const harness = setup([reply([call("a"), call("b")], "toolUse")], [tool(async (id) => results[id === "a" ? 0 : 1])], {
			maxTurns: 1, afterToolBatch: ({ newContext }) => { called = true; assert.equal(newContext, undefined); },
		});
		await harness.run(); assert.equal(called, true);
	});
}

test("error recovery retries with repaired context and obeys maxTurns", async () => {
	let recoveries = 0;
	const harness = setup([reply([], "error"), reply([], "error"), reply([], "error")], [], {
		maxTurns: 3, recoverFromError: ({ context }) => { recoveries++; context.messages = []; return true; },
	});
	await harness.run();
	assert.equal(harness.inputs.length, 3);
	assert.equal(recoveries, 2);
	assert.ok(harness.inputs.every((input) => input.messages.length === 0));
});

test("failed and truncated model responses pair calls without executing them", async () => {
	for (const reason of ["error", "aborted", "length"] as const) {
		let executed = false;
		const harness = setup([reply([call("a")], reason)], [tool(async () => { executed = true; return { content: "bad" }; })], { maxTurns: 1 });
		const messages = await harness.run();
		assert.equal(executed, false);
		assert.equal(messages.find((m) => m.role === "toolResult")?.isError, true);
	}
});

test("throwing preflight and postflight hooks produce paired tool errors", async () => {
	for (const key of ["beforeToolCall", "afterToolCall"] as const) {
		const harness = setup([reply([call("a"), call("b")], "toolUse")], [tool(async () => ({ content: "ok" }))], {
			maxTurns: 1, [key]: () => { throw new Error("hook failed"); },
		});
		const results = (await harness.run()).filter((m) => m.role === "toolResult");
		assert.equal(results.length, 2);
		assert.ok(results.every((result) => result.isError));
	}
});

test("provider promise rejection is encoded and can recover", async () => {
	let recovered = false;
	const harness = setup([], [], {
		maxTurns: 2, streamFn: async () => { throw new Error("transport failed"); },
		recoverFromError: ({ message }) => { recovered = true; assert.equal(message.errorMessage, "transport failed"); return true; },
	});
	const messages = await harness.run();
	assert.equal(recovered, true);
	assert.equal(messages.length, 2);
	assert.equal(harness.events.filter((event) => event.type === "message_start").length, 2);
	assert.ok(messages.every((message) => message.role === "assistant" && message.stopReason === "error"));
});
