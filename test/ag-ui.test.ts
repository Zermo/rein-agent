import test from "node:test";
import assert from "node:assert/strict";
import { stateDelta, stateSnapshot, toAgUiEvents } from "../src/ai/ag-ui.ts";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "../src/ai/types.ts";
import type { JsonPatchOp, KlaudSharedState } from "../src/harness/klaud/shell.ts";

const ids = { threadId: "t", runId: "r" };
const privateThinking = "PRIVATE_THINKING_SENTINEL";

function message(content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant", content, provider: "fixture", model: "fixture",
		usage: { input: 0, output: 0, totalTokens: 0 }, stopReason: "stop", timestamp: 0,
	};
}

function sharedState(): KlaudSharedState {
	return {
		shell: {
			version: 1,
			theme: { accent: "rain", density: "regular", dark: true },
			chrome: { sidebar: true, tray: "normal", showActivity: true },
		},
		prefs: { lastBotId: "bot-1" },
		bots: [{ id: "bot-1", name: "Fixture", sessionId: "session-1" }],
		approvals: [{ id: "approval-1", tool: "write", summary: "Write a fixture" }],
	};
}

test("text_delta emits one AG-UI content event with the run and content index", () => {
	assert.deepEqual(toAgUiEvents({ type: "text_delta", contentIndex: 0, delta: "hi", partial: message() }, ids), [
		{ type: "TEXT_MESSAGE_CONTENT", messageId: "r:0", delta: "hi" },
	]);
});

test("text start, content, and end retain block identity and assistant role", () => {
	const partial = message([{ type: "text", text: "hello" }, { type: "text", text: "there" }]);
	const events: AssistantMessageEvent[] = [
		{ type: "text_start", contentIndex: 1, partial },
		{ type: "text_delta", contentIndex: 1, delta: "there", partial },
		{ type: "text_end", contentIndex: 1, content: "there", partial },
	];
	assert.deepEqual(events.flatMap(event => toAgUiEvents(event, ids)), [
		{ type: "TEXT_MESSAGE_START", messageId: "r:1", role: "assistant" },
		{ type: "TEXT_MESSAGE_CONTENT", messageId: "r:1", delta: "there" },
		{ type: "TEXT_MESSAGE_END", messageId: "r:1" },
	]);
	assert.deepEqual(toAgUiEvents(events[0], { threadId: "t", runId: "another-run" }), [
		{ type: "TEXT_MESSAGE_START", messageId: "another-run:1", role: "assistant" },
	]);
});

test("model start leaves the run lifecycle to serve", () => {
	assert.deepEqual(toAgUiEvents({ type: "start", partial: message() }, ids), []);
});

for (const reason of ["stop", "length", "toolUse"] as const) {
	test(`done with ${reason} emits RUN_FINISHED with a success outcome`, () => {
		assert.deepEqual(toAgUiEvents({ type: "done", reason, message: message() }, ids), [
			{ type: "RUN_FINISHED", threadId: "t", runId: "r", outcome: { type: "success" } },
		]);
	});
}

test("error emits the provider error message without the raw assistant message", () => {
	const error = { ...message(), errorMessage: "Fixture provider failed" };
	assert.deepEqual(toAgUiEvents({ type: "error", reason: "error", error }, ids), [
		{ type: "RUN_ERROR", message: "Fixture provider failed" },
	]);
});

test("errors without an errorMessage use aborted", () => {
	for (const reason of ["error", "aborted"] as const) {
		assert.deepEqual(toAgUiEvents({ type: "error", reason, error: message() }, ids), [
			{ type: "RUN_ERROR", message: "aborted" },
		]);
	}
});

test("thinking events emit nothing and never expose thinking text", () => {
	const partial = message([{ type: "thinking", thinking: privateThinking }]);
	const events: AssistantMessageEvent[] = [
		{ type: "thinking_start", contentIndex: 0, partial },
		{ type: "thinking_delta", contentIndex: 0, delta: privateThinking, partial },
		{ type: "thinking_end", contentIndex: 0, content: privateThinking, partial },
	];
	for (const event of events) {
		const encoded = toAgUiEvents(event, ids);
		assert.deepEqual(encoded, []);
		assert.doesNotMatch(JSON.stringify(encoded), /PRIVATE_THINKING_SENTINEL/);
	}
});

