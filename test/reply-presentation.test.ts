import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import type { AgentEvent } from "../src/agent/agent-loop.ts";
import type { AssistantMessage } from "../src/ai/types.ts";
import { createReplyPresentation } from "../src/harness/reply-presentation.ts";

function fixture(color = false) {
	let output = "";
	const view = createReplyPresentation({ write: text => { output += text; }, color });
	const message = (extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
		role: "assistant", content: [], stopReason: "stop", provider: "fixture", model: "fixture",
		usage: { input: 0, output: 0, totalTokens: 0 }, timestamp: 0, ...extra,
	});
	return {
		view, output: () => output,
		start: () => view.event({ type: "message_start", message: message() }),
		end: (extra: Partial<AssistantMessage> = {}) => view.event({ type: "message_end", message: message(extra) }),
		delta: (text: string, thinking = false) => view.event({ type: "message_update", message: message(), event: { type: thinking ? "thinking_delta" : "text_delta", delta: text } } as AgentEvent),
	};
}

test("streamed replies and tools have distinct boundaries, numbers, and rotating markers", () => {
	const f = fixture();
	f.view.operator("first request"); f.start(); f.delta("First "); f.delta("answer.");
	f.end({ content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }] });
	f.view.event({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} });
	f.view.event({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: "file preview" }, isError: false });
	f.start(); f.delta("Follow-up\n"); f.end(); f.view.finish();
	f.view.operator("second request"); f.start(); f.delta("Second answer."); f.end();
	const out = f.output();
	assert.match(out, /\[OPERATOR · turn 01\]\nfirst request\n\n\[REIN · reply 01 ◐\]\n\[MESSAGE\]\nFirst answer\.\n/);
	assert.match(out, /\[TOOL READ · read · call 01\] \{\}\n\[TOOL READ RESULT · read · call 01 · done\] file preview/);
	assert.match(out, /\[REIN · reply 02 ◓\]\n\[MESSAGE\]\nFollow-up\n/);
	assert.match(out, /\[OPERATOR · turn 02\]\nsecond request\n\n\[REIN · reply 03 ◑\]/);
	assert.equal(out.split("First answer.").length - 1, 1);
	assert.doesNotMatch(out, /\x1b|No text reply/);
});

test("steering restores the active reply identity and never exposes thinking deltas", () => {
	const f = fixture();
	f.view.operator("initial request"); f.start();
	f.delta("PRIVATE_REASONING_SENTINEL", true); f.delta("another hidden delta", true);
	f.delta("partial response");
	f.view.operator("new instruction", false, true);
	f.delta("continued response"); f.end();
	assert.match(f.output(), /partial response\n\n\[OPERATOR · turn 02\] · steering queued\nnew instruction\n\n\[REIN · reply 01 ◐ · continued\]\n\[MESSAGE\]\ncontinued response\n/);
	assert.equal(f.output().split("Thinking…").length - 1, 1);
	assert.doesNotMatch(f.output(), /PRIVATE_REASONING_SENTINEL|another hidden delta|reply 02/);
});

test("empty, canceled, error, and truncated replies remain visible and labeled", () => {
	const f = fixture();
	f.view.startRun(); f.start(); f.end();
	f.view.startRun(); f.start(); f.end({ stopReason: "aborted" }); f.view.finish(undefined, true);
	f.view.startRun(); f.view.finish("connection failed");
	f.view.startRun(); f.start(); f.delta("unfinished"); f.end({ stopReason: "length" });
	assert.match(f.output(), /reply 01 ◐\]\n\[COMPLETE\] No text reply/);
	assert.match(f.output(), /reply 02 ◓\]\n\[CANCELED\] Reply canceled/);
	assert.equal(f.output().split("Reply canceled.").length - 1, 1);
	assert.match(f.output(), /reply 03 ◑\]\n\[ERROR\] Error: connection failed/);
	assert.match(f.output(), /reply 04 ◒\]\n\[MESSAGE\]\nunfinished\n\[LIMIT\] Reply reached the output limit/);
});

