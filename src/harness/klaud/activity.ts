/** A read-only, deliberately detail-free view of actual background work. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import { readState } from "../autonomy/state.ts";

export interface KlaudActivity {
	autonomy: { status: "inactive" | "running" | "unavailable"; kind?: "scan" | "routine" };
}

function owned(stat: Stats): void {
	if (typeof process.getuid === "function" && stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) throw new Error("Untrusted autonomy metadata.");
}
function directory(path: string): Stats {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid autonomy directory.");
	owned(stat);
	return stat;
}
function file(stat: Stats, limit: number): void {
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new Error("Invalid autonomy file.");
	owned(stat);
}
function sameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}
function lockOwner(path: string): { pid: number; stat: Stats } {
	const before = lstatSync(path);
	file(before, 1024);
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = fstatSync(fd);
		file(stat, 1024);
		if (!sameFile(before, stat)) throw new Error("Autonomy lock changed.");
		const bytes = Buffer.alloc(1025);
		let size = 0, count: number;
		while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count;
		if (size > 1024) throw new Error("Invalid autonomy lock size.");
		const owner = JSON.parse(bytes.subarray(0, size).toString("utf8"));
		if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 2147483647 || typeof owner.token !== "string" || !owner.token.length || owner.token.length > 128) throw new Error("Invalid autonomy lock owner.");
		return { pid: owner.pid, stat };
	} finally { closeSync(fd); }
}

/** No services are started or state enrolled; a live daemon alone is not work. */
export function klaudActivity(home: string): KlaudActivity {
	const inactive: KlaudActivity = { autonomy: { status: "inactive" } };
	try {
		const root = resolve(home), autonomy = join(root, "autonomy");
		const rootStat = directory(root), directoryStat = directory(autonomy);
		const statePath = join(autonomy, "state.json"), lockPath = join(autonomy, "cycle.lock");
		const stateStat = lstatSync(statePath);
		file(stateStat, 4_000_000);
		const state = readState(root), owner = lockOwner(lockPath);
		const now = Date.now();
		const run = state.runs.filter(item => item.status === "running" && item.ended === undefined && item.started <= now && now - item.started < state.timeoutSeconds * 1000).sort((a, b) => b.started - a.started)[0];
		if (!run) return inactive;
		try { process.kill(owner.pid, 0); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return inactive; throw error; }
		// Refuse a mixed snapshot if ownership paths were replaced while reading.
		const latestState = lstatSync(statePath), latestLock = lstatSync(lockPath);
		file(latestState, 4_000_000); file(latestLock, 1024);
		if (!sameFile(rootStat, directory(root)) || !sameFile(directoryStat, directory(autonomy)) || !sameFile(stateStat, latestState) || !sameFile(owner.stat, latestLock)) throw new Error("Autonomy metadata changed.");
		return { autonomy: { status: "running", kind: run.kind } };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? inactive : { autonomy: { status: "unavailable" } };
	}
}
