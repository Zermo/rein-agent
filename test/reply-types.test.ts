import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent/agent-loop.ts";
import type { AssistantMessage } from "../src/ai/types.ts";
import { createReplyPresentation, reasoningUsageLabel, replyTextPrefix, toolActionType } from "../src/harness/reply-presentation.ts";

function fixture() {
	let output = "";
	const view = createReplyPresentation({ color: false, write: text => { output += text; } });
	const message: AssistantMessage = { role: "assistant", provider: "fixture", model: "fixture", timestamp: 0,
		content: [], stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0 } };
	return { view, message, output: () => output,
		delta: (delta: string) => view.event({ type: "message_update", message, event: { type: "text_delta", delta } } as AgentEvent),
		end: (extra: Partial<AssistantMessage> = {}) => view.event({ type: "message_end", message: { ...message, ...extra } }),
	};
}

test("only an explicit first-line marker declares a reply purpose, at every stream boundary", () => {
	for (const kind of ["RESULT", "OPINION", "CHOICE", "CHANGE", "EDIT"]) {
		const source = `[${kind}]\nThe visible answer.`;
		for (let split = 1; split < source.length; split++) {
			const f = fixture(); f.delta(source.slice(0, split)); f.delta(source.slice(split)); f.end();
			assert.match(f.output(), new RegExp(`\\[${kind} · agent-labeled\\]\\nThe visible answer\\.`), `${kind} at ${split}`);
			assert.equal(f.output().split("The visible answer.").length - 1, 1);
			assert.doesNotMatch(f.output(), /\[MESSAGE\]/);
			assert.match(f.output(), /\[COMPLETE\] Reply ended\./);
		}
	}
});

test("opinion words, embedded headings, unrecognized labels, and code are ordinary text", () => {
	for (const source of ["In my opinion, choose A.", "Result: 42", "[RESULT] same line", " [EDIT]\nIndented text", "[CONFIDENCE]\nhigh", "Introduction\n[CHOICE]\nA", "```\n[RESULT]\nexample\n```", "[TOOL WRITE]\nNot a tool call"]) {
		const f = fixture(); for (const character of source) f.delta(character); f.end();
		assert.match(f.output(), /\[MESSAGE\]/, source);
		assert.doesNotMatch(f.output(), /agent-labeled/);
		assert.ok(f.output().includes(source), source);
	}
	assert.deepEqual(replyTextPrefix("[CHOICE]\r\nA"), { pending: false, type: "CHOICE", text: "A" });
});