test("budget pause is labeled and offers continuation without claiming an error or completion", () => {
	const f = fixture(); f.view.startRun(); f.start();
	f.end({ stopReason: "budget", budget: { kind: "turns", limit: 300, used: 300 } }); f.view.finish();
	assert.match(f.output(), /\[PAUSED\] Paused after 300 model turns/);
	assert.match(f.output(), /Reply "continue" to resume/);
	assert.doesNotMatch(f.output(), /\[ERROR\]|\[COMPLETE\]|No text reply/);
});

test("cancellation before streaming gets an identity and the next reply rotates", () => {
	const f = fixture();
	f.view.startRun(); f.view.finish(undefined, true);
	f.view.startRun(); f.start(); f.delta("recovered"); f.end();
	assert.match(f.output(), /reply 01 ◐\]\n\[CANCELED\] Reply canceled/);
	assert.match(f.output(), /reply 02 ◓\]\n\[MESSAGE\]\nrecovered/);
});

test("a final-only provider response renders once without depending on delta events", () => {
	const f = fixture();
	f.end({ content: [{ type: "text", text: "final answer" }] });
	f.view.finish();
	assert.match(f.output(), /reply 01 ◐\]\n\[MESSAGE\]\nfinal answer\n\[COMPLETE\] Reply ended\.\n$/);
	assert.doesNotMatch(f.output(), /No text reply/);
});

test("operator stays cyan while reply accents rotate and close their ANSI style", () => {
	const f = fixture(true);
	for (let i = 0; i < 5; i++) { f.view.operator(`request ${i}`); f.start(); f.delta("answer"); f.end(); }
	assert.match(f.output(), /\x1b\[1;36m\[OPERATOR · turn 01\]\x1b\[0m/);
	assert.match(f.output(), /\x1b\[1;32m\[REIN · reply 01 ◐\]\x1b\[0m\n\x1b\[1;32m\[MESSAGE\]\x1b\[0m\nanswer/);
	assert.match(f.output(), /\x1b\[1;35m\[REIN · reply 02 ◓\]\x1b\[0m/);
	assert.match(f.output(), /\x1b\[1;33m\[REIN · reply 03 ◑\]\x1b\[0m/);
	assert.match(f.output(), /\x1b\[1;94m\[REIN · reply 04 ◒\]\x1b\[0m/);
	assert.match(f.output(), /\x1b\[1;32m\[REIN · reply 05 ◐\]\x1b\[0m/);
	assert.doesNotMatch(f.output().replace(/\x1b\[[0-9;]+m/g, ""), /\x1b|\r/);
});

test("NO_COLOR including its empty form and non-TTY output suppress label escapes", () => {
	for (const mode of ["redirected", "no-color", "no-color-empty"]) {
		const env = { ...process.env };
		delete env.NO_COLOR;
		if (mode.startsWith("no-color")) env.NO_COLOR = mode === "no-color-empty" ? "" : "1";
		const script = `import { createReplyPresentation } from ${JSON.stringify(new URL("../src/harness/reply-presentation.ts", import.meta.url).href)};
Object.defineProperty(process.stdout, "isTTY", { value: ${mode !== "redirected"} });
const view = createReplyPresentation({ write: text => process.stdout.write(text) }); view.operator("hello"); view.finish("fixture error");`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
		assert.equal(child.status, 0, child.stderr);
		assert.match(child.stdout, /OPERATOR.*turn 01/);
		assert.match(child.stdout, /REIN.*reply 01/);
		assert.doesNotMatch(child.stdout, /\x1b/);
	}
});

test("readline-echoed operator input is not duplicated and advances the next prompt", () => {
	const f = fixture();
	assert.equal(f.view.prompt(), "[OPERATOR · turn 01] ❯ ");
	f.view.operator("already echoed", true);
	assert.equal(f.output(), "");
	assert.equal(f.view.prompt(), "[OPERATOR · turn 02] ❯ ");
	f.view.operator("queued input without a prompt");
	assert.match(f.output(), /\[OPERATOR · turn 02\]\nqueued input without a prompt/);
});
