/** Append-only JSONL sessions. Legacy message-only files remain readable. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { AgentMessage } from "./agent-loop.ts";
import { isWorkspaceSnapshot } from "./workspace.ts";
import type { WorkspaceSnapshotEntry, WorkspaceMemoryRecord } from "./workspace.ts";

export interface SessionHeader {
	type: "header";
	version: 1;
	id: string;
	created: string;
	model?: string;
	provider?: string;
	cwd?: string;
}
export type StoredMessage = AgentMessage & { id: string };
export interface ContextWindowEntry {
	type: "context_window";
	id: string;
	timestamp: number;
	/** Index into the complete message transcript where the active window starts. */
	start: number;
	handoff?: string;
	reason: "manual" | "tool" | "threshold" | "overflow" | "resume";
}
export interface ReminderEntry {
	type: "posthorse-reminder";
	id: string;
	timestamp: number;
	windowId: string;
	contextWindow: number;
	reserveTokens: number;
}
export type SessionEntry = StoredMessage | ContextWindowEntry | ReminderEntry | WorkspaceSnapshotEntry;
export const sessionsDir = () => join(process.env.REIN_HOME || join(homedir(), ".rein"), "sessions");
export function newSessionId(): string { return `session-${Date.now()}-${randomUUID().slice(0, 8)}`; }
export function sessionPath(id: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(id)) throw new Error("Invalid session id. Use the full id from /sessions.");
	return join(sessionsDir(), `${id}.jsonl`);
}
export function createSession(opts: { id?: string; model?: string; provider?: string; cwd?: string }): string {
	mkdirSync(sessionsDir(), { recursive: true });
	const id = opts.id ?? newSessionId();
	const header: SessionHeader = { ...opts, type: "header", version: 1, id, created: new Date().toISOString() };
	writeFileSync(sessionPath(id), JSON.stringify(header) + "\n", { flag: "wx", mode: 0o600 });
	return id;
}
export function appendSessionEntry(sessionId: string, entry: SessionEntry): void {
	const path = sessionPath(sessionId);
	if (!existsSync(path)) throw new Error(`No such session: ${sessionId}`);
	// A leading newline isolates a torn last record after a crash without rewriting history.
	appendFileSync(path, "\n" + JSON.stringify(entry) + "\n");
}
export function appendMessage(sessionId: string, message: AgentMessage): void {
	appendSessionEntry(sessionId, { ...message, id: (message as StoredMessage).id ?? randomUUID() });
}
export function appendEntries(sessionId: string, messages: AgentMessage[]): void {
	for (const message of messages) appendMessage(sessionId, message);
}
export function windowMessage(window: ContextWindowEntry): AgentMessage {
	return { role: "user", timestamp: window.timestamp, content: `[posthorse] Fresh context window ${window.id}. Earlier conversation is in history. Restore notes and verify live state before acting.\n${window.handoff ?? "No handoff supplied. Recover the task from notes and history before continuing."}` };
}
/** Failed responses remain in history, but never become provider input. */
export function providerMessages(messages: AgentMessage[]): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "toolResult") continue; // Orphaned results cannot be replayed.
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) continue;
		out.push(message);
		if (message.role !== "assistant") continue;
		const calls = message.content.filter(part => part.type === "toolCall");
		if (!calls.length) continue;
		const results = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
		while (messages[index + 1]?.role === "toolResult") {
			const result = messages[++index] as Extract<AgentMessage, { role: "toolResult" }>;
			results.set(result.toolCallId, result);
		}
		for (const call of calls) out.push(results.get(call.id) ?? {
			role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true, timestamp: message.timestamp,
			content: [{ type: "text", text: "No tool result was recorded before this session was interrupted or branched. Execution outcome is unknown. Inspect live state before retrying any action." }],
		});
	}
	return out;
}
/** Boundaries cannot divide an assistant tool batch. */
export function validWindowStart(messages: AgentMessage[], start: number): boolean {
	if (!Number.isSafeInteger(start) || start < 0 || start > messages.length) return false;
	const pending = new Set<string>();
	for (const message of messages.slice(0, start)) {
		// A resumed turn closes an earlier interrupted batch in provider replay.
		if (message.role !== "toolResult") pending.clear();
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
			for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
		} else if (message.role === "toolResult") pending.delete(message.toolCallId);
	}
	return pending.size === 0 && messages[start]?.role !== "toolResult";
}
export function loadSession(sessionId: string): { header: SessionHeader | null; messages: StoredMessage[]; entries: SessionEntry[]; window?: ContextWindowEntry; activeMessages: AgentMessage[] } {
	const path = sessionPath(sessionId);
	if (!existsSync(path)) throw new Error(`No such session: ${sessionId}`);
	let header: SessionHeader | null = null;
	const messages: StoredMessage[] = [];
	const entries: SessionEntry[] = [];
	let window: ContextWindowEntry | undefined;
	for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line);
			if (!obj || typeof obj !== "object") continue;
			if (obj.type === "header") { if (!header) header = obj; continue; }
			// Stable legacy ids survive whole-session forks, which copy entries with their ids.
			const id = typeof obj.id === "string" ? obj.id : `legacy-${createHash("sha256").update(`${sessionId}:${index}:${line}`).digest("hex").slice(0, 24)}`;
			if (["user", "assistant", "toolResult"].includes(obj.role)) {
				if (obj.role === "user" ? typeof obj.content !== "string" : !Array.isArray(obj.content)) continue;
				if (obj.role !== "user" && !obj.content.every((part: any) => part && typeof part === "object" && (
					(part.type === "text" && typeof part.text === "string") ||
					(obj.role === "assistant" && part.type === "thinking" && typeof part.thinking === "string") ||
					(obj.role === "assistant" && part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string" && part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments))
				))) continue;
				const message = { ...obj, id } as StoredMessage;
				messages.push(message); entries.push(message);
			} else if (obj.type === "context_window" && validWindowStart(messages, obj.start) && obj.start >= (window?.start ?? 0) && (obj.handoff === undefined || typeof obj.handoff === "string") && ["manual", "tool", "threshold", "overflow", "resume"].includes(obj.reason)) {
				window = { ...obj, id }; entries.push(window!);
			} else if (obj.type === "posthorse-reminder") entries.push({ ...obj, id });
			else if (isWorkspaceSnapshot(obj)) entries.push(obj);
		} catch { /* Ignore incomplete records from interrupted writes. */ }
	}
	return { header, messages, entries, window, activeMessages: providerMessages(window ? [windowMessage(window), ...messages.slice(window.start)] : [...messages]) };
}

