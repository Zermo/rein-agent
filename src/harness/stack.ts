/** Person-level life stack. Workspace .pi/notes stay project memory. This file is the person. */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SECRET = /(api[_-]?key|secret|password|token|authorization|bearer)\s*[:=]\s*\S|(?:sk|ghp|xox[baprs])-[a-z0-9]|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const BANNED_KEYS = new Set(["token", "secret", "password", "key", "authorization", "apikey", "api_key", "bearer"]);

export function reinHome(home?: string): string {
	return resolve(home ?? (process.env.REIN_HOME || join(homedir(), ".rein")));
}

export function ledgerPath(home?: string): string {
	return join(reinHome(home), "stack", "LEDGER.md");
}

export function accountsPath(home?: string): string {
	return join(reinHome(home), "stack", "accounts.json");
}

function regularText(path: string): string | undefined {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) return undefined;
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function rejectSecret(text: string): void {
	if (SECRET.test(text)) throw new Error("The person ledger and account index do not store secrets. Pass a token to curl or mcp for one call.");
}

export function readLedger(limit = 2000, home?: string): string {
	const path = ledgerPath(home);
	if (!existsSync(path)) return "Person ledger is empty. Do not invent day job, clients, family, accounts, or a resume task. Save a verified fact with stack op=append.";
	const text = regularText(path);
	if (text === undefined) return "Person ledger path is not a regular private file. It was not loaded.";
	const trimmed = text.trim();
	if (!trimmed) return "Person ledger is empty. Do not invent day job, clients, family, accounts, or a resume task. Save a verified fact with stack op=append.";
	return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n[ledger truncated; stack op=read for the rest]` : trimmed;
}

export function appendLedger(plane: "physical" | "digital", content: string, home?: string): string {
	if (plane !== "physical" && plane !== "digital") throw new Error("plane must be physical or digital.");
	if (!content.trim() || content.length > 2000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(content)) throw new Error("content must be 1 to 2000 characters without control characters.");
	rejectSecret(content);
	const path = ledgerPath(home);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const line = `- ${plane}: ${content.trim().replace(/\s+/g, " ")}\n`;
	const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink > 1) throw new Error("The person ledger must be a regular file without hard links.");
		const last = Buffer.alloc(1);
		if (stat.size) readSync(fd, last, 0, 1, stat.size - 1);
		writeFileSync(fd, `${stat.size && last[0] !== 10 ? "\n" : ""}${line}`);
	} finally { closeSync(fd); }
	return path;
}

export interface AccountLabel { name: string; kind: string; host: string; note?: string }

export function listAccounts(home?: string): AccountLabel[] {
	const text = regularText(accountsPath(home));
	if (!text) return [];
	let parsed: unknown;
	try { parsed = JSON.parse(text); }
	catch { throw new Error("accounts.json is not valid JSON. Fix it before listing accounts."); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("accounts.json must be an object.");
	const rows = (parsed as { accounts?: unknown }).accounts;
	if (!Array.isArray(rows)) return [];
	return rows.flatMap(row => {
		if (!row || typeof row !== "object" || Array.isArray(row)) return [];
		const record = row as Record<string, unknown>;
		if (Object.keys(record).some(key => BANNED_KEYS.has(key.toLowerCase()))) return [];
		if (typeof record.name !== "string" || typeof record.kind !== "string" || typeof record.host !== "string") return [];
		return [{ name: record.name, kind: record.kind, host: record.host, ...(typeof record.note === "string" ? { note: record.note } : {}) }];
	});
}

export function addAccount(label: AccountLabel, home?: string): AccountLabel[] {
	for (const key of Object.keys(label)) {
		if (BANNED_KEYS.has(key.toLowerCase())) throw new Error("accounts does not store secrets.");
	}
	if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(label.name)) throw new Error("account name must be a short lowercase label.");
	if (!label.kind.trim() || label.kind.length > 40) throw new Error("kind must be a short label such as openai, mcp, or mail.");
	if (label.note !== undefined && (label.note.length > 200 || SECRET.test(label.note))) throw new Error("note must be a short non-secret description.");
	rejectSecret(`${label.name} ${label.kind} ${label.host} ${label.note ?? ""}`);
	const current = listAccounts(home).filter(row => row.name !== label.name);
	const next = [...current, { name: label.name, kind: label.kind.trim(), host: label.host, ...(label.note ? { note: label.note.trim() } : {}) }];
	const path = accountsPath(home);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify({ accounts: next }, null, 2) + "\n", { mode: 0o600 });
	try { renameSync(temp, path); }
	finally { try { unlinkSync(temp); } catch { /* replaced */ } }
	return next;
}
