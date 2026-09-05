import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requestApproval } from "../src/harness/nodeterm.ts";
import { createRunner } from "../src/harness/runner.ts";

const keys = ["REIN_HOME", "NODETERM_NODE_ID", "NODETERM_HOOK_PORT", "NODETERM_HOOK_SOCK", "NODETERM_PENDING_DIR", "NODETERM_PERM_WAIT_SECS", "NODETERM_NODE_TOKEN_DIR"];
async function isolated(run: (cwd: string, pending: string) => Promise<void>) {
	const cwd = mkdtempSync(join(tmpdir(), "rein-nodeterm-")), pending = join(cwd, "pending");
	const saved = new Map(keys.map(key => [key, process.env[key]]));
	const hook = createServer((req, res) => { req.resume(); res.writeHead(204).end(); });
	await new Promise<void>(resolve => hook.listen(0, "127.0.0.1", resolve));
	try {
		for (const key of keys) delete process.env[key];
		Object.assign(process.env, { REIN_HOME: join(cwd, "home"), NODETERM_NODE_ID: "approval-fixture", NODETERM_HOOK_PORT: String((hook.address() as { port: number }).port), NODETERM_PENDING_DIR: pending });
		await run(cwd, pending);
	} finally {
		for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await new Promise<void>(resolve => { hook.close(() => resolve()); hook.closeAllConnections(); });
		rmSync(cwd, { recursive: true, force: true });
	}
}
async function promptly<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Approval cancellation waited for polling or timeout.")), 300); })]); }
	finally { clearTimeout(timer!); }
}

test("aborted and inactive approvals create no pending request", async () => isolated(async (_cwd, pending) => {
	assert.equal(await requestApproval("bash", { command: "private fixture" }, 45, AbortSignal.abort()), "deny");
	assert.equal(existsSync(pending), false);
	delete process.env.NODETERM_NODE_ID;
	assert.equal(await promptly(requestApproval("bash", { command: "private fixture" })), "timeout");
	assert.equal(existsSync(pending), false);
}));

test("approval abort wins over an unread allow and cleans only its own pending files", async () => isolated(async (_cwd, pending) => {
	const controller = new AbortController();
	const result = requestApproval("bash", { command: "private fixture" }, 45, controller.signal);
	const request = readdirSync(pending).find(name => name.endsWith(".json"))!;
	assert.ok(request);
	const answer = request.replace(/\.json$/, ".answer");
	writeFileSync(join(pending, answer), "allow");
	writeFileSync(join(pending, "another-request.json"), "unrelated request");
	controller.abort();
	assert.equal(await promptly(result), "deny");
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.deepEqual(readdirSync(pending), ["another-request.json"]);
	assert.equal(readFileSync(join(pending, "another-request.json"), "utf8"), "unrelated request");
}));

test("answered and timed-out approvals release abort listeners and pending files", async () => isolated(async (_cwd, pending) => {
	for (const verdict of ["allow", "deny", "timeout"] as const) {
		const controller = new AbortController();
		const result = requestApproval("write", { path: "fixture" }, 1, controller.signal);
		const request = readdirSync(pending).find(name => name.endsWith(".json"))!;
		writeFileSync(join(pending, request.replace(/\.json$/, ".answer")), verdict === "timeout" ? "not an answer" : verdict);
		assert.equal(await result, verdict);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.deepEqual(readdirSync(pending), []);
		controller.abort();
	}
}));

test("runner cancellation interrupts Nodeterm approval without executing or falling back", async t => isolated(async (cwd, pending) => {
	let executions = 0, fallbacks = 0;
	t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { tool_calls: [{ id: "guarded-action", function: { name: "guarded", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
	const runner = await createRunner({ cwd, modelOverride: "approval-fixture", baseUrlOverride: "http://fixture.invalid/v1", toolsMode: "native", maxTurns: 1, autoContext: false, systemPrompt: "Fixture", askTools: ["guarded"], askFallback: async () => { fallbacks++; return true; }, tools: [{ name: "guarded", description: "fixture", parameters: { type: "object" }, execute: async () => { executions++; return { content: "executed" }; } }] });
	const controller = new AbortController();
	const result = runner.run({ role: "user", content: "request fixture", timestamp: Date.now() }, { signal: controller.signal });
	const deadline = Date.now() + 1000;
	while (!existsSync(pending) || !readdirSync(pending).some(name => name.endsWith(".json"))) {
		assert.ok(Date.now() < deadline, "The approval request did not appear.");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	controller.abort();
	await promptly(result);
	assert.equal(executions, 0); assert.equal(fallbacks, 0);
	assert.deepEqual(readdirSync(pending), []);
}));