test("partial prefix survives steering, cancellation, and final-only responses", () => {
	const f = fixture(); f.delta("[OP");
	assert.doesNotMatch(f.output(), /\[MESSAGE\]|\[OP$/);
	f.view.pauseForInput(); f.view.operator("keep this brief"); f.delta("INION]\nA useful judgment."); f.end();
	assert.match(f.output(), /reply 01 ◐ · continued\]\n\[OPINION · agent-labeled\]\nA useful judgment/);
	const canceled = fixture(); canceled.delta("[RES"); canceled.view.finish(undefined, true);
	assert.match(canceled.output(), /\[MESSAGE\]\n\[RES\n\[CANCELED\] Reply canceled\./);
	const finalOnly = fixture(); finalOnly.end({ content: [{ type: "text", text: "[CHANGE]\nUpdated the file." }] });
	assert.match(finalOnly.output(), /\[CHANGE · agent-labeled\]\nUpdated the file\./);
});

test("known tool contracts identify actions without guessing what a command will do", () => {
	assert.equal(toolActionType("read"), "READ");
	assert.equal(toolActionType("write"), "WRITE");
	assert.equal(toolActionType("edit"), "EDIT");
	assert.equal(toolActionType("bash", { command: "cat a.txt" }), "EXEC");
	assert.equal(toolActionType("notes", { op: "append" }), "WRITE");
	assert.equal(toolActionType("notes", { op: "search" }), "READ");
	assert.equal(toolActionType("tmux", { op: "capture" }), "READ");
	assert.equal(toolActionType("tmux", { op: "send" }), "EXEC");
	assert.equal(toolActionType("gates", { mode: "status" }), "CHECK");
	assert.equal(toolActionType("gates", { mode: "approve" }), "EXEC");
	assert.equal(toolActionType("notes", { op: "unknown" }), "CALL");
	assert.equal(toolActionType("custom-edit-files", { description: "write" }), "CALL");
});

test("parallel tools retain action and matching call identities in reverse completion order", () => {
	const f = fixture(); f.view.startRun();
	f.view.event({ type: "tool_execution_start", toolCallId: "note-write", toolName: "notes", args: { op: "write", path: "MEMORY.md" } });
	f.view.event({ type: "tool_execution_start", toolCallId: "note-read", toolName: "notes", args: { op: "read", path: "OTHER.md" } });
	f.view.event({ type: "tool_execution_end", toolCallId: "note-read", toolName: "notes", result: { content: "read result" }, isError: false });
	f.view.event({ type: "tool_execution_end", toolCallId: "note-write", toolName: "notes", result: { content: "write failed" }, isError: true });
	assert.match(f.output(), /\[TOOL WRITE · notes · call 01\]/);
	assert.match(f.output(), /\[TOOL READ RESULT · notes · call 02 · done\] read result/);
	assert.match(f.output(), /\[TOOL WRITE RESULT · notes · call 01 · failed\] write failed/);
	assert.doesNotMatch(f.output(), /REIN|OPERATOR|MESSAGE|agent-labeled/);
});

test("provider reasoning usage is shown without exposing thought content or inventing strength", () => {
	const f = fixture();
	f.view.event({ type: "message_update", message: f.message, event: { type: "thinking_delta", delta: "HIDDEN_THOUGHT" } } as AgentEvent);
	f.delta("[OPINION]\nMy answer.");
	f.end({ content: [{ type: "thinking", thinking: "ANOTHER_PRIVATE_THOUGHT" }], usage: { input: 10, output: 500, totalTokens: 510, reasoning: 347 } });
	assert.match(f.output(), /\[THINKING\] Thinking… Effort: not reported\./);
	assert.match(f.output(), /\[REASONING\] 347 reasoning tokens \(provider reported\)\. Effort: not reported\./);
	assert.doesNotMatch(f.output(), /HIDDEN_THOUGHT|ANOTHER_PRIVATE_THOUGHT|confidence|strength:|effort: high/i);
	for (const reasoning of [undefined, 0, -1, NaN, Infinity, 1.5]) {
		assert.equal(reasoningUsageLabel({ ...f.message, usage: { ...f.message.usage, reasoning } }), undefined);
	}
	const unreported = fixture(); unreported.delta("Answer."); unreported.end({ usage: { input: 30, output: 900, totalTokens: 930 } });
	assert.doesNotMatch(unreported.output(), /\[REASONING\]|900 reasoning|effort: high/i);
});

test("ambiguous parallel IDs do not invent a match, while sequential IDs may be reused", () => {
	const f = fixture();
	for (const op of ["write", "read"]) f.view.event({ type: "tool_execution_start", toolCallId: "reused", toolName: "notes", args: { op } });
	for (const content of ["first", "second"]) f.view.event({ type: "tool_execution_end", toolCallId: "reused", toolName: "notes", result: { content }, isError: false });
	assert.equal(f.output().split("duplicate ID; unpaired").length - 1, 2);
	assert.doesNotMatch(f.output(), /RESULT[^\n]*call 0[12]/);
	const sequential = fixture();
	for (const op of ["write", "read"]) {
		sequential.view.event({ type: "tool_execution_start", toolCallId: "reused", toolName: "notes", args: { op } });
		sequential.view.event({ type: "tool_execution_end", toolCallId: "reused", toolName: "notes", result: { content: op }, isError: false });
	}
	assert.match(sequential.output(), /TOOL WRITE RESULT · notes · call 01/);
	assert.match(sequential.output(), /TOOL READ RESULT · notes · call 02/);
});
