/** Operator auth links and one-time callback receipts. No notes, no journal. */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowedHttpUrl } from "./net-guard.ts";

export const AUTH_CALLBACK = "https://reinklaud.zermo.org/auth/callback";
const TTL = 15 * 60 * 1000;
const SECRET_KEY = /^(?:code|token|access_token|refresh_token|id_token|client_secret|password|secret)$/i;

export type AuthKind = "oauth" | "manual";
export type AuthCard = {
	id: string;
	kind: AuthKind;
	label: string;
	url: string;
	callback: string;
	state: string;
	status: "waiting" | "arrived";
	created: number;
};
export type OauthSession = { serverUrl?: string; verifier?: string; client?: Record<string, unknown>; discovery?: Record<string, unknown> };
type Stored = AuthCard & OauthSession & { receipt?: Record<string, string> };

function dir(home: string): string {
	const path = join(home, "stack", "auth");
	mkdirSync(path, { recursive: true, mode: 0o700 });
	return path;
}
function file(home: string, id: string): string {
	if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid auth link.");
	return join(dir(home), `${id}.json`);
}
function load(home: string, id: string): Stored {
	const row = JSON.parse(readFileSync(file(home, id), "utf8")) as Stored;
	if (Date.now() - row.created > TTL) {
		try { unlinkSync(file(home, id)); } catch { /* already gone */ }
		throw new Error("Auth link expired.");
	}
	return row;
}
function save(home: string, row: Stored) {
	writeFileSync(file(home, row.id), JSON.stringify(row), { mode: 0o600 });
}
function card(row: Stored): AuthCard {
	return { id: row.id, kind: row.kind, label: row.label, url: row.url, callback: row.callback, state: row.state, status: row.status, created: row.created };
}
function labelOf(value: string): string {
	const text = value.trim();
	if (!text || text.length > 80) throw new Error("label must be 1-80 characters.");
	return text;
}

export function prepareAuthLink(kind: string, label: string, home: string): AuthCard {
	if (kind !== "oauth" && kind !== "manual") throw new Error("kind must be oauth or manual.");
	const id = randomBytes(16).toString("hex");
	const row: Stored = { id, kind, label: labelOf(label), url: "", callback: AUTH_CALLBACK, state: id, status: "waiting", created: Date.now() };
	save(home, row);
	return card(row);
}

export function pushAuthLink(id: string, url: string, home: string): AuthCard {
	const parsed = allowedHttpUrl(url, "auth url");
	for (const key of parsed.searchParams.keys()) if (SECRET_KEY.test(key)) throw new Error("auth url must not carry a token or code.");
	const row = load(home, id);
	row.url = parsed.toString();
	save(home, row);
	return card(row);
}

export function listAuthLinks(home: string): AuthCard[] {
	let names: string[] = [];
	try { names = readdirSync(dir(home)); } catch { return []; }
	const out: AuthCard[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try { out.push(card(load(home, name.slice(0, -5)))); } catch { /* expired */ }
	}
	return out.sort((a, b) => b.created - a.created).slice(0, 8);
}

export function saveOauthSession(id: string, home: string, patch: OauthSession): void {
	const row = load(home, id);
	if (patch.serverUrl !== undefined) row.serverUrl = patch.serverUrl;
	if (patch.verifier !== undefined) row.verifier = patch.verifier;
	if (patch.client !== undefined) row.client = patch.client;
	if (patch.discovery !== undefined) row.discovery = patch.discovery;
	save(home, row);
}
export function readOauthSession(id: string, home: string): OauthSession {
	const row = load(home, id);
	return { serverUrl: row.serverUrl, verifier: row.verifier, client: row.client, discovery: row.discovery };
}
export function clearAuthCode(id: string, home: string): void {
	const row = load(home, id);
	if (row.receipt) delete row.receipt.code;
	save(home, row);
}
export function acceptCallback(search: string, home: string): string {
	const params = new URLSearchParams(search.replace(/^\?/, ""));
	const row = load(home, params.get("state") ?? "");
	const receipt: Record<string, string> = {};
	for (const [key, value] of params) {
		if (key === "state" || key.length > 40 || value.length > 2000 || Object.keys(receipt).length >= 8) continue;
		receipt[key] = value;
	}
	row.receipt = receipt;
	row.status = "arrived";
	save(home, row);
	return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>klaud auth</title></head><body><p>Authorization received. Return to klaud.</p></body></html>";
}

export function readReceipt(id: string, home: string): { id: string; arrived: boolean; fields: Record<string, string> } {
	const row = load(home, id);
	const fields = row.receipt ?? {};
	delete row.receipt;
	save(home, row);
	return { id, arrived: row.status === "arrived", fields };
}
