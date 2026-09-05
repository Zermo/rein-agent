/** Deterministic workspace state for cross-session recovery. Never generates a summary. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface WorkspaceSnapshotEntry {
	type: "workspace_snapshot";
	id: string;
	timestamp: number;
	/** Stable hash of a Git common directory, or of a non-Git directory. */
	scope: string;
	cwd: string;
	root: string;
	head?: string;
	branch?: string;
	/** Git porcelain rows, bounded to keep session records cheap. */
	status: string[];
	/** Opaque fingerprint of tracked worktree content, used only for checkpoints. */
	state?: string;
}

export interface WorkspaceMemoryRecord {
	sessionId: string;
	snapshot: WorkspaceSnapshotEntry;
	handoff?: string;
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function git(cwd: string, args: string[], maxBuffer = 2 * 1024 * 1024): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, maxBuffer }).trim();
	} catch { return undefined; }
}
function safeRealpath(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
function validRef(value: string | undefined): value is string { return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value); }

/** Same identity across linked worktrees, and a stable directory identity outside Git. */
export function workspaceScope(cwd: string): { scope: string; root: string; git: boolean } {
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!root) {
		const directory = safeRealpath(cwd);
		return { scope: `directory:${digest(directory)}`, root: directory, git: false };
	}
	const common = git(cwd, ["rev-parse", "--git-common-dir"]);
	const shared = common ? safeRealpath(resolve(cwd, common)) : safeRealpath(root);
	return { scope: `git:${digest(shared)}`, root: safeRealpath(root), git: true };
}

export function captureWorkspaceSnapshot(cwd: string): WorkspaceSnapshotEntry {
	const identity = workspaceScope(cwd);
	const head = identity.git ? git(cwd, ["rev-parse", "HEAD"]) : undefined;
	const branch = identity.git ? git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]) : undefined;
	const status = identity.git ? (git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], 256 * 1024)?.split("\n").filter(Boolean).slice(0, 200) ?? []) : [];
	// Raw diff includes the before/after blob ids, so a second edit to an already
	// modified file creates a new checkpoint even when porcelain status is same.
	const raw = identity.git ? git(cwd, ["diff", "--no-ext-diff", "--no-color", "--raw", "HEAD"], 512 * 1024) : undefined;
	const state = identity.git ? digest(`${raw ?? ""}\n${status.join("\n")}`) : undefined;
	return { type: "workspace_snapshot", id: randomUUID(), timestamp: Date.now(), scope: identity.scope, cwd: safeRealpath(cwd), root: identity.root, ...(head ? { head } : {}), ...(branch ? { branch } : {}), status, ...(state ? { state } : {}) };
}

export function sameWorkspaceState(a: WorkspaceSnapshotEntry | undefined, b: WorkspaceSnapshotEntry): boolean {
	return !!a && a.scope === b.scope && a.head === b.head && a.branch === b.branch && a.state === b.state && a.status.join("\n") === b.status.join("\n");
}

/** Matches the existing notes root semantics so shared memory follows linked worktrees. */
export function sharedNotesRoot(cwd: string): string {
	try {
		const commonRaw = git(cwd, ["rev-parse", "--git-common-dir"]);
		if (!commonRaw) return safeRealpath(cwd);
		const common = safeRealpath(resolve(cwd, commonRaw));
		if (common.endsWith(`${sep}.git`)) return dirname(common);
		const worktree = git(cwd, ["--git-dir", common, "config", "--path", "--get", "core.worktree"]);
		return worktree ? safeRealpath(resolve(common, worktree)) : common;
	} catch { return safeRealpath(cwd); }
}

