import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/rein.js", import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(ready: () => boolean, detail: () => string) {
	const deadline = Date.now() + 8_000;
	while (!ready()) {
		if (Date.now() >= deadline) throw new Error(detail());
		await delay(10);
	}
}

async function terminationFixture(signal: "SIGINT" | "SIGHUP" | "SIGTERM", resistantProvider = false) {
	const cwd = mkdtempSync(join(tmpdir(), "rein-meat-termination-"));
	const bin = join(cwd, "bin"); mkdirSync(bin);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
	writeFileSync(join(cwd, "value.txt"), "old_value = 1\n"); git("add", "value.txt"); git("commit", "-m", "fixture");
	writeFileSync(join(cwd, "value.txt"), "new_value = 2\n");
	// The descendant deliberately closes inherited stdio and ignores TERM.
	// A provider's early exit must not cancel the process group's delayed KILL.
	writeFileSync(join(cwd, "descendant.cjs"), `
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.REIN_TERMINATION_FIXTURE;
process.on('SIGTERM', () => {});
fs.writeFileSync(path.join(root, 'descendant.pid'), String(process.pid));
setTimeout(() => fs.writeFileSync(path.join(root, 'escaped'), 'survived'), 1600);
setInterval(() => {}, 60000);
`);
	writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = process.env.REIN_TERMINATION_FIXTURE;
process.stdin.resume();
if (process.env.REIN_TERMINATION_RESISTANT === '1') process.on('SIGTERM', () => {});
fs.writeFileSync(path.join(root, 'provider.pid'), String(process.pid));
spawn(process.execPath, [path.join(root, 'descendant.cjs')], { stdio: 'ignore' });
setInterval(() => {}, 60000);
`, { mode: 0o700 });
	const env = { ...process.env, PATH: bin + ":" + process.env.PATH, REIN_HOME: join(cwd, "home"), REIN_MODEL: "", REIN_BASE_URL: "", REIN_API: "", REIN_API_KEY: "", REIN_TERMINATION_FIXTURE: cwd, REIN_TERMINATION_RESISTANT: resistantProvider ? "1" : "0", NO_COLOR: "1" };
	for (const key of Object.keys(env)) if (key.startsWith("NODETERM_")) delete env[key];
	const child = spawn(process.execPath, [cli, "meat", "--working-tree", "--provider", "codex", "--json"], { cwd, env });
	let stdout = "", stderr = "", providerPid: number | undefined, descendantPid: number | undefined;
	child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
	child.stdin.end();
	const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal }));
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
	const readPid = (name: string) => {
		const path = join(cwd, name + ".pid");
		if (!existsSync(path)) return undefined;
		const pid = Number(readFileSync(path, "utf8"));
		return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
	};
	try {
		await waitFor(() => !!readPid("provider") && !!readPid("descendant"), () => "Meat provider never started: " + stdout + stderr);
		providerPid = readPid("provider"); descendantPid = readPid("descendant");
		assert.ok(child.kill(signal));
		const result = await completed;
		assert.equal(result.signal, null, stdout + stderr);
		assert.equal(result.code, { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 }[signal], stdout + stderr);
		assert.match(stderr, /Meat review cancelled/);
		assert.equal(stdout.trim(), "", "A cancelled review must not emit a successful result.");
		assert.throws(() => process.kill(providerPid!, 0), /ESRCH/, "The owned provider must be reaped before Rein exits.");
		await delay(1700);
		assert.equal(existsSync(join(cwd, "escaped")), false, "A TERM-resistant provider descendant survived Meat shutdown.");
	} finally {
		clearTimeout(timer); child.kill("SIGKILL");
		providerPid ??= readPid("provider"); descendantPid ??= readPid("descendant");
		if (providerPid) try { process.kill(-providerPid, "SIGKILL"); } catch {}
		if (descendantPid) try { process.kill(descendantPid, "SIGKILL"); } catch {}
		await completed.catch(() => {});
		rmSync(cwd, { recursive: true, force: true });
	}
}

for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"] as const) {
	test(`standalone Meat ${signal} cleans the provider's TERM-resistant descendants`, { timeout: 15_000, skip: process.platform === "win32" }, () => terminationFixture(signal));
}

test("standalone Meat termination kills a TERM-resistant provider and its descendants", { timeout: 15_000, skip: process.platform === "win32" }, () => terminationFixture("SIGTERM", true));