export function latestWorkspaceSnapshot(entries: SessionEntry[]): WorkspaceSnapshotEntry | undefined {
	return entries.filter(isWorkspaceSnapshot).at(-1);
}

/** Recent peer checkpoints and their explicit Posthorse handoffs for one repository. */
export function workspaceMemoryRecords(scope: string, excludeSessionId?: string, limit = 8): WorkspaceMemoryRecord[] {
	const records: WorkspaceMemoryRecord[] = [];
	for (const session of listSessions(Number.MAX_SAFE_INTEGER)) {
		if (session.id === excludeSessionId) continue;
		try {
			const loaded = loadSession(session.id);
			const snapshot = latestWorkspaceSnapshot(loaded.entries);
			if (!snapshot || snapshot.scope !== scope) continue;
			const handoff = loaded.entries.filter((entry): entry is ContextWindowEntry => "type" in entry && entry.type === "context_window").at(-1)?.handoff;
			records.push({ sessionId: session.id, snapshot, ...(handoff ? { handoff } : {}) });
		} catch { /* One stale or corrupt peer must not block resume. */ }
	}
	return records.sort((a, b) => b.snapshot.timestamp - a.snapshot.timestamp).slice(0, limit);
}
export interface SessionSummary {
	id: string; created: string; updated: string; provider?: string; model?: string; cwd?: string; messageCount: number;
}
export function listSessions(limit = 20): SessionSummary[] {
	let files: string[];
	try { files = readdirSync(sessionsDir()).filter(f => f.endsWith(".jsonl")); } catch { return []; }
	const out: SessionSummary[] = [];
	for (const file of files) {
		try {
			const id = file.slice(0, -6);
			const { header, messages } = loadSession(id);
			out.push({ id, created: header?.created ?? "", updated: statSync(sessionPath(id)).mtime.toISOString(), provider: header?.provider, model: header?.model, cwd: header?.cwd, messageCount: messages.length });
		} catch { /* A corrupt or concurrently removed session must not hide the others. */ }
	}
	return out.sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, limit);
}
/** Fork preserves entry ids and boundaries, including when branching before a rollover. */
export function branchSession(sourceId: string, upToMessageIndex?: number, newId?: string): string {
	const { header, entries, messages } = loadSession(sourceId);
	if (upToMessageIndex !== undefined && (!Number.isInteger(upToMessageIndex) || upToMessageIndex < 0 || upToMessageIndex >= messages.length)) throw new Error("Invalid branch message index");
	const id = createSession({ model: header?.model, provider: header?.provider, cwd: header?.cwd, id: newId });
	let count = 0;
	for (const entry of entries) {
		if (upToMessageIndex !== undefined && count > upToMessageIndex && "role" in entry) break;
		appendSessionEntry(id, entry);
		if ("role" in entry) count++;
	}
	return id;
}
