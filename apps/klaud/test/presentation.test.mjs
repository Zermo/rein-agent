import assert from "node:assert/strict";
import { test } from "node:test";
import { presentTranscript, publicCompletion, publicProgress, readTranscriptView, requestRoute, saveTranscriptView, updateTranscript, validateActivity, validateRunSettings } from "../model.mjs";

test("run settings use a dedicated strict route rather than shell preferences", () => {
  assert.deepEqual(requestRoute("getRunSettings"), { method: "GET", path: "/settings" });
  assert.deepEqual(requestRoute("saveRunSettings", { bashApproval: "ask" }), { method: "POST", path: "/settings", body: { bashApproval: "ask" } });
  assert.deepEqual(validateRunSettings({ bashApproval: "auto", reasoningEffort: "default" }), { bashApproval: "auto", reasoningEffort: "default" });
  for (const value of [{}, { bashApproval: true }, { bashApproval: "always" }, { reasoningEffort: "maximum" }, { reasoningEffort: "high", headers: {} }, { key: "bashApproval", value: "auto" }, { reasoningControl: {} }]) assert.throws(() => requestRoute("saveRunSettings", value));
  assert.throws(() => requestRoute("setPref", { key: "bashApproval", value: "auto" }));
  assert.throws(() => validateRunSettings({ bashApproval: "auto" }));
  const settings = { bashApproval: "auto", reasoningEffort: "default", reasoningControl: { mode: "server-dependent", supported: ["default", "low", "high"], description: "The server decides whether this option applies.", field: "reasoning_effort" } };
  assert.deepEqual(validateRunSettings(settings), settings);
  assert.throws(() => requestRoute("saveRunSettings", settings));
  assert.throws(() => validateRunSettings({ ...settings, reasoningControl: { ...settings.reasoningControl, supported: ["invented"] } }));
});

test("view defaults to compact activity, persists locally, and tolerates blocked storage", () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(readTranscriptView(storage), "activity");
  for (const value of ["replies", "full", "activity"]) {
    assert.equal(saveTranscriptView(value, storage), value);
    assert.equal(readTranscriptView(storage), value);
  }
  assert.throws(() => saveTranscriptView("secret", storage));
  const denied = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readTranscriptView(denied), "activity");
  assert.equal(saveTranscriptView("full", denied), "full");
});

test("streamed text preserves fields and completion replaces parsed tool markup", () => {
  const original = [{ id: "turn-1", role: "assistant", content: "Before ", toolCalls: [{ id: "call-1", function: { name: "bash", arguments: "{}" } }], truncated: true }];
  const appended = updateTranscript(original, { type: "TEXT_MESSAGE_CONTENT", messageId: "turn-1", delta: "after" });
  assert.equal(appended[0].content, "Before after");
  assert.deepEqual(appended[0].toolCalls, original[0].toolCalls);
  assert.equal(appended[0].truncated, true);
  assert.equal(original[0].content, "Before ");
  const complete = updateTranscript(appended, { type: "TEXT_MESSAGE_END", messageId: "turn-1", content: "Parsed reply", completion: { stopReason: "toolUse", reasoningTokens: 24, hidden: "discard" } });
  assert.equal(complete[0].content, "Parsed reply");
  assert.deepEqual(complete[0].completion, { stopReason: "toolUse", reasoningTokens: 24 });
  assert.deepEqual(complete[0].toolCalls, original[0].toolCalls);
  assert.equal(updateTranscript(complete, { type: "TEXT_MESSAGE_END", messageId: "turn-1", content: "" })[0].content, "");
  assert.throws(() => updateTranscript([], { type: "TEXT_MESSAGE_END", messageId: "turn-1", content: {} }));
});

