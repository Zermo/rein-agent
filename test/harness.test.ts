import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { parseArgs, main } from "../src/cli.ts";

const root = new URL("../", import.meta.url).pathname;

test("boolean CLI flags preserve subcommands, short flags, and positional prompts", () => {
	assert.deepEqual(parseArgs(["--json", "--save", "-p", "hello"]), { _: [], flags: { json: true, save: true, p: "hello" } });
	assert.deepEqual(parseArgs(["--json", "hardware"]), { _: ["hardware"], flags: { json: true } });
	assert.deepEqual(parseArgs(["--no-auto-context", "--context-window=4096", "--", "-query"]), { _: ["-query"], flags: { "no-auto-context": true, "context-window": "4096" } });
	assert.equal(parseArgs(["--save=false"]).flags.save, false);
	assert.equal(parseArgs(["-h"]).flags.h, true);
});

test("CLI rejects invalid numeric options before resolving a model", async () => {
	for (const args of [["--max-turns", "garbage"], ["--max-turns", "1x"], ["--context-window", "0"], ["--reserve-tokens", "-1"], ["--temperature"], ["--temperature", "Infinity"], ["--max-iterations", "1.5"], ["--tools", "bad"]]) {
		await assert.rejects(main(args), /must be/);
	}
});

interface ChildResult { code: number | null; stdout: string; stderr: string }
function cli(args: string[], homeDir: string, input?: string): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["bin/rein.js", ...args], {
			cwd: root, env: { ...process.env, HOME: homeDir, REIN_HOME: join(homeDir, ".rein"), REIN_MODEL: "", REIN_BASE_URL: "", NODETERM_API: "", NO_COLOR: "1" },
		});
		let stdout = ""; let stderr = "";
		child.stdout.on("data", (s) => stdout += s);
		child.stderr.on("data", (s) => stderr += s);
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(input ?? "");
	});
}

test("debug CLI errors never echo supplied private filenames", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-debug-cli-"));
	try {
		const result = await cli(["debug", join(dir, "PRIVATE_PATH_SENTINEL"), "--json"], dir);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /missing/);
		assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_PATH_SENTINEL|rein-debug-cli-|ENOENT/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("print/REPL stream, persistence, resume, and JSON errors", { timeout: 20_000 }, async () => {
	const requests: any[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => raw += chunk);
		req.on("end", () => {
			const body = JSON.parse(raw);
			requests.push(body);
			if (body.model === "error-model") {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { message: "test rejection" } }));
				return;
			}
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "unique-answer" } }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const testHome = mkdtempSync(join(tmpdir(), "rein-harness-test-"));
	try {
		const port = (server.address() as { port: number }).port;
		const args = ["--base-url", `http://127.0.0.1:${port}/v1`, "--model", "test-model", "--tools", "native", "--no-tools"];
		const printed = await cli([...args, "--json", "--save", "-p", "first prompt"], testHome);
		assert.equal(printed.code, 0, printed.stderr);
		const events = printed.stdout.trim().split("\n").filter(Boolean).map((s) => JSON.parse(s));
		assert.ok(events.some((e) => e.type === "message_update"), "JSON must expose streaming events");
		assert.ok(events.some((e) => e.type === "agent_end"));
		const dir = join(testHome, ".rein", "sessions");
		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
		const rows = readFileSync(join(dir, file), "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s));
		assert.equal(rows.filter((r) => r.role === "user").length, 1, "save duplicates user prompt");
		assert.equal(rows.filter((r) => r.role === "assistant").length, 1, "save duplicates assistant");
		const resumed = await cli([...args, "--resume", file.replace(/\.jsonl$/, "")], testHome, "/context\nsecond prompt\n/quit\n");
		assert.equal(resumed.code, 0, resumed.stderr);
		assert.equal(resumed.stdout.split("unique-answer").length - 1, 1, "REPL must render streamed text once");
		assert.ok(requests.at(-1).messages.some((m: any) => m.role === "user" && /persistent workspace overlay/.test(m.content)), "resume must load current workspace evidence");
		assert.ok(!requests.at(-1).messages.some((m: any) => m.role === "user" && m.content === "first prompt"), "resume must keep archived history out of the fresh provider window");
		const rotated = await cli([...args, "--resume", file.replace(/\.jsonl$/, "")], testHome, "/resume missing-session\n/new-context carry-forward-marker\nthird prompt\n/quit\n");
		assert.equal(rotated.code, 0, rotated.stderr);
		assert.match(rotated.stdout, /No such session/);
		assert.ok(!requests.at(-1).messages.some((m: any) => m.role === "user" && m.content === "first prompt"), "rollover should hide previous-window prompts");
		assert.match(JSON.stringify(requests.at(-1).messages), /carry-forward-marker/, "manual handoff must reach the new window");
		const errored = await cli([...args, "--model", "error-model", "--json", "-p", "fail"], testHome);
		assert.equal(errored.code, 1, errored.stdout + errored.stderr);
		assert.match(errored.stderr, /test rejection/);
		const missing = await cli([...args, "-p"], testHome);
		assert.equal(missing.code, 2);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(testHome, { recursive: true, force: true });
	}
});

