import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("CLI setup forwards flags, discovers authenticated model, and saves a runnable configuration", { timeout: 15000 }, async () => {
	const directory = mkdtempSync(join(tmpdir(), "rein-setup-cli-"));
	const paths: string[] = [];
	const server = createServer(async (req, res) => {
		paths.push(req.url!);
		assert.equal(req.headers.authorization, "Bearer fixture-key");
		res.setHeader("content-type", "application/json");
		if (req.method === "GET") { res.end(JSON.stringify({ data: [{ id: "actual-model-id" }] })); return; }
		let raw = ""; for await (const chunk of req) raw += chunk;
		assert.equal(JSON.parse(raw).model, "actual-model-id");
		res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const cli = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/rein.js", import.meta.url)), ...args], {
			cwd: directory, env: { ...process.env, REIN_HOME: directory, REIN_BASE_URL: "", REIN_MODEL: "", REIN_API_KEY: "fixture-key", NODETERM_API: "" },
		});
		let stdout = "", stderr = "";
		child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
		child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end();
	});
	try {
		const result = await cli(["setup", "--yes", "--provider", "custom", "--base-url", `127.0.0.1:${(server.address() as any).port}`, "--auth", "api-key"]);
		assert.equal(result.code, 0, result.stdout + result.stderr);
		assert.deepEqual(paths, ["/v1/models", "/v1/chat/completions"]);
		const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
		assert.equal(config.model, "actual-model-id"); assert.equal(config.apiKey, undefined);
		assert.doesNotMatch(result.stdout + result.stderr, /fixture-key/);
		const print = await cli(["--no-tools", "-p", "hello"]);
		assert.equal(print.code, 0, print.stderr); assert.match(print.stdout, /ok/);
		const invalid = await cli(["setup", "--yes", "--ssh"]);
		assert.equal(invalid.code, 1); assert.match(invalid.stderr, /--ssh must have a value/);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
