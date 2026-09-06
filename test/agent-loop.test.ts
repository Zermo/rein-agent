import assert from "node:assert/strict";
import test from "node:test";
import { agentLoop, type AgentLoopConfig, type AgentTool, type AgentToolResult, type AgentEvent } from "../src/agent/agent-loop.ts";
import { AssistantMessageEventStream } from "../src/ai/event-stream.ts";
import type { AssistantMessage, Context, ToolCall } from "../src/ai/types.ts";
import { DEFAULT_MAX_TURNS } from "../src/agent/budgets.ts";
import { providerMessages } from "../src/agent/session.ts";

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

test("Fold stop policy ends repeated batches with a persisted incomplete outcome", async () => {
	let executions = 0;
	const harness = setup([reply([call("a")], "toolUse"), reply([call("b")], "toolUse"), reply([call("c")], "toolUse"), reply([call("d")], "toolUse"), reply()],
		[tool(async () => { executions++; return { content: "same failure", isError: true }; })],
		{ stopConditions: { doomLoop: { enabled: true, repeatedToolCalls: 3 } } });
	const messages = await harness.run();
	assert.equal(executions, 3); assert.equal(harness.inputs.length, 3);
	assert.equal(messages.at(-1)?.role, "assistant");
	assert.match((messages.at(-1) as AssistantMessage).errorMessage!, /doom loop detected/);
	assert.equal((messages.at(-1) as AssistantMessage).stopReason, "error");
});

test("new steering at the repeat boundary reaches the model and resets the detector", async () => {
	let executions = 0, steered = false;
	const harness = setup([reply([call("a")], "toolUse"), reply([call("b")], "toolUse"), reply([call("c")], "toolUse"), reply()],
		[tool(async () => { executions++; return { content: "same evidence" }; })], {
			stopConditions: { doomLoop: { enabled: true, repeatedToolCalls: 3 } },
			getSteeringMessages: () => executions === 3 && !steered ? (steered = true, [{ role: "user", content: "NEW_SCOPE", timestamp: 1 }]) : [],
		});
	const messages = await harness.run();
	assert.equal(harness.inputs.length, 4);
	assert.ok(harness.inputs[3].messages.some(m => m.role === "user" && m.content === "NEW_SCOPE"));
	assert.equal((messages.at(-1) as AssistantMessage).stopReason, "stop");
});

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
	assert.equal((messages.at(-1) as AssistantMessage).stopReason, "budget");
	assert.deepEqual((messages.at(-1) as AssistantMessage).budget, { kind: "turns", limit: 1, used: 1 });
	assert.equal((messages.at(-1) as AssistantMessage).errorMessage, undefined);
	assert.equal(harness.events.filter(event => event.type === "agent_pause").length, 1);
});

test("default turn budget permits work beyond 60 turns and pauses at 300", async () => {
	assert.equal(DEFAULT_MAX_TURNS, 300);
	let executed = 0;
	const successful = setup([...Array.from({ length: 65 }, (_, i) => reply([call(String(i))], "toolUse")), reply([{ type: "text", text: "finished" }])], [tool(async () => { executed++; return { content: "next item" }; })], { maxTurns: undefined });
	assert.equal((await successful.run()).at(-1)?.stopReason, "stop"); assert.equal(executed, 65); assert.equal(successful.inputs.length, 66);
	const exhausted = setup(Array.from({ length: 300 }, (_, i) => reply([call(String(i))], "toolUse")), [tool(async () => ({ content: "next item" }))], { maxTurns: undefined });
	const result = await exhausted.run();
	assert.equal(exhausted.inputs.length, 300); assert.equal(result.filter(message => message.role === "toolResult").length, 300);
	assert.equal((result.at(-1) as AssistantMessage).stopReason, "budget");
	assert.deepEqual((result.at(-1) as AssistantMessage).budget, { kind: "turns", limit: 300, used: 300 });
});

