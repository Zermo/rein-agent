import test from "node:test";
import assert from "node:assert/strict";
import { runMeatEngine } from "../src/harness/meat/runtime.ts";

const diff = "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-old_value = 1\n+new_value = 2\n";
const submit = { Content: [{ Type: "tool_use", ID: "submit-1", ToolName: "submit", ToolInput: { remove: [], replace: [], fold: [], summary: "Change the configured value." } }], InputTokens: 12, OutputTokens: 6 };

test("embedded Meat validates a submitted plan and preserves the original diff", async () => {
	let turns = 0;
	const result = await runMeatEngine({ diff, maxTurns: 2, request: async (kind, payload) => {
		assert.equal(kind, "generate"); assert.ok(payload.system.length > 1000);
		assert.ok(payload.tools.some((tool: any) => tool.Name === "submit")); turns++;
		return submit;
	} });
	assert.equal(result.smart_diff, diff);
	assert.equal(result.summary, "Change the configured value.");
	assert.ok(turns > 0 && turns <= 2);
	assert.equal(result.input_tokens, turns * 12);
});

test("Meat rejects a model-authored replacement that invents source text", async () => {
	let sawRejection = false, turns = 0;
	const result = await runMeatEngine({ diff, maxTurns: 3, request: async (_kind, payload) => {
		if (++turns === 1) return { Content: [{ Type: "tool_use", ID: "bad-plan", ToolName: "preview_plan", ToolInput: { remove: [], fold: [], replace: [{ line: 6, old: "new_value = 2", new: "invented_access = true" }] } }] };
		sawRejection ||= JSON.stringify(payload.messages).includes("invalid edit plan");
		return submit;
	} });
	assert.ok(sawRejection);
	assert.doesNotMatch(result.smart_diff, /invented_access/);
});

test("an aborted Meat worker stops without another model call", async () => {
	const controller = new AbortController(); controller.abort();
	await assert.rejects(runMeatEngine({ diff, signal: controller.signal, request: async () => { throw new Error("must not call model"); } }), /abort/i);
});
