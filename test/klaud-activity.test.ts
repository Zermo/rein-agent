import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialState, readState } from "../src/harness/autonomy/state.ts";
import type { AutonomyRun, AutonomyState } from "../src/harness/autonomy/state.ts";
import { klaudActivity } from "../src/harness/klaud/activity.ts";

const inactive = { autonomy: { status: "inactive" } };
const unavailable = { autonomy: { status: "unavailable" } };
const privateDetail = "PRIVATE fixture prompt, host and conversation must never be surfaced";

function fixture(t: test.TestContext) {
	const home = mkdtempSync(join(tmpdir(), "rein-activity-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const directory = join(home, "autonomy"), statePath = join(directory, "state.json"), lockPath = join(directory, "cycle.lock");
	const state: AutonomyState = { ...initialState(), lastError: privateDetail, runs: [{ id: "fixture-run", kind: "scan", started: Date.now() - 1000, status: "running", detail: privateDetail }] };
	const save = () => {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
	};
	const lock = (owner: unknown = { pid: process.pid, token: "fixture-owned-cycle" }) => writeFileSync(lockPath, JSON.stringify(owner), { mode: 0o600 });
	return { home, directory, statePath, lockPath, state, save, lock };
}

test("fresh installation observation never creates home, enrollment, config or service state", t => {
	const f = fixture(t), absent = join(f.home, "absent");
	for (let count = 0; count < 3; count++) {
		assert.deepEqual(klaudActivity(absent), inactive);
		assert.deepEqual(klaudActivity(f.home), inactive);
	}
	assert.equal(existsSync(absent), false);
	assert.deepEqual(readdirSync(f.home), []);
	mkdirSync(f.directory, { mode: 0o700 });
	assert.deepEqual(klaudActivity(f.home), inactive);
	assert.deepEqual(readdirSync(f.directory), []);
});

test("a live manual scan is active while autonomy is paused and reveals only its kind", t => {
	const f = fixture(t); f.save(); f.lock();
	const stateBefore = readFileSync(f.statePath), lockBefore = readFileSync(f.lockPath);
	const calls = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
		assert.equal(pid, process.pid); assert.equal(signal, 0); return true;
	});
	assert.equal(f.state.paused, true);
	assert.deepEqual(klaudActivity(f.home), { autonomy: { status: "running", kind: "scan" } });
	assert.equal(calls.mock.callCount(), 1);
	assert.deepEqual(readFileSync(f.statePath), stateBefore);
	assert.deepEqual(readFileSync(f.lockPath), lockBefore);
	assert.deepEqual(readdirSync(f.directory).sort(), ["cycle.lock", "state.json"]);
});

test("active routine uses the most recent valid running record and the configured timeout", t => {
	const f = fixture(t), now = Date.now();
	t.mock.method(Date, "now", () => now);
	f.state.timeoutSeconds = 10;
	f.state.runs = [
		{ id: "stale", kind: "scan", started: now - 10001, status: "running", detail: privateDetail },
		{ id: "routine", kind: "routine", started: now - 1000, status: "running", detail: privateDetail },
	];
	f.save(); f.lock();
	assert.deepEqual(klaudActivity(f.home), { autonomy: { status: "running", kind: "routine" } });
	f.state.runs[1].started = now - 10000; f.save();
	assert.deepEqual(klaudActivity(f.home), inactive, "timeout boundary must stop animation");
	f.state.timeoutSeconds = 1800; f.save();
	assert.deepEqual(klaudActivity(f.home), { autonomy: { status: "running", kind: "routine" } });
});

test("enabled idle services and locks cannot animate without an unended recent running record", t => {
	const f = fixture(t); f.state.paused = false; f.save();
	writeFileSync(join(f.directory, "daemon.lock"), JSON.stringify({ pid: process.pid, token: "daemon" }));
	assert.deepEqual(klaudActivity(f.home), inactive, "a daemon alone does not hold the cycle");
	f.lock();
	for (const runs of [
		[],
		[{ ...f.state.runs[0], status: "success" }],
		[{ ...f.state.runs[0], ended: Date.now() }],
		[{ ...f.state.runs[0], started: Date.now() + 60_000 }],
		[{ ...f.state.runs[0], started: Date.now() - 3600_000 }],
	] as AutonomyRun[][]) {
		f.state.runs = runs; f.save();
		assert.deepEqual(klaudActivity(f.home), inactive);
	}
});

test("a dead cycle owner is inactive and an unverifiable owner is unavailable", t => {
	const f = fixture(t); f.save(); f.lock();
	const kill = t.mock.method(process, "kill", () => { throw Object.assign(new Error(privateDetail), { code: "ESRCH" }); });
	assert.deepEqual(klaudActivity(f.home), inactive);
	kill.mock.mockImplementation(() => { throw Object.assign(new Error(privateDetail), { code: "EPERM" }); });
	assert.deepEqual(klaudActivity(f.home), unavailable);
	assert.equal(JSON.stringify(klaudActivity(f.home)).includes(privateDetail), false);
});

