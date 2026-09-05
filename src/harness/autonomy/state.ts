/** Private, atomically updated state for the explicitly enabled autonomy service. */
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface Proposal {
	id: string; title: string; kind: "routine" | "loop" | "project"; workspace: string;
	prompt: string; reason: string; evidenceIds: string[]; intervalMinutes: number;
	evidence?: { id: string; sessionId: string; workspace: string; timestamp: number; excerpt: string; role: string }[];
	status: "pending" | "enabled" | "dismissed"; created: number; approvedAt?: number;
	allowWrites: boolean; nextRun?: number;
}
export interface AutonomyRun {
	id: string; kind: "scan" | "routine"; proposalId?: string; started: number; ended?: number;
	status: "running" | "success" | "error" | "cancelled"; detail: string; sessionId?: string;
}
export interface AutonomyState {
	version: 1; paused: boolean; workspaces: string[]; intervalMinutes: number;
	controlRevision?: number;
	maxRunsPerDay: number; maxTurns: number; timeoutSeconds: number;
	lastDigest?: string; nextScan?: number; lastError?: string;
	proposals: Proposal[]; runs: AutonomyRun[];
}
export const autonomyHome = () => resolve(process.env.REIN_HOME || join(homedir(), ".rein"));
export const autonomyDirectory = () => join(autonomyHome(), "autonomy");
export const initialState = (): AutonomyState => ({ version: 1, paused: true, controlRevision: 0, workspaces: [], intervalMinutes: 60, maxRunsPerDay: 6, maxTurns: 8, timeoutSeconds: 180, proposals: [], runs: [] });
export function privateDirectory(): string {
	const directory = autonomyDirectory();
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error("Autonomy state must be an ordinary directory.");
	return directory;
}
function regularFile(path: string, lock = false): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || !lock && stat.nlink !== 1 || stat.size > (lock ? 1024 : 4_000_000)) throw new Error("Autonomy state must be a bounded regular file without links.");
}
export function readState(): AutonomyState {
	if (existsSync(autonomyDirectory()) && lstatSync(autonomyDirectory()).isSymbolicLink()) throw new Error("Autonomy state directory cannot be a symbolic link.");
	const path = join(autonomyDirectory(), "state.json");
	if (!existsSync(path)) return initialState();
	regularFile(path);
	const state = JSON.parse(readFileSync(path, "utf8"));
	return validateState(state);
}
function validateState(state: any): AutonomyState {
	if (state?.version !== 1 || typeof state.paused !== "boolean" || !Array.isArray(state.workspaces) || !state.workspaces.every((p: unknown) => typeof p === "string") || !Array.isArray(state.proposals) || !Array.isArray(state.runs)) throw new Error("Invalid autonomy state. Restore state.json before restarting autonomy.");
	for (const [name, min, max] of [["intervalMinutes", 5, 10080], ["maxRunsPerDay", 1, 100], ["maxTurns", 1, 30], ["timeoutSeconds", 10, 1800]] as const) {
		if (!Number.isSafeInteger(state[name]) || state[name] < min || state[name] > max) throw new Error(`Invalid autonomy ${name}.`);
	}
	const string = (value: unknown, max = 8000) => typeof value === "string" && value.length <= max;
	const time = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	if (state.controlRevision !== undefined && !time(state.controlRevision)) throw new Error("Invalid autonomy control revision.");
	if (state.lastDigest !== undefined && !string(state.lastDigest, 128) || state.nextScan !== undefined && !time(state.nextScan) || state.lastError !== undefined && !string(state.lastError, 1000)) throw new Error("Invalid autonomy checkpoint metadata.");
	if (state.proposals.length > 100 || state.runs.length > 200 || state.workspaces.length > 32) throw new Error("Autonomy state exceeds its record limits.");
	for (const p of state.proposals) {
		if (!p || !string(p.id, 64) || !string(p.title, 120) || !["routine", "loop", "project"].includes(p.kind) || !string(p.workspace, 4096) || !string(p.prompt, 4000) || !string(p.reason, 1200) || !["pending", "enabled", "dismissed"].includes(p.status) || typeof p.allowWrites !== "boolean" || !time(p.created) || p.approvedAt !== undefined && !time(p.approvedAt) || p.nextRun !== undefined && !time(p.nextRun) || !Number.isSafeInteger(p.intervalMinutes) || p.intervalMinutes < 60 || p.intervalMinutes > 10080 || !Array.isArray(p.evidenceIds) || p.evidenceIds.length > 12 || !p.evidenceIds.every((id: unknown) => string(id, 256))) throw new Error("Invalid autonomy proposal record.");
		if (p.evidence !== undefined && (!Array.isArray(p.evidence) || p.evidence.length > 12 || !p.evidence.every((e: any) => e && string(e.id, 256) && string(e.sessionId, 160) && string(e.workspace, 4096) && string(e.excerpt, 1400) && ["user", "assistant"].includes(e.role) && time(e.timestamp)))) throw new Error("Invalid autonomy evidence record.");
	}
	for (const run of state.runs) {
		if (!run || !string(run.id, 64) || !["scan", "routine"].includes(run.kind) || !["running", "success", "error", "cancelled"].includes(run.status) || !time(run.started) || run.ended !== undefined && !time(run.ended) || !string(run.detail)) throw new Error("Invalid autonomy run record.");
	}
	return state as AutonomyState;
}
function deadLockOwner(path: string, minimumAge: number): boolean {
	try {
		regularFile(path, true);
		const owner = JSON.parse(readFileSync(path, "utf8"));
		if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== "string" || Date.now() - statSync(path).mtimeMs < minimumAge) return false;
		try { process.kill(owner.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
	} catch { return false; }
}
function releaseOwnedLock(path: string, token: string): void {
	try { regularFile(path, true); if (JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path); } catch {}
}
/** Lock ownership is checked on release. Only dead, old locks are reclaimed. */
export function acquireLock(name: "state" | "cycle" | "daemon"): (() => void) | undefined {
	const path = join(privateDirectory(), `${name}.lock`);
	const token = randomUUID();
	const temp = `${path}.${token}.tmp`;
	// Publish an already complete record atomically. A crash cannot leave an
	// empty lock whose owner cannot be checked for liveness.
	writeFileSync(temp, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
	try {
		try {
			linkSync(temp, path);
			return () => releaseOwnedLock(path, token);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (!deadLockOwner(path, 60_000)) return undefined;
		const recovery = `${path}.recovery`;
		try { linkSync(temp, recovery); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// The recovery mutex is deliberately never reclaimed automatically.
			// Recursive stale-mutex deletion would reproduce the original race.
			if (deadLockOwner(recovery, 0)) throw new Error(`Autonomy lock recovery was interrupted. Stop all Rein autonomy processes, remove ${recovery}, then retry.`);
			return undefined;
		}
		try {
			// A contender may have replaced the stale lock before we obtained the
			// recovery guard. Recheck while every other reclaimer is excluded.
			if (!deadLockOwner(path, 60_000)) return undefined;
			unlinkSync(path);
			try { linkSync(temp, path); }
			catch (error) {
				// A normal acquisition can win the unlink/publication gap. It owns
				// the lock; never remove that new owner's record or retry deletion.
				if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
				throw error;
			}
			return () => releaseOwnedLock(path, token);
		} finally { releaseOwnedLock(recovery, token); }
	} finally { try { unlinkSync(temp); } catch {} }
}
export async function updateState(change: (state: AutonomyState) => void): Promise<AutonomyState> {
	let unlock: (() => void) | undefined;
	for (let attempt = 0; attempt < 50 && !unlock; attempt++) {
		unlock = acquireLock("state");
		if (!unlock) await new Promise(resolve => setTimeout(resolve, 100));
	}
	if (!unlock) throw new Error("Autonomy state is busy. Try again shortly.");
	const temp = join(autonomyDirectory(), `state-${randomUUID()}.tmp`);
	try {
		const state = readState(); change(state);
		state.runs = state.runs.slice(-200);
		validateState(state);
		writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		renameSync(temp, join(autonomyDirectory(), "state.json"));
		return state;
	} finally { try { unlinkSync(temp); } catch {} unlock(); }
}
export function canonicalWorkspace(path: string): string {
	const canonical = realpathSync(resolve(path));
	if (!statSync(canonical).isDirectory()) throw new Error("Workspace must be a directory.");
	return canonical;
}
export const runsToday = (state: AutonomyState, now = Date.now()) => state.runs.filter(run => run.started >= now - 86_400_000).length;
export const proposalId = (draft: Pick<Proposal, "title" | "kind" | "workspace">) => createHash("sha256").update(`${draft.workspace}\n${draft.kind}\n${draft.title.trim().toLowerCase()}`).digest("hex").slice(0, 16);
export async function decideProposal(id: string, status: "enabled" | "dismissed", allowWrites = false): Promise<void> {
	await updateState(state => {
		const proposal = state.proposals.find(p => p.id === id);
		if (!proposal) throw new Error("Unknown proposal. Use rein autonomy status to list proposal IDs.");
		proposal.status = status;
		proposal.allowWrites = status === "enabled" && allowWrites;
		proposal.approvedAt = status === "enabled" ? Date.now() : undefined;
		proposal.nextRun = status === "enabled" ? Date.now() : undefined;
	});
}
