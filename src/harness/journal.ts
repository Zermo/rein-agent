/** Live journal pins. The selected thinking string is written now, not recovered from memory. */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { notesRoot } from "./tools/context.ts";
import { reinHome } from "./stack.ts";

const SECRET = /(api[_-]?key|secret|password|authorization|bearer)\s*[:=]\s*\S|(?:sk|ghp|xox[baprs])-[a-z0-9]|-----BEGIN [A-Z ]*PRIVATE KEY-----/gi;

export function pinQuote(quote: string): string {
	const text = quote.trim();
	if (!text || text.length > 2000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
		throw new Error("A pinned thinking string must be 1 to 2000 characters without control characters.");
	}
	return text.replace(SECRET, "[redacted]");
}

function appendPrivate(path: string, line: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink > 1 || lstatSync(path).isSymbolicLink()) throw new Error("Journal must be a regular private file.");
		const last = Buffer.alloc(1);
		if (stat.size) readSync(fd, last, 0, 1, stat.size - 1);
		writeFileSync(fd, `${stat.size && last[0] !== 10 ? "\n" : ""}${line}`);
	} finally { closeSync(fd); }
}

export function pinJournal(quote: string, home?: string, cwd?: string): { journal: string; note?: string } {
	const pinned = pinQuote(quote);
	const line = `- ${new Date().toISOString()} pin: ${pinned.replace(/\s+/g, " ")}\n`;
	const journal = join(reinHome(home), "stack", "JOURNAL.md");
	appendPrivate(journal, line);
	let note: string | undefined;
	if (cwd) {
		const work = cwd;
		try {
			note = join(notesRoot(work), ".pi", "notes", "JOURNAL.md");
			appendPrivate(note, line);
		} catch { note = undefined; }
	}
	return { journal, note };
}

export function readJournal(limit = 800, home?: string): string {
	const path = join(reinHome(home), "stack", "JOURNAL.md");
	if (!existsSync(path)) return "No thinking string has been pinned. Do not invent one from memory.";
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) return "Journal path is not a regular private file. It was not loaded.";
		const text = readFileSync(path, "utf8").trim();
		if (!text) return "No thinking string has been pinned. Do not invent one from memory.";
		return text.length > limit ? text.slice(-limit) : text;
	} catch {
		return "No thinking string has been pinned. Do not invent one from memory.";
	}
}
