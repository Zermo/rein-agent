/** Operator-owned run controls, separate from model-editable shell preferences. */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export interface KlaudRunSettings {
	bashApproval: "auto" | "ask";
	reasoningEffort: "default" | "off" | "low" | "medium" | "high";
}
export const DEFAULT_KLAUD_RUN_SETTINGS: KlaudRunSettings = { bashApproval: "auto", reasoningEffort: "default" };
const fields = { bashApproval: ["auto", "ask"], reasoningEffort: ["default", "off", "low", "medium", "high"] };
export function validateRunSettingsPatch(value: unknown): asserts value is Partial<KlaudRunSettings> {
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| Object.entries(value).some(([key, item]) => !Object.hasOwn(fields, key) || !(fields[key as keyof typeof fields] as readonly unknown[]).includes(item))) {
		throw new Error("Use bashApproval auto|ask and reasoningEffort default|off|low|medium|high.");
	}
}
function paths(home: string, create = false) {
	const root = resolve(home), directory = join(root, "klaud");
	for (const path of [root, directory]) {
		try {
			if (create) mkdirSync(path, { mode: 0o700 });
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		try { const info = lstatSync(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Run settings require ordinary directories without symbolic links."); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	return { directory, file: join(directory, "run-settings.json") };
}
export function loadKlaudRunSettings(home: string): KlaudRunSettings {
	const { file } = paths(home);
	let fd: number;
	try {
		const named = lstatSync(file);
		if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) throw new Error("Run settings require an ordinary file without symbolic or hard links.");
		fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	}
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_KLAUD_RUN_SETTINGS }; throw error; }
	try {
		const stat = fstatSync(fd), named = lstatSync(file);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || named.isSymbolicLink() || named.ino !== stat.ino || named.dev !== stat.dev) throw new Error("Run settings must be a small ordinary file.");
		let settings: unknown;
		try { settings = JSON.parse(readFileSync(fd, "utf8")); } catch { throw new Error("Invalid desktop run settings; the existing file was preserved."); }
		validateRunSettingsPatch(settings);
		return { ...DEFAULT_KLAUD_RUN_SETTINGS, ...settings };
	} finally { closeSync(fd); }
}
export function saveKlaudRunSettings(patch: unknown, home: string): KlaudRunSettings {
	validateRunSettingsPatch(patch);
	const settings = { ...loadKlaudRunSettings(home), ...patch };
	const { file } = paths(home, true), temp = `${file}.${randomUUID()}.tmp`;
	try { writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600, flag: "wx" }); paths(home); renameSync(temp, file); }
	finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
	return settings;
}