test("invalid direct loop budgets fail before events or model calls", async () => {
	for (const maxTurns of [0, -1, 1.5, NaN, Infinity, -Infinity, 10_001, Number.MAX_SAFE_INTEGER + 1, "2", null]) {
		const harness = setup([reply()], [], { maxTurns: maxTurns as any });
		await assert.rejects(harness.run(), /maxTurns must be a finite integer/);
		assert.equal(harness.inputs.length, 0); assert.equal(harness.events.length, 0);
	}
});

test("completion on the exact final turn and explicit terminating tools do not pause", async () => {
	for (const terminate of [false, true]) {
		const harness = setup([terminate ? reply([call("end")], "toolUse") : reply([{ type: "text", text: "done" }])], [tool(async () => ({ content: "done", terminate: true }))], { maxTurns: 1 });
		const result = await harness.run();
		assert.equal(result.some(message => message.role === "assistant" && message.stopReason === "budget"), false);
		assert.equal(harness.events.some(event => event.type === "agent_pause"), false);
	}
});

test("budget continuation preserves completed pairs and excludes the pause marker from model input", async () => {
	const first = setup([reply([call("saved-a"), call("saved-b")], "toolUse")], [tool(async id => ({ content: `completed ${id}` }))], { maxTurns: 1 });
	const saved = await first.run(); let input: Context | undefined;
	const result = await agentLoop([{ role: "user", content: "continue", timestamp: 1 }], { systemPrompt: "test", messages: saved, tools: [] }, {
		model, maxTurns: 1, streamFn: (_model, context) => { input = context; const stream = new AssistantMessageEventStream(), message = reply([{ type: "text", text: "now finished" }]); stream.push({ type: "done", reason: "stop", message }); return stream; },
	}, undefined, () => {});
	assert.equal((result.at(-1) as AssistantMessage).stopReason, "stop");
	assert.equal(input?.messages.some(message => message.role === "assistant" && message.stopReason === "budget"), false);
	assert.deepEqual(input?.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId), ["saved-a", "saved-b"]);
	assert.deepEqual(providerMessages(saved).map(message => message.role), ["assistant", "toolResult", "toolResult"]);
});

test("steering and followups at the final boundary are persisted before pausing", async () => {
	for (const type of ["steering", "followup"]) {
		let complete = false, drained = false;
		const pending = { role: "user" as const, content: "keep this next instruction", timestamp: 1 };
		const take = () => complete && !drained ? (drained = true, [pending]) : [];
		const harness = setup([reply()], [], { maxTurns: 1, shouldStopAfterTurn: () => { complete = true; return false; }, ...(type === "steering" ? { getSteeringMessages: take } : { getFollowUpMessages: take }) });
		const result = await harness.run();
		assert.equal(harness.inputs.length, 1); assert.equal(result.filter(message => message === pending).length, 1);
		assert.equal((result.at(-1) as AssistantMessage).stopReason, "budget");
		assert.ok(harness.events.some(event => event.type === "message_end" && event.message === pending));
	}
});

test("recoverable context error on the final turn pauses after repair, while real failures remain errors", async () => {
	for (const repaired of [true, false]) {
		let repairs = 0;
		const harness = setup([{ ...reply([], "error"), errorMessage: "context too large" }], [], { maxTurns: 1, recoverFromError: () => { repairs++; return repaired; } });
		const result = await harness.run(); assert.equal(repairs, 1); assert.equal(harness.inputs.length, 1);
		assert.equal((result.at(-1) as AssistantMessage).stopReason, repaired ? "budget" : "error");
		assert.equal(result.filter(message => message.role === "assistant" && message.stopReason === "error").length, 1);
	}
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
	assert.equal(recoveries, 3, "repair the final failed context before saving a resumable pause");
	assert.ok(harness.events.some(event => event.type === "agent_pause"));
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
	assert.equal(messages.length, 3);
	assert.equal(harness.events.filter((event) => event.type === "message_start").length, 3);
	assert.ok(messages.slice(0, 2).every((message) => message.role === "assistant" && message.stopReason === "error"));
	assert.equal((messages.at(-1) as AssistantMessage).stopReason, "budget");
});