test("tool calls emit their real id and name, then final arguments exactly once", () => {
	const toolCall: ToolCall = {
		type: "toolCall", id: "call-fixture", name: "write",
		arguments: { path: "fixture.txt", content: "A quote: \"hello\"\n漢字", nested: { count: 2 } },
	};
	const partial = message([{ type: "thinking", thinking: privateThinking }, toolCall]);
	const start = toAgUiEvents({ type: "toolcall_start", contentIndex: 1, partial }, ids);
	assert.deepEqual(start, [{ type: "TOOL_CALL_START", toolCallId: "call-fixture", toolCallName: "write" }]);
	const end = toAgUiEvents({ type: "toolcall_end", contentIndex: 1, toolCall, partial }, ids);
	assert.deepEqual(end, [
		{ type: "TOOL_CALL_ARGS", toolCallId: "call-fixture", delta: JSON.stringify(toolCall.arguments) },
		{ type: "TOOL_CALL_END", toolCallId: "call-fixture" },
	]);
	assert.deepEqual(JSON.parse(end[0].delta as string), toolCall.arguments);
	assert.doesNotMatch(JSON.stringify([...start, ...end]), /PRIVATE_THINKING_SENTINEL/);
});

test("toolcall_start without a tool block does not fabricate a tool identity", () => {
	for (const partial of [message(), message([{ type: "text", text: "hello" }])]) {
		assert.deepEqual(toAgUiEvents({ type: "toolcall_start", contentIndex: 0, partial }, ids), []);
	}
});

test("text and lifecycle payloads exclude hidden blocks from partial and final messages", () => {
	const partial = message([{ type: "thinking", thinking: privateThinking }, { type: "text", text: "hi" }]);
	const events: AssistantMessageEvent[] = [
		{ type: "start", partial },
		{ type: "text_start", contentIndex: 1, partial },
		{ type: "text_delta", contentIndex: 1, delta: "hi", partial },
		{ type: "text_end", contentIndex: 1, content: "hi", partial },
		{ type: "done", reason: "stop", message: partial },
		{ type: "error", reason: "aborted", error: partial },
	];
	const encoded = events.flatMap(event => toAgUiEvents(event, ids));
	assert.doesNotMatch(JSON.stringify(encoded), /PRIVATE_THINKING_SENTINEL|"partial"|"rawEvent"/);
});

test("stateSnapshot includes the complete typed shared state document", () => {
	const state = sharedState();
	assert.deepEqual(stateSnapshot(state), { type: "STATE_SNAPSHOT", snapshot: state });
});

test("stateDelta translates shell-relative pointers into the shared state document", () => {
	const patch: JsonPatchOp[] = [
		{ op: "test", path: "/chrome/tray", value: "normal" },
		{ op: "replace", path: "/chrome/tray", value: "quiet" },
		{ op: "add", path: "/theme/dark", value: false },
		{ op: "remove", path: "/theme/density" },
	];
	const original = structuredClone(patch);
	const encoded = stateDelta(patch);
	assert.deepEqual(encoded, {
		type: "STATE_DELTA",
		delta: [
			{ op: "test", path: "/shell/chrome/tray", value: "normal" },
			{ op: "replace", path: "/shell/chrome/tray", value: "quiet" },
			{ op: "add", path: "/shell/theme/dark", value: false },
			{ op: "remove", path: "/shell/theme/density" },
		],
	});
	assert.deepEqual(patch, original);
	assert.deepEqual(stateDelta([]), { type: "STATE_DELTA", delta: [] });

	const snapshot = stateSnapshot(sharedState()).snapshot as KlaudSharedState;
	const delta = encoded.delta as JsonPatchOp[];
	const lookup = (path: string): unknown => path.slice(1).split("/").reduce(
		(value, key) => (value as Record<string, unknown>)[key], snapshot as unknown,
	);
	assert.equal(lookup(delta[0].path), delta[0].value);
	for (const op of delta.slice(1)) {
		const key = op.path.slice(op.path.lastIndexOf("/") + 1);
		const parent = lookup(op.path.slice(0, op.path.lastIndexOf("/"))) as Record<string, unknown>;
		if (op.op === "remove") delete parent[key];
		else parent[key] = op.value;
	}
	assert.equal(snapshot.shell.chrome.tray, "quiet");
	assert.equal(snapshot.shell.theme.dark, false);
	assert.equal("density" in snapshot.shell.theme, false);
	assert.deepEqual(snapshot.prefs, { lastBotId: "bot-1" });
});
