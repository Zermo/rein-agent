/** Skin installer rebuilt from Rainmeter's SkinInstaller/SkinRegistry: stage, never overwrite. */
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

export interface InstallResult {
	target: string;
	files: string[];
}

function validPath(path: string): void {
	if (typeof path !== "string" || !path.trim() || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Skin paths must be nonempty and free of control characters.");
}

async function regularFile(path: string): Promise<Buffer> {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("Skins are ordinary files only; symlinks are not staged.");
	if (info.size > 16 * 1024 * 1024) throw new Error("A skin file exceeds the 16 MiB limit.");
	return readFile(path);
}

/** Copy a skin directory (ini files plus resources) into the target skin directory. Refuses to overwrite. */
export async function installSkin(options: { source: string; target: string }): Promise<InstallResult> {
	if (!options || typeof options !== "object") throw new Error("A skin source directory and target directory are required.");
	validPath(options.source); validPath(options.target);
	const source = resolve(options.source), target = resolve(options.target);
	const sourceInfo = await lstat(source).catch(error => { if (error.code === "ENOENT") throw new Error("Skin source does not exist: " + options.source); throw error; });
	if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("Skin source must be an ordinary directory.");
	const targetName = source.split(/[\\/]/).filter(Boolean).pop() ?? "skin";
	const destination = join(target, targetName);
	const targetInfo = await lstat(destination).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
	if (targetInfo) throw new Error(`Skin already installed at ${destination}; it was preserved. Choose a new target or remove the old skin first.`);
	const files: string[] = [];
	const visit = async (relativePath: string) => {
		const absolute = join(source, relativePath);
		const info = await lstat(absolute);
		if (info.isSymbolicLink()) throw new Error(`Symlinks are not staged: ${relativePath}`);
		if (info.isDirectory()) {
			for (const name of (await readdir(absolute)).sort()) {
				if (name.startsWith(".") || name === "node_modules") continue;
				await visit(`${relativePath}/${name}`);
			}
		} else {
			const data = await regularFile(absolute);
			const out = join(destination, relativePath);
			await mkdir(dirname(out), { recursive: true, mode: 0o700 });
			await writeFile(out, data, { flag: "wx", mode: 0o600 });
			files.push(relative(target, out));
		}
	};
	const before = await readdir(source, { withFileTypes: true });
	if (!before.some(entry => entry.name.toLowerCase().endsWith(".ini"))) throw new Error("A skin directory needs at least one .ini file.");
	await mkdir(target, { recursive: true, mode: 0o700 });
	await visit("");
	return { target: destination, files };
}

export function skinDirectoryDefault(): string {
	return join(process.env.REIN_HOME || join(homedir(), ".rein"), "os", "skins");
}

export interface InstalledSkin {
	name: string;
	path: string;
	title: string | null;
}

/** List installed skins (Rainmeter's SkinRegistry, read-only). */
export async function listSkins(dir: string): Promise<InstalledSkin[]> {
	const root = resolve(dir);
	const entries = await readdir(root, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
	const skins: InstalledSkin[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const files: Dirent[] = await readdir(join(root, entry.name), { withFileTypes: true }).catch(() => []);
		const ini = files.find(file => file.isFile() && file.name.toLowerCase().endsWith(".ini"));
		if (!ini) continue;
		const text = await readFile(join(root, entry.name, ini.name), "utf8").catch(() => "");
		const name = text.match(/\[Metadata\][^\[]*?^\s*Name\s*=\s*(.+)$/im)?.[1]?.trim();
		skins.push({ name: entry.name, path: join(root, entry.name), title: name ?? null });
	}
	return skins;
}
