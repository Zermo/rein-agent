/** Private settings shared by connection setup and the offline budget wizard. */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const configPath = () => resolve(process.env.REIN_HOME || join(homedir(), ".rein"), "config.json");

export function readConfig(): Record<string, unknown> {
	const path = configPath();
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Cannot read Rein config at ${path}. Check the file permissions.`);
	}
	if (!text.trim()) return {};
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch { /* Do not echo JSON parser excerpts: they can contain credentials. */ }
	throw new Error(`Invalid Rein config at ${path}. Expected a JSON object. Repair this file before running setup; its contents have been preserved.`);
}

export function saveConfig(config: Record<string, unknown>): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		renameSync(temp, path);
	} finally { try { unlinkSync(temp); } catch {} }
}
