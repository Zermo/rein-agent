import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLock, autonomyDirectory, initialState, readState, updateState } from "../src/harness/autonomy/state.ts";

function fixture(t: any) {
	const directory = mkdtempSync(join(tmpdir(), "rein-autonomy-state-"));
	const previous = process.env.REIN_HOME;
	process.env.REIN_HOME = directory;
	mkdirSync(autonomyDirectory());
	t.after(() => {
		if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous;
		rmSync(directory, { recursive: true, force: true });
	});
	const stale = (name = "cycle.lock") => {
		const path = join(autonomyDirectory(), name);
		writeFileSync(path, JSON.stringify({ pid: 2147483647, token: "dead-owner" }));
		utimesSync(path, new Date(0), new Date(0));
		return path;
	};
	return { directory, stale };
}

test("normal dead-owner locks recover automatically while abandoned recovery guards require explicit cleanup", t => {
	const f = fixture(t);
	const path = f.stale();
	const release = acquireLock("cycle");
	assert.ok(release);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
	assert.equal(acquireLock("cycle"), undefined);
	release();
	assert.equal(existsSync(path), false);
	assert.equal(existsSync(`${path}.recovery`), false);
	f.stale(); f.stale("cycle.lock.recovery");
	assert.throws(() => acquireLock("cycle"), /Stop all Rein autonomy processes, remove .*cycle\.lock\.recovery, then retry/);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "dead-owner");
	assert.equal(existsSync(`${path}.recovery`), true);
});

test("simultaneous process recovery has only one owner even while stale unlink is delayed", { timeout: 15000 }, async t => {
	const f = fixture(t);
	const path = f.stale();
	const stateURL = new URL("../src/harness/autonomy/state.ts", import.meta.url).href;
	// Force the old read/unlink race open: every stale-lock deletion pauses long
	// enough for competing processes to reach the same check. Only the recovery
	// guard holder may reach that deletion now.
	const program = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const target = ${JSON.stringify(path)};
const original = fs.unlinkSync;
fs.unlinkSync = function(path) {
  if (path === target && JSON.parse(fs.readFileSync(path, "utf8")).token === "dead-owner") {
    process.send({ deleting: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180);
  }
  return original.apply(this, arguments);
};
syncBuiltinESMExports();
const { acquireLock } = await import(${JSON.stringify(stateURL)});
process.send({ ready: true });
process.once("message", () => {
  try {
    const release = acquireLock("cycle");
    process.send({ acquired: !!release });
    if (!release) process.exit(0);
    const timeout = setTimeout(() => process.exit(2), 5000);
    process.once("message", () => { clearTimeout(timeout); release(); process.exit(0); });
  } catch (error) { process.send({ failure: error.message }); process.exit(1); }
});
`;
	let deletions = 0;
	const children = Array.from({ length: 6 }, () => {
		const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", program], { env: { ...process.env, REIN_HOME: f.directory }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
		let readyResolve!: () => void; let resultResolve!: (value: boolean) => void; let exitResolve!: (value: number | null) => void;
		let reject!: (error: Error) => void;
		const failure = new Promise<never>((_resolve, failed) => { reject = failed; });
		const ready = Promise.race([new Promise<void>(resolve => { readyResolve = resolve; }), failure]);
		const result = Promise.race([new Promise<boolean>(resolve => { resultResolve = resolve; }), failure]);
		const exit = new Promise<number | null>(resolve => { exitResolve = resolve; });
		let stderr = "";
		child.stderr?.on("data", value => { stderr = (stderr + value).slice(-3000); });
		child.on("error", reject);
		child.on("exit", code => { exitResolve(code); if (code !== 0) reject(new Error(`Lock contender exited ${code}: ${stderr}`)); });
		child.on("message", (message: any) => {
			if (message.ready) readyResolve();
			if (message.deleting) deletions++;
			if (typeof message.acquired === "boolean") resultResolve(message.acquired);
			if (message.failure) reject(new Error(message.failure));
		});
		return { child, ready, result, exit };
	});
	t.after(() => { for (const { child } of children) if (child.exitCode === null) child.kill(); });
	await Promise.all(children.map(child => child.ready));
	for (const { child } of children) child.send("acquire");
	const owners = await Promise.all(children.map(child => child.result));
	assert.equal(owners.filter(Boolean).length, 1);
	assert.equal(deletions, 1);
	assert.equal(acquireLock("cycle"), undefined, "the winning child retains exclusive ownership");
	for (const [index, { child }] of children.entries()) if (owners[index]) child.send("release");
	assert.deepEqual(await Promise.all(children.map(child => child.exit)), [0, 0, 0, 0, 0, 0]);
	assert.equal(existsSync(path), false);
	assert.equal(existsSync(`${path}.recovery`), false);
});

test("control revision is backward compatible and accepts only safe nonnegative integers", async t => {
	fixture(t);
	assert.equal(initialState().controlRevision, 0);
	await updateState(state => { state.controlRevision = (state.controlRevision ?? 0) + 1; });
	assert.equal(readState().controlRevision, 1);
	const path = join(autonomyDirectory(), "state.json");
	const legacy = initialState(); delete legacy.controlRevision;
	writeFileSync(path, JSON.stringify(legacy));
	assert.equal(readState().controlRevision, undefined);
	for (const value of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
		writeFileSync(path, JSON.stringify({ ...initialState(), controlRevision: value }));
		assert.throws(readState, /Invalid autonomy control revision/);
	}
});
