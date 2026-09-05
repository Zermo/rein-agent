import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TmuxShells } from "../src/harness/tmux.ts";

const cli = fileURLToPath(new URL("../bin/rein.js", import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(ready: () => boolean, detail: () => string) {
	const deadline = Date.now() + 8_000;
	while (!ready()) {
		if (Date.now() >= deadline) throw new Error(detail());
		await delay(10);
	}
}

async function terminationFixture(mode: "print" | "repl", signal: "SIGHUP" | "SIGTERM", persistent = false) {
	const cwd = mkdtempSync(join(tmpdir(), "rein-termination-")), home = join(cwd, "home");
	const savedHome = process.env.REIN_HOME;
	process.env.REIN_HOME = home;
	const shells = new TmuxShells(cwd);
	if (savedHome === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = savedHome;
	let requests = 0;
	const server = createServer((req, res) => {
		req.resume(); req.on("end", () => {
			requests++;
			const commands = [
				...(persistent ? [{ command: "printf started > persistent-started; sleep 30", mode: "tmux" }] : []),
				// TERM-resistant descendants must reach the shell tool's delayed KILL
				// cleanup; terminating the CLI immediately would leave this marker.
				{ command: "trap '' TERM; printf '%s' \"$$\" > foreground.pid; (trap '' TERM; exec >/dev/null 2>&1; sleep 1; printf escaped > escaped) & wait" },
			];
			const message = requests === 1
				? { tool_calls: commands.map((args, index) => ({ id: `shell-${index}`, type: "function", function: { name: "bash", arguments: JSON.stringify(args) } })) }
				: { content: "finished" };
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ choices: [{ message, finish_reason: requests === 1 ? "tool_calls" : "stop" }] }));
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const env = { ...process.env, REIN_HOME: home, REIN_MODEL: "", REIN_BASE_URL: "", REIN_API: "chat-completions", REIN_API_KEY: "", NO_COLOR: "1" };
	for (const key of Object.keys(env)) if (key.startsWith("NODETERM_")) delete env[key];
	const child = spawn(process.execPath, [cli, "--base-url", `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, "--model", "termination-fixture", "--tools", "native", ...(mode === "print" ? ["-p", "start fixture"] : [])], { cwd, env });
	let stdout = "", stderr = "", pid: number | undefined;
	child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
	const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal }));
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
	try {
		if (mode === "repl") child.stdin.write("start fixture\n"); else child.stdin.end();
		await waitFor(() => existsSync(join(cwd, "foreground.pid")) && !!readFileSync(join(cwd, "foreground.pid"), "utf8"), () => "Foreground tool never started: " + stdout + stderr);
		pid = Number(readFileSync(join(cwd, "foreground.pid"), "utf8"));
		assert.ok(Number.isSafeInteger(pid) && pid > 1);
		if (persistent) await waitFor(() => existsSync(join(cwd, "persistent-started")), () => "Persistent shell never started: " + stdout + stderr);
		assert.ok(child.kill(signal));
		const result = await completed;
		assert.equal(result.signal, null, stdout + stderr);
		assert.equal(result.code, signal === "SIGHUP" ? 129 : 143, stdout + stderr);
		assert.throws(() => process.kill(pid!, 0), /ESRCH/, "The owned foreground shell must be reaped before the CLI exits.");
		await delay(1100);
		assert.equal(existsSync(join(cwd, "escaped")), false, "A detached descendant survived shutdown.");
		assert.equal(requests, 1, "Termination must not start another model turn.");
		if (persistent) assert.equal((await shells.list()).length, 1, "Intentional persistent tmux sessions must survive harness shutdown.");
	} finally {
		clearTimeout(timer); child.kill("SIGKILL");
		if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
		if (persistent) for (const session of await shells.list()) await shells.stop(session.id);
		await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
		rmSync(cwd, { recursive: true, force: true });
	}
}

for (const mode of ["print", "repl"] as const) for (const signal of ["SIGHUP", "SIGTERM"] as const) {
	test(`${mode} ${signal} waits for foreground process-group cleanup`, { timeout: 15_000, skip: process.platform === "win32" }, () => terminationFixture(mode, signal));
}

test("harness termination preserves intentional persistent tmux sessions", { timeout: 15_000, skip: process.platform === "win32" || spawnSync("tmux", ["-V"]).status !== 0 }, () => terminationFixture("print", "SIGTERM", true));