test("print mode returns failure for empty and output-limited responses", { timeout: 15_000 }, async () => {
	const server = createServer((req, res) => {
		let raw = ""; req.on("data", chunk => raw += chunk); req.on("end", () => {
			const body = JSON.parse(raw);
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ choices: [{ message: { content: body.model === "length-fixture" ? "partial answer" : null }, finish_reason: body.model === "length-fixture" ? "length" : "stop" }] }));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const dir = mkdtempSync(join(tmpdir(), "rein-incomplete-"));
	try {
		for (const model of ["empty-fixture", "length-fixture"]) {
			const result = await cli(["--base-url", `http://127.0.0.1:${(server.address() as any).port}/v1`, "--model", model, "--no-tools", "-p", "hello"], dir);
			assert.equal(result.code, 1, result.stdout + result.stderr);
			assert.match(result.stderr, /no usable|before completion/);
		}
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("REPL /stop aborts a running shell and discards queued steering before the next request", { timeout: 15_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "rein-repl-stop-"));
	const requests: any[] = [];
	const server = createServer((req, res) => {
		let raw = ""; req.on("data", chunk => raw += chunk); req.on("end", () => {
			requests.push(JSON.parse(raw));
			res.setHeader("content-type", "application/json");
			const message = requests.length === 1 ? { tool_calls: [{ id: "owned-shell", function: { name: "bash", arguments: JSON.stringify({ command: "printf started > started; sleep 1; printf continued > escaped" }) } }] } : { content: "new request answered" };
			res.end(JSON.stringify({ choices: [{ message, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] }));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	let child: ReturnType<typeof spawn> | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	try {
		const result = await new Promise<ChildResult>((resolve, reject) => {
			child = spawn(process.execPath, [join(root, "bin/rein.js"), "--base-url", `http://127.0.0.1:${(server.address() as any).port}/v1`, "--model", "stop-fixture", "--tools", "native"], { cwd: dir, env: { ...process.env, REIN_HOME: join(dir, "home"), NODETERM_API: "", NO_COLOR: "1" } });
			const timer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
			let stdout = "", stderr = "", answered = false;
			child.stdout!.on("data", data => {
				stdout += data;
				if (!answered && stdout.includes("new request answered")) { answered = true; child!.stdin!.end("/quit\n"); }
			});
			child.stderr!.on("data", data => stderr += data);
			child.on("error", reject);
			child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
			child.stdin!.write("start fixture\n");
			poll = setInterval(() => {
				if (existsSync(join(dir, "started"))) {
					clearInterval(poll); poll = undefined;
					child!.stdin!.write("STALE_QUEUED_REQUEST\n/stop\nNEW_SCOPE\n");
				}
			}, 10);
		});
		assert.equal(result.code, 0, result.stdout + result.stderr);
		assert.equal(requests.length, 2);
		assert.match(JSON.stringify(requests[1]), /NEW_SCOPE/);
		assert.doesNotMatch(JSON.stringify(requests[1]), /STALE_QUEUED_REQUEST/);
		await new Promise(resolve => setTimeout(resolve, 1100));
		assert.equal(existsSync(join(dir, "escaped")), false);
	} finally {
		if (poll) clearInterval(poll); child?.kill("SIGKILL");
		await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true });
	}
});
