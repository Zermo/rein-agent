import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { ActivityJournal, activityFile, newActivityId, readActivity } from "../src/harness/activity/store.ts";
import { renderActivity } from "../src/harness/activity/terminal.ts";
import { startCanvas } from "../src/harness/activity/server.ts";
import { createRunner } from "../src/harness/runner.ts";

async function isolated(fn: (cwd: string) => Promise<void>) {
	const cwd = mkdtempSync(join(tmpdir(), "rein-activity-")), saved = process.env.REIN_HOME;
	process.env.REIN_HOME = cwd;
	try { await fn(cwd); } finally { if (saved === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = saved; rmSync(cwd, { recursive: true, force: true }); }
}

test("live activity records real writes and visible responses without changing model context or including thinking text", async t => isolated(async cwd => {
	const id = newActivityId(); let calls = 0;
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string); assert.doesNotMatch(JSON.stringify(body), /REIN \/ ACTIVITY/);
		return Response.json({ choices: [{ message: ++calls === 1 ? { reasoning_content: "PRIVATE_THINKING_SENTINEL", tool_calls: [{ id: "write-fixture", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "output.txt", content: "completed\n" }) } }] } : { content: "The output was written." }, finish_reason: calls === 1 ? "tool_calls" : "stop" }] });
	});
	const runner = await createRunner({ cwd, activityId: id, baseUrlOverride: "http://fixture.invalid/v1", modelOverride: "activity-fixture", toolsMode: "native" });
	const system = runner.systemPrompt;
	await runner.run({ role: "user", content: "Write the output", timestamp: Date.now() });
	const snapshot = readActivity(id)!;
	assert.equal(snapshot.state, "idle"); assert.equal(snapshot.nodes.length, 4); assert.equal(runner.systemPrompt, system);
	const tool = snapshot.nodes.find(node => node.kind === "tool")!;
	assert.equal(tool.title, "write"); assert.equal(tool.path, "output.txt"); assert.equal(tool.status, "done"); assert.equal(tool.parent, snapshot.nodes[1].id);
	assert.equal(readFileSync(join(cwd, "output.txt"), "utf8"), "completed\n");
	assert.doesNotMatch(readFileSync(activityFile(id), "utf8"), /PRIVATE_THINKING_SENTINEL/);
	assert.equal(statSync(activityFile(id)).mode & 0o777, 0o600);
	assert.match(renderActivity(snapshot), /Response/);
}));

test("activity bounds history and terminal output, and marks interrupted nodes cancelled", async () => isolated(async cwd => {
	const journal = new ActivityJournal(newActivityId(), cwd);
	for (let i = 0; i < 300; i++) journal.event({ type: "message_end", message: { role: "user", content: "\x1b[2J" + "漢".repeat(10000), timestamp: Date.now() } });
	journal.event({ type: "agent_start" });
	journal.event({ type: "tool_execution_start", toolCallId: "running", toolName: "bash", args: { command: "sleep 60" } });
	journal.end(true);
	const snapshot = readActivity(journal.snapshot.id)!;
	assert.ok(snapshot.nodes.length <= 256); assert.ok(snapshot.omitted > 0); assert.ok(statSync(activityFile(snapshot.id)).size < 4 * 1024 * 1024);
	assert.equal(snapshot.state, "cancelled"); assert.equal(snapshot.nodes.at(-1)?.status, "cancelled");
	assert.doesNotMatch(renderActivity(snapshot, snapshot.nodes[0].id), /\x1b/);
	assert.throws(() => new ActivityJournal(snapshot.id, cwd), /EEXIST/);
	assert.throws(() => activityFile("../../secret"), /activity ID/);
}));

test("canvas serves only this activity with a local capability token and same-origin checks", async () => isolated(async cwd => {
	const journal = new ActivityJournal(newActivityId(), cwd);
	journal.event({ type: "message_end", message: { role: "user", content: "<script>malicious()</script>", timestamp: Date.now() } }); journal.flush();
	const canvas = await startCanvas(journal.snapshot.id), url = new URL(canvas.url);
	try {
		const page = await fetch(url.origin); assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/); assert.doesNotMatch(await page.text(), /malicious\(\)/);
		assert.equal((await fetch(url.origin + "/events")).status, 401);
		assert.equal((await fetch(url.origin + "/events", { headers: { Authorization: "Bearer " + url.hash.slice(1), Origin: "https://untrusted.invalid" } })).status, 403);
		const foreignHost = await new Promise<number | undefined>((resolve, reject) => { get(url.origin + "/events", { headers: { Host: "untrusted.invalid", Authorization: "Bearer " + url.hash.slice(1) } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject); });
		assert.equal(foreignHost, 403);
		const response = await fetch(url.origin + "/events", { headers: { Authorization: "Bearer " + url.hash.slice(1) } }); assert.equal(response.status, 200); assert.equal((await response.json()).nodes[0].detail, "<script>malicious()</script>");
		assert.equal((await fetch(url.origin + "/events", { method: "POST" })).status, 405);
		writeFileSync(activityFile(journal.snapshot.id), "not json");
		assert.equal((await fetch(url.origin + "/events", { headers: { Authorization: "Bearer " + url.hash.slice(1) } })).status, 500);
	} finally { await canvas.close(); }
}));

test("a successful recovery turn clears the activity error state", async () => isolated(async cwd => {
	const journal = new ActivityJournal(newActivityId(), cwd);
	const response = (error = false): any => ({ role: "assistant", content: [{ type: "text", text: error ? "" : "Recovered" }], stopReason: error ? "error" : "stop", errorMessage: error ? "Context overflow" : undefined, usage: { input: 0, output: 0, totalTokens: 0 }, timestamp: Date.now() });
	journal.event({ type: "agent_start" });
	for (const message of [response(true), response()]) { journal.event({ type: "turn_start" }); journal.event({ type: "message_start", message }); journal.event({ type: "message_end", message }); }
	journal.event({ type: "agent_end", messages: [] }); journal.end();
	assert.equal(readActivity(journal.snapshot.id)?.state, "idle");
	assert.deepEqual(readActivity(journal.snapshot.id)?.nodes.map(node => node.status), ["error", "done"]);
}));