test("invalid or oversized state is unavailable without surfacing its contents", t => {
	const f = fixture(t); f.save(); f.lock();
	for (const value of [privateDetail, JSON.stringify({ ...f.state, timeoutSeconds: 0 }), JSON.stringify({ ...f.state, runs: [{ ...f.state.runs[0], kind: "unknown" }] }), " ".repeat(4_000_001)]) {
		writeFileSync(f.statePath, value);
		assert.deepEqual(klaudActivity(f.home), unavailable);
	}
});

test("invalid and oversized lock owners never trigger process probes", t => {
	const f = fixture(t); f.save();
	const kill = t.mock.method(process, "kill", () => { assert.fail("invalid owner must not be probed"); });
	for (const owner of [null, {}, { pid: -1, token: "bad" }, { pid: 0, token: "bad" }, { pid: 1.5, token: "bad" }, { pid: 2147483648, token: "bad" }, { pid: process.pid }, { pid: process.pid, token: "" }]) {
		f.lock(owner); assert.deepEqual(klaudActivity(f.home), unavailable);
	}
	for (const text of [privateDetail, " ".repeat(1025)]) {
		writeFileSync(f.lockPath, text); assert.deepEqual(klaudActivity(f.home), unavailable);
	}
	assert.equal(kill.mock.callCount(), 0);
});

test("explicit home is isolated from the process default and missing scoped state stays read-only", t => {
	const f = fixture(t), other = fixture(t), previous = process.env.REIN_HOME;
	t.after(() => { if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous; });
	process.env.REIN_HOME = other.home;
	f.save(); f.lock();
	assert.deepEqual(readState(), initialState());
	assert.deepEqual(readState(f.home), f.state);
	assert.deepEqual(klaudActivity(f.home), { autonomy: { status: "running", kind: "scan" } });
	assert.deepEqual(readdirSync(other.home), []);
});

test("symlinked or nonregular state paths are unavailable, including dangling symlinks", t => {
	const f = fixture(t); f.save(); f.lock();
	const original = readFileSync(f.statePath), outside = join(f.home, "target.json");
	writeFileSync(outside, original);
	for (const target of [outside, join(f.home, "missing-target")]) {
		rmSync(f.statePath); symlinkSync(target, f.statePath);
		assert.deepEqual(klaudActivity(f.home), unavailable);
		assert.throws(() => readState(f.home), /bounded regular file/);
	}
	rmSync(f.statePath); mkdirSync(f.statePath);
	assert.deepEqual(klaudActivity(f.home), unavailable);
	assert.deepEqual(readFileSync(outside), original);
});

test("symlinked lock, home and autonomy directories cannot describe active work", t => {
	const f = fixture(t); f.save(); f.lock();
	const otherLock = join(f.home, "outside.lock"); renameSync(f.lockPath, otherLock); symlinkSync(otherLock, f.lockPath);
	assert.deepEqual(klaudActivity(f.home), unavailable);
	rmSync(f.lockPath); renameSync(otherLock, f.lockPath);
	const linkHome = join(f.home, "linked-home"); symlinkSync(f.home, linkHome);
	assert.deepEqual(klaudActivity(linkHome), unavailable);
	const otherDirectory = join(f.home, "other-autonomy"); renameSync(f.directory, otherDirectory); symlinkSync(otherDirectory, f.directory);
	assert.deepEqual(klaudActivity(f.home), unavailable);
	assert.throws(() => readState(f.home), /symbolic link/);
	rmSync(f.directory); writeFileSync(f.directory, "ordinary file");
	assert.deepEqual(klaudActivity(f.home), unavailable);
});

test("linked files and metadata writable by other users are not trusted", t => {
	const f = fixture(t); f.save(); f.lock();
	for (const path of [f.statePath, f.lockPath]) {
		const linked = join(f.home, "linked-file"); linkSync(path, linked);
		assert.deepEqual(klaudActivity(f.home), unavailable); rmSync(linked);
	}
	for (const path of [f.home, f.directory, f.statePath, f.lockPath]) {
		const mode = statSync(path).mode & 0o777;
		chmodSync(path, mode | 0o020);
		assert.deepEqual(klaudActivity(f.home), unavailable);
		chmodSync(path, mode);
	}
	assert.deepEqual(klaudActivity(f.home), { autonomy: { status: "running", kind: "scan" } });
});

test("replacement of a cycle lock during the liveness probe cannot produce a mixed active snapshot", t => {
	const f = fixture(t); f.save(); f.lock();
	t.mock.method(process, "kill", () => {
		renameSync(f.lockPath, join(f.home, "previous.lock"));
		f.lock({ pid: process.pid, token: "different-owner" });
		return true;
	});
	assert.deepEqual(klaudActivity(f.home), unavailable);
});