test("tool deltas retain names, arguments, results and failures by scoped ID", () => {
  let transcript = [];
  for (const event of [
    { type: "TOOL_CALL_START", toolCallId: "run1-turn1-call", toolCallName: "bash" },
    { type: "TOOL_CALL_ARGS", toolCallId: "run1-turn1-call", delta: '{"command":' },
    { type: "TOOL_CALL_ARGS", toolCallId: "run1-turn1-call", delta: '"false"}' },
    { type: "TOOL_CALL_RESULT", toolCallId: "run1-turn1-call", content: [{ type: "text", text: "Exit code 1" }], isError: true },
    { type: "TOOL_CALL_START", toolCallId: "run1-turn2-call", toolCallName: "read" },
    { type: "TOOL_CALL_RESULT", toolCallId: "run1-turn2-call", content: "File contents", isError: false },
  ]) transcript = updateTranscript(transcript, event);
  assert.equal(transcript.length, 2);
  assert.equal(transcript[0].toolName, "bash");
  assert.equal(transcript[0].arguments, '{"command":"false"}');
  assert.equal(transcript[0].content, "Exit code 1");
  assert.equal(transcript[0].isError, true);
  assert.equal(transcript[0].status, "complete");
  assert.equal(transcript[1].toolName, "read");
  assert.equal(transcript[1].content, "File contents");
});

test("presentation removes empty assistant bubbles and coalesces durable tool records", () => {
  const records = [
    { id: "user-1", role: "user", content: "Check this" },
    { id: "assistant-1", role: "assistant", content: "", toolCalls: [{ id: "call-1", function: { name: "bash", arguments: '{"command":"pwd"}' } }] },
    { id: "result-1", role: "tool", content: "/project", toolCallId: "call-1" },
    { id: "assistant-2", role: "assistant", content: "  " },
    { id: "assistant-3", role: "assistant", content: "Ready", completion: { stopReason: "stop", reasoningTokens: 12 } },
  ];
  const rows = presentTranscript(records);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].toolName, "bash");
  assert.equal(rows[1].arguments, '{"command":"pwd"}');
  assert.equal(rows[1].content, "/project");
  assert.equal(rows[1].id, "result-1");
  assert.deepEqual(presentTranscript(records, "replies").map(item => item.role), ["user", "assistant"]);
  assert.deepEqual(presentTranscript(records, "full"), rows);
  assert.equal(records[1].toolCalls.length, 1);
});

test("every view retains error output and unpaired historical results", () => {
  const records = [{ id: "failed", role: "tool", toolCallId: "gone", toolName: "bash", content: "The requested command failed", isError: true }];
  for (const view of ["replies", "activity", "full"]) assert.equal(presentTranscript(records, view)[0].content, records[0].content);
  assert.throws(() => presentTranscript(records, "hidden"));
});

test("only provider-reported progress phases and completion metadata are exposed", () => {
  assert.deepEqual(publicProgress({ phase: "thinking", turn: 2, hidden: "private text" }), { phase: "thinking", turn: 2 });
  assert.deepEqual(publicProgress({ phase: "tool", turn: 3, toolName: "read" }), { phase: "tool", turn: 3, toolName: "read" });
  assert.equal(publicProgress({ phase: "made-up", turn: 2 }), null);
  assert.equal(publicProgress({ phase: "thinking", turn: -1 }), null);
  assert.deepEqual(publicCompletion({ reasoningTokens: -1, stopReason: "private text", hidden: "private text" }), {});
  for (const phase of ["working", "responding", "journaling", "autonomy"]) assert.deepEqual(publicProgress({ phase, turn: 1, content: "private text" }), { phase, turn: 1 });
});

test("autonomy activity keeps verified state and discards private report fields", () => {
  assert.deepEqual(requestRoute("getActivity"), { method: "GET", path: "/activity" });
  for (const status of ["inactive", "unavailable"]) assert.deepEqual(validateActivity({ autonomy: { status, detail: "private report" } }), { autonomy: { status } });
  for (const kind of ["scan", "routine"]) assert.deepEqual(validateActivity({ autonomy: { status: "running", kind, workspace: "/private", prompt: "private instructions" } }), { autonomy: { status: "running", kind } });
  for (const value of [null, {}, { autonomy: { status: "running" } }, { autonomy: { status: "inactive", kind: "scan" } }, { autonomy: { status: "running", kind: "invented" } }]) assert.throws(() => validateActivity(value));
});
