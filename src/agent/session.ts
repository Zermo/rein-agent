/**
 * Sessions as append-only JSONL — same shape pi uses:
 *   ~/.rein/sessions/<id>.jsonl
 * Line 1 is the header, then one line per message.
 * Branching = copy the file, append to the copy (pi's v1 behavior).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../agent/agent-loop.ts";

const DIR = join(homedir(), ".rein", "sessions");

export interface SessionHeader {
	type: "header";
	version: 1;
	id: string;
	created: string;
	model?: string;
	provider?: string;
	cwd?: string;
}

function ensureDir() {
	mkdirSync(DIR, { recursive: true });
}

export function newSessionId(): string {
	const d = new Date();
	const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
	const rand = Math.random().toString(36).slice(2, 8);
	return `session-${d.getTime()}-${rand}`;
}

export function sessionPath(id: string): string {
	return join(DIR, `${id}.jsonl`);
}

export function createSession(opts: { id?: string; model?: string; provider?: string; cwd?: string }): string {
	ensureDir();
	const id = opts.id ?? newSessionId();
	const header: SessionHeader = {
		type: "header",
		version: 1,
		id,
		created: new Date().toISOString(),
		model: opts.model,
		provider: opts.provider,
		cwd: opts.cwd,
	};
	const path = sessionPath(id);
	if (existsSync(path)) {
		appendFileSync(path, JSON.stringify(header) + "\n");
		return id;
	}
	appendFileSync(path, JSON.stringify(header) + "\n");
	return id;
}

export function appendMessage(sessionId: string, message: AgentMessage): void {
	ensureDir();
	appendFileSync(sessionPath(sessionId), JSON.stringify(message) + "\n");
}

export function appendEntries(sessionId: string, messages: AgentMessage[]): void {
	for (const m of messages) appendMessage(sessionId, m);
}

export function loadSession(sessionId: string): { header: SessionHeader | null; messages: AgentMessage[] } {
	const path = sessionPath(sessionId);
	if (!existsSync(path)) throw new Error(`No such session: ${sessionId}`);
	const lines = readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0);
	let header: SessionHeader | null = null;
	const messages: AgentMessage[] = [];
	for (const line of lines) {
		try {
			const obj = JSON.parse(line);
			if (obj.type === "header") {
				if (!header) header = obj;
			} else if (obj.role) {
				messages.push(obj);
			}
		} catch {
			// skip torn line from a crash mid-append
		}
	}
	return { header, messages };
}

export interface SessionSummary {
	id: string;
	created: string;
	updated: string;
	provider?: string;
	model?: string;
	cwd?: string;
	messageCount: number;
}

export function listSessions(limit = 20): SessionSummary[] {
	try {
		const files = readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const out: SessionSummary[] = [];
	for (const file of files.reverse()) {
		const id = file.replace(/\.jsonl$/, "");
		const { header, messages } = loadSession(id);
		let updated = header?.created ?? "";
		for (let i = messages.length - 1; i >= 0; i--) {
			const ts = (messages[i] as { timestamp?: number }).timestamp;
			if (typeof ts === "number") {
				updated = new Date(ts).toISOString();
				break;
			}
		}
		out.push({
			id,
			created: header?.created ?? "",
			updated,
			provider: header?.provider,
			model: header?.model,
			cwd: header?.cwd,
			messageCount: messages.length,
		});
	}
	out.sort((a, b) => (a.updated < b.updated ? 1 : -1));
	return out.slice(0, limit);
}

/** Branch: copy the session (or a prefix of it) into a new id. pi semantics. */
export function branchSession(sourceId: string, upToMessageIndex?: number, newId?: string): string {
	const { messages } = loadSession(sourceId);
	const prefix = upToMessageIndex === undefined ? messages : messages.slice(0, upToMessageIndex + 1);
	const id = newId ?? newSessionId();
	ensureDir();
	const path = sessionPath(id);
	const header = JSON.parse(readFileSync(sessionPath(sourceId), "utf8").split("\n")[0] ?? "{}") as SessionHeader;
	appendFileSync(
		path,
		JSON.stringify({ ...header, id, created: new Date().toISOString() }) + "\n",
	);
	for (const m of prefix) appendMessage(id, m);
	return id;
}
