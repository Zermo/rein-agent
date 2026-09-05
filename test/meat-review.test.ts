import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runMeatReview, reviewDiff } from "../src/harness/meat/review.ts";
import { createRunner } from "../src/harness/runner.ts";

const diff = "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-old_value = 1\n+new_value = 2\n";
const toolReply = (name: string, args: object) => Response.json({ choices: [{ message: { tool_calls: [{ id: "meat-call", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const submit = () => toolReply("submit", { remove: [], replace: [], fold: [], summary: "Update the value." });
async function isolated(fn: (cwd: string) => Promise<void>) {
	const cwd = mkdtempSync(join(tmpdir(), "rein-meat-host-"));
	const saved = process.env.REIN_HOME; process.env.REIN_HOME = cwd;
	try { await fn(cwd); } finally { if (saved === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = saved; rmSync(cwd, { recursive: true, force: true }); }
}

test("Meat uses explicit Chat Completions connection and reads the requested source lines before truncating", async t => isolated(async cwd => {
	writeFileSync(join(cwd, "value.txt"), "prefix\n".repeat(4000) + "requested-line\n");
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		assert.equal(url, "http://meat-fixture.invalid/v1/chat/completions");
		const body = JSON.parse(init.body as string); assert.equal(body.model, "meat-fixture");
		assert.ok(body.tools.some((tool: any) => tool.function.name === "submit"));
		if (++calls === 1) return toolReply("read_file", { path: "value.txt", start_line: 4001, end_line: 4001 });
		assert.ok(body.messages.some((message: any) => message.role === "tool" && message.content === "requested-line"));
		return submit();
	});
	const result = await runMeatReview({ cwd, diff, modelOverride: "meat-fixture", baseUrlOverride: "http://meat-fixture.invalid/v1", api: "chat-completions", toolsMode: "native" });
	assert.equal(result.smart_diff, diff); assert.equal(calls, 2); assert.equal(result.input_tokens, 20);
}));

test("the agent Meat tool inherits this runner's endpoint and leaves the working tree untouched", async t => isolated(async cwd => {
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
	git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
	writeFileSync(join(cwd, "value.txt"), "old_value = 1\n"); git("add", "value.txt"); git("commit", "-m", "fixture");
	writeFileSync(join(cwd, "value.txt"), "new_value = 2\n");
	writeFileSync(join(cwd, "config.json"), JSON.stringify({ baseUrl: "http://wrong.invalid/v1", model: "wrong" }));
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (url: string) => { calls++; assert.equal(url, "http://active.invalid/v1/chat/completions"); return submit(); });
	const runner = await createRunner({ cwd, baseUrlOverride: "http://active.invalid/v1", modelOverride: "active", toolsMode: "native" });
	const result = await runner.tools.find(tool => tool.name === "meat")!.execute("review", { workingTree: true });
	assert.equal(result.isError, undefined, result.content); assert.ok(calls > 0); assert.match(result.content, /new_value = 2/);
	assert.equal(readFileSync(join(cwd, "value.txt"), "utf8"), "new_value = 2\n");
	await assert.rejects(reviewDiff(cwd, { refs: ["--output=bad"] }), /valid commit refs/);
}));

test("Meat cancellation interrupts an in-flight provider request", async t => isolated(async cwd => {
	const controller = new AbortController(); let providerAborted = false;
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
		init.signal!.addEventListener("abort", () => { providerAborted = true; reject(new Error("fixture cancelled")); }, { once: true });
		controller.abort();
	}));
	await assert.rejects(runMeatReview({ cwd, diff, modelOverride: "fixture", baseUrlOverride: "http://fixture.invalid/v1", signal: controller.signal }), /cancel/i);
	assert.equal(providerAborted, true);
}));