function sharedMemory(cwd: string, maxChars: number): string | undefined {
	const root = sharedNotesRoot(cwd);
	const path = join(root, ".pi", "notes", "MEMORY.md");
	try {
		// This file becomes provider input automatically, so use the same no-link
		// boundary as the notes tool instead of following a workspace-controlled
		// .pi or notes directory elsewhere on disk.
		for (const directory of [root, join(root, ".pi"), join(root, ".pi", "notes")]) {
			const stat = lstatSync(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
		}
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return undefined;
		const text = readFileSync(path, "utf8").trim();
		return text ? text.slice(0, maxChars) : undefined;
	} catch { return undefined; }
}

function trimBlock(label: string, body: string | undefined, remaining: number): string | undefined {
	if (!body?.trim() || remaining < label.length + 64) return undefined;
	const limit = Math.max(0, remaining - label.length - 48);
	return `${label}\n${body.length > limit ? body.slice(0, limit) + "\n[truncated; inspect with git/history]" : body}`;
}
function diff(cwd: string, args: string[]): string | undefined { return git(cwd, args, 2 * 1024 * 1024); }

/**
 * Produces a bounded, factual handoff. The fresh window is the squash point:
 * full transcripts remain separate and recoverable through history.
 */
export function workspaceResumeOverlay(cwd: string, baseline: WorkspaceSnapshotEntry | undefined, peers: WorkspaceMemoryRecord[], maxChars: number): { snapshot: WorkspaceSnapshotEntry; text: string } {
	const current = captureWorkspaceSnapshot(cwd);
	const lines: string[] = [
		"[rein persistent workspace overlay — generated on resume]",
		"This is current workspace evidence and overrides stale assumptions in the archived session. The prior transcript remains isolated in history; do not replay old tool calls. Verify live state before a stateful action.",
		`workspace: ${current.root}`,
		`head: ${current.head ?? "not a Git worktree"}${current.branch ? ` (${current.branch})` : ""}`,
		`working tree: ${current.status.length ? `${current.status.length} changed path(s)` : "clean"}`,
	];
	if (baseline) lines.push(`archived-session checkpoint: ${baseline.head ?? "no Git HEAD"} at ${new Date(baseline.timestamp).toISOString()}`);
	else lines.push("archived-session checkpoint: unavailable (this session predates persistent workspace snapshots)");
	const newest = peers.filter(peer => peer.snapshot.timestamp > (baseline?.timestamp ?? 0)).sort((a, b) => b.snapshot.timestamp - a.snapshot.timestamp)[0];
	if (newest) lines.push(`newest peer checkpoint: ${newest.sessionId} at ${new Date(newest.snapshot.timestamp).toISOString()} (${newest.snapshot.head ?? "no Git HEAD"})`);

	let text = lines.join("\n");
	const add = (label: string, value: string | undefined) => {
		const block = trimBlock(label, value, maxChars - text.length - 2);
		if (block) text += `\n\n${block}`;
	};
	if (baseline && baseline.scope === current.scope && validRef(baseline.head) && validRef(current.head) && baseline.head !== current.head) {
		add("Committed diff since archived-session checkpoint (squashed):", diff(cwd, ["diff", "--no-ext-diff", "--no-color", "--stat", baseline.head, current.head]));
		add("Committed patch since archived-session checkpoint (squashed):", diff(cwd, ["diff", "--no-ext-diff", "--no-color", "--unified=3", baseline.head, current.head]));
	}
	if (current.status.length) {
		add("Current uncommitted paths:", current.status.join("\n"));
		add("Current uncommitted patch (squashed):", diff(cwd, ["diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD"]));
	}
	if (newest?.handoff) add(`Recent peer session handoff (${newest.sessionId}; recorded context, verify it):`, newest.handoff);
	const memory = sharedMemory(cwd, Math.max(0, maxChars - text.length - 300));
	if (memory) add("Durable shared memory (.pi/notes/MEMORY.md; verify it):", memory);
	if (text.length > maxChars) text = text.slice(0, Math.max(0, maxChars - 42)) + "\n[overlay truncated; inspect git/history]";
	return { snapshot: current, text };
}

export function isWorkspaceSnapshot(entry: unknown): entry is WorkspaceSnapshotEntry {
	const item = entry as Partial<WorkspaceSnapshotEntry> | null;
	return !!item && item.type === "workspace_snapshot" && typeof item.id === "string" && typeof item.timestamp === "number" && typeof item.scope === "string" && typeof item.cwd === "string" && typeof item.root === "string" && Array.isArray(item.status) && item.status.every(value => typeof value === "string") && (item.head === undefined || typeof item.head === "string") && (item.branch === undefined || typeof item.branch === "string") && (item.state === undefined || typeof item.state === "string");
}
