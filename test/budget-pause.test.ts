import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeDebugFolder } from "../src/harness/debug.ts";

const root = new URL("../", import.meta.url).pathname;
function cli(home: string, args: string[], input = "") {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [join(root, "bin/rein.js"), ...args], { cwd: home, env: { ...process.env, HOME: home, REIN_HOME: join(home, ".rein"), REIN_MODEL: "", REIN_BASE_URL: "", NODETERM_NODE_ID: "", NODETERM_API: "", NO_COLOR: "1" } });
		let stdout = "", stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
		child.on("error", error => { clearTimeout(timer); reject(error); }); child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }); child.stdin.end(input);
	});
}

test("print budget pause saves exact Posthorse boundaries without --save and resumes successfully", { timeout: 20_000 }, async () => {
	const requests: any[] = [];
	const server = createServer((request, response) => {
		let raw = ""; request.on("data", chunk => raw += chunk); request.on("end", () => {
			const body = JSON.parse(raw); requests.push(body);
			const continuing = body.messages.some((message: any) => message.role === "user" && message.content === "continue");
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ choices: [{ message: continuing ? { content: "Continued task finished." } : { content: "Checkpointing the completed work.", tool_calls: [{ id: "checkpoint", type: "function", function: { name: "new_context", arguments: JSON.stringify({ handoff: "LATEST_CHECKPOINT_MARKER: next inspect the remaining work." }) } }] }, finish_reason: continuing ? "stop" : "tool_calls" }] }));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const directory = mkdtempSync(join(tmpdir(), "rein-budget-pause-"));
	try {
		const args = ["--base-url", `http://127.0.0.1:${(server.address() as any).port}/v1`, "--model", "budget-fixture", "--tools", "native", "--max-turns", "1"];
		const paused = await cli(directory, [...args, "--json", "-p", "continue the multi-step task"]);
		assert.equal(paused.code, 3, paused.stdout + paused.stderr); assert.match(paused.stderr, /\[PAUSED\].*after 1 model turns/);
		assert.match(paused.stderr, /Session saved\. Run: rein --resume session-/); assert.doesNotMatch(paused.stderr, /Harness stopped|Error:/);
		const events = paused.stdout.trim().split("\n").map(line => JSON.parse(line));
		assert.equal(events.filter(event => event.type === "agent_pause").length, 1);
		const sessions = join(directory, ".rein", "sessions"), files = readdirSync(sessions); assert.equal(files.length, 1);
		const records = readFileSync(join(sessions, files[0]), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
		assert.equal(records.filter(entry => entry.role === "toolResult").length, 1); assert.equal(records.find(entry => entry.role === "toolResult").isError, false);
		assert.equal(records.filter(entry => entry.role === "assistant" && entry.stopReason === "budget").length, 1);
		assert.equal(records.filter(entry => entry.type === "context_window").length, 1);
		assert.match(records.find(entry => entry.type === "context_window").handoff, /LATEST_CHECKPOINT_MARKER/);
		const report = await analyzeDebugFolder(sessions);
		assert.equal(report.totals.budgetPauses, 1); assert.equal(report.totals.providerErrors, 0); assert.equal(report.totals.harnessStops, 0); assert.equal(report.totals.maxTurnsPerRequest, 1);
		const resumed = await cli(directory, [...args, "--resume", files[0].replace(/\.jsonl$/, "")], "continue\n/quit\n");
		assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr); assert.match(resumed.stdout, /Continued task finished/);
		assert.match(resumed.stdout, /Turn budget: 1 model turns per request/);
		assert.match(JSON.stringify(requests.at(-1).messages), /LATEST_CHECKPOINT_MARKER/);
		assert.equal(requests.at(-1).messages.some((message: any) => message.stopReason === "budget"), false);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
