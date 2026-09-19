import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createSession, sessionPath, sessionsDir } from "../../agent/session.ts";

export interface KlaudBot {
	id: string;
	name: string;
	sessionId: string;
	created: string;
	computer: "local";
	engine: "openai-compat";
	cwd?: string;
}

const BOT_ID = /^klaud-bot-[0-9a-f]{8}$/;
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;

function botName(value: unknown): string {
	if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error("Invalid bot name: use 1 to 64 characters without control characters.");
	const name = value.trim();
	if (!name || name.length > 64) throw new Error("Invalid bot name: use 1 to 64 characters without control characters.");
	return name;
}

function botHome(home?: string): string {
	return resolve(home ?? (process.env.REIN_HOME || join(homedir(), ".rein")));
}

function checkPath(path: string, directory: boolean): Stats | undefined {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error("rein-klaʊd bot storage must not be a symlink.");
		if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`rein-klaʊd bot storage must be an ordinary ${directory ? "directory" : "file"}.`);
		return stat;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function checkDirectories(home: string): void {
	// OS aliases above the configured home (for example /var) are allowed.
	checkPath(home, true);
	checkPath(join(home, "klaud"), true);
	checkPath(sessionsDir(home), true);
}

function checkStorage(home: string): void {
	checkDirectories(home);
	checkPath(join(home, "klaud", "bots.json"), false);
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function parseBot(value: unknown): KlaudBot {
	const current = hasKeys(value, ["id", "name", "sessionId", "created", "computer", "engine", "cwd"]);
	if (!current && !hasKeys(value, ["id", "name", "sessionId", "created"])) throw new Error("Invalid rein-klaʊd bot registry entry.");
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || !BOT_ID.test(raw.id)
		|| typeof raw.sessionId !== "string" || !SESSION_ID.test(raw.sessionId)
		|| typeof raw.created !== "string" || !Number.isFinite(Date.parse(raw.created))
		|| new Date(raw.created).toISOString() !== raw.created
		|| botName(raw.name) !== raw.name) {
		throw new Error("Invalid rein-klaʊd bot registry entry.");
	}
	let cwd: string | undefined;
	if (current) {
		if (raw.computer !== "local" || raw.engine !== "openai-compat"
			|| typeof raw.cwd !== "string" || !raw.cwd.trim() || raw.cwd.length > 4096
			|| /[\u0000-\u001f\u007f-\u009f]/u.test(raw.cwd)) {
			throw new Error("Invalid rein-klaʊd bot registry entry.");
		}
		cwd = resolve(raw.cwd);
	}
	return { id: raw.id, name: raw.name as string, sessionId: raw.sessionId, created: raw.created, computer: "local", engine: "openai-compat", ...(cwd !== undefined ? { cwd } : {}) };
}

function validateRegistry(value: unknown): asserts value is { version: 1; bots: KlaudBot[] } {
	if (!hasKeys(value, ["version", "bots"]) || value.version !== 1 || !Array.isArray(value.bots)) throw new Error("Invalid rein-klaʊd bot registry.");
	const ids = new Set<string>();
	const sessions = new Set<string>();
	for (const [index, raw] of value.bots.entries()) {
		const bot = parseBot(raw);
		if (ids.has(bot.id) || sessions.has(bot.sessionId)) throw new Error("Invalid rein-klaʊd bot registry entry.");
		ids.add(bot.id);
		sessions.add(bot.sessionId);
		value.bots[index] = bot;
	}
}

export function listBots(home?: string): KlaudBot[] {
	const root = botHome(home);
	checkStorage(root);
	let fd: number;
	try { fd = openSync(join(root, "klaud", "bots.json"), constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	try {
		const registry: unknown = JSON.parse(readFileSync(fd, "utf8"));
		validateRegistry(registry);
		return registry.bots;
	} finally { closeSync(fd); }
}

// Only remove a file we created, and never follow a replaced directory or file.
function removeOwned(home: string, file: string, owned: Stats): void {
	try {
		checkDirectories(home);
		const current = checkPath(file, false);
		if (current?.dev === owned.dev && current.ino === owned.ino) unlinkSync(file);
	} catch { /* Keep the original failure; uncertain ownership leaves the file intact. */ }
}

function lockRegistry(home: string): () => void {
	const file = join(home, "klaud", "bots.json.lock");
	const pause = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 0; attempt < 250; attempt++) {
		checkStorage(home);
		checkPath(file, false);
		let fd: number;
		try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			Atomics.wait(pause, 0, 0, 10);
			continue;
		}
		const owned = fstatSync(fd);
		return () => { closeSync(fd); removeOwned(home, file, owned); };
	}
	throw new Error("Bot registry is busy. Retry after the other writer finishes.");
}

function saveRegistry(home: string, bots: KlaudBot[]): void {
	const file = join(home, "klaud", "bots.json");
	const temp = `${file}.${randomUUID()}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	const owned = fstatSync(fd);
	let staged = true;
	try {
		try {
			writeFileSync(fd, JSON.stringify({ version: 1, bots }, null, 2) + "\n");
			fsyncSync(fd);
		} finally { closeSync(fd); }
		checkStorage(home);
		renameSync(temp, file);
		staged = false;
	} finally {
		if (staged) removeOwned(home, temp, owned);
	}
}

export function createBot(name: string, home?: string, cwd = process.cwd()): KlaudBot {
	const normalizedName = botName(name);
	const root = botHome(home);
	checkStorage(root);
	mkdirSync(join(root, "klaud"), { recursive: true, mode: 0o700 });
	checkStorage(root);
	const unlock = lockRegistry(root);
	try {
		const bots = listBots(root);
		let id = "";
		for (let attempt = 0; attempt < 8; attempt++) {
			const candidate = `klaud-bot-${randomUUID().slice(0, 8)}`;
			if (!bots.some(bot => bot.id === candidate)) { id = candidate; break; }
		}
		if (!id) throw new Error("Could not allocate a unique bot id after repeated collisions.");
		mkdirSync(sessionsDir(root), { recursive: true, mode: 0o700 });
		checkStorage(root);
		const sessionId = createSession({ cwd: resolve(cwd) }, root);
		const file = sessionPath(sessionId, root);
		const owned = checkPath(file, false)!;
		try {
			if (bots.some(bot => bot.sessionId === sessionId)) throw new Error("Bot session id collision.");
			const bot: KlaudBot = { id, name: normalizedName, sessionId, created: new Date().toISOString(), computer: "local", engine: "openai-compat", cwd: resolve(cwd) };
			saveRegistry(root, [...bots, bot]);
			return bot;
		} catch (error) {
			removeOwned(root, file, owned);
			throw error;
		}
	} finally { unlock(); }
}

export function getBot(id: string, home?: string): KlaudBot {
	if (typeof id !== "string" || !BOT_ID.test(id)) throw new Error("Invalid bot id.");
	const bot = listBots(home).find(bot => bot.id === id);
	if (!bot) throw new Error(`No such bot: ${id}`);
	return bot;
}
