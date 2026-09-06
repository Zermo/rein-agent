import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

export type KlaudDensity = "compact" | "regular" | "roomy";
export type KlaudAccent = "rain" | "slate" | "storm";
export type KlaudTray = "hidden" | "quiet" | "normal";

export interface KlaudTheme {
	accent: KlaudAccent;
	density: KlaudDensity;
	dark: boolean;
}

export interface KlaudChrome {
	sidebar: boolean;
	tray: KlaudTray;
	showActivity: boolean;
}

export interface KlaudShell {
	version: 1;
	theme: KlaudTheme;
	chrome: KlaudChrome;
}

export const DEFAULT_KLAUD_SHELL: KlaudShell = {
	version: 1,
	theme: { accent: "rain", density: "regular", dark: true },
	chrome: { sidebar: true, tray: "normal", showActivity: true },
};

export interface JsonPatchOp {
	op: "add" | "remove" | "replace" | "test";
	path: string;
	value?: unknown;
}

export interface KlaudSharedState {
	shell: KlaudShell;
	prefs: { lastBotId?: string };
	bots: Array<{ id: string; name: string; sessionId: string }>;
	approvals: Array<{ id: string; tool: string; summary: string }>;
}

export const KLAUD_SHELL_POINTERS = [
	"/theme/accent", "/theme/density", "/theme/dark",
	"/chrome/sidebar", "/chrome/tray", "/chrome/showActivity",
] as const;

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validateShell(value: unknown): asserts value is KlaudShell {
	if (!hasKeys(value, ["version", "theme", "chrome"]) || value.version !== 1
		|| !hasKeys(value.theme, ["accent", "density", "dark"])
		|| !hasKeys(value.chrome, ["sidebar", "tray", "showActivity"])
		|| !["rain", "slate", "storm"].includes(value.theme.accent as string)
		|| !["compact", "regular", "roomy"].includes(value.theme.density as string)
		|| typeof value.theme.dark !== "boolean"
		|| !["hidden", "quiet", "normal"].includes(value.chrome.tray as string)
		|| typeof value.chrome.sidebar !== "boolean" || typeof value.chrome.showActivity !== "boolean") {
		throw new Error("Invalid rein-klaʊd shell schema.");
	}
}

function cloneShell(shell: KlaudShell): KlaudShell {
	return { version: 1, theme: { ...shell.theme }, chrome: { ...shell.chrome } };
}

export function klaudShellPath(home?: string): string {
	return join(resolve(home ?? (process.env.REIN_HOME || join(homedir(), ".rein"))), "klaud", "shell.json");
}

function checkPath(path: string, directory: boolean): void {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error("rein-klaʊd storage must not be a symlink.");
		if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`rein-klaʊd storage must be an ordinary ${directory ? "directory" : "file"}.`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function checkStorage(file: string): void {
	// Ancestors above REIN_HOME may use OS aliases such as macOS /var.
	checkPath(dirname(dirname(file)), true);
	checkPath(dirname(file), true);
	checkPath(file, false);
}

export function loadKlaudShell(home?: string): KlaudShell {
	const file = klaudShellPath(home);
	checkStorage(file);
	let fd: number;
	try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return cloneShell(DEFAULT_KLAUD_SHELL);
		throw error;
	}
	try {
		const shell: unknown = JSON.parse(readFileSync(fd, "utf8"));
		validateShell(shell);
		return shell;
	} finally { closeSync(fd); }
}

export function saveKlaudShell(shell: KlaudShell, home?: string): void {
	validateShell(shell);
	const content = JSON.stringify(shell, null, 2) + "\n";
	const file = klaudShellPath(home);
	checkStorage(file);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	checkStorage(file);
	const temp = `${file}.${randomUUID()}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	let staged = true;
	try {
		try { writeFileSync(fd, content); } finally { closeSync(fd); }
		checkStorage(file);
		renameSync(temp, file);
		staged = false;
	} finally {
		if (staged) unlinkSync(temp);
	}
}

/** RFC 6902. Throws on invalid path, failed test op, or schema miss. */
export function applyKlaudPatch(shell: KlaudShell, patch: JsonPatchOp[]): KlaudShell {
	validateShell(shell);
	if (!Array.isArray(patch)) throw new Error("The shell patch must be an array.");
	const next = cloneShell(shell);
	for (const item of patch) {
		if (!item || typeof item !== "object" || !["add", "remove", "replace", "test"].includes(item.op)) throw new Error("Invalid shell patch operation.");
		if (!(KLAUD_SHELL_POINTERS as readonly string[]).includes(item.path)) throw new Error(`Invalid shell patch path: ${String(item.path)}.`);
		const [, section, key] = item.path.split("/");
		const target = (section === "theme" ? next.theme : next.chrome) as unknown as Record<string, unknown>;
		const exists = Object.hasOwn(target, key);
		if (item.op !== "add" && !exists) throw new Error(`Shell patch path does not exist: ${item.path}.`);
		if (item.op !== "remove" && !Object.hasOwn(item, "value")) throw new Error("The shell patch operation requires a value.");
		switch (item.op) {
			case "test":
				if (!isDeepStrictEqual(target[key], item.value)) throw new Error(`Shell patch test failed at ${item.path}.`);
				break;
			case "remove":
				if (item.path === "/theme/dark") throw new Error("Cannot remove required /theme/dark.");
				delete target[key];
				break;
			case "add":
			case "replace":
				target[key] = item.value;
				break;
		}
	}
	validateShell(next);
	return next;
}
