/** Personal-file export engine. Copies files and folders; never moves or deletes the source. */
import { copyFile, lstat, mkdir, readdir, stat, utimes } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface CopySummary { files: number; bytes: number; skipped: string[] }

export function isInside(child: string, parent: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A copy into its own source tree would loop forever; refuse it up front. */
export async function assertSafeTarget(sources: string[], target: string): Promise<void> {
	const t = resolve(target);
	for (const raw of sources) {
		if (!raw) continue;
		const s = resolve(raw);
		if (isInside(t, s)) throw new Error(`Export target ${t} is inside source ${s}; choose a different destination.`);
		if (isInside(s, t)) throw new Error(`Source ${s} is inside the export target ${t}; choose a different destination.`);
	}
}

export async function exportFiles(sources: string[], target: string): Promise<CopySummary> {
	const resolved: string[] = [];
	for (const raw of sources) {
		const s = resolve(raw);
		await stat(s);
		resolved.push(s);
	}
	if (resolved.length === 0) throw new Error("Choose at least one file or folder to export.");
	await assertSafeTarget(resolved, target);
	await mkdir(target, { recursive: true });
	const summary: CopySummary = { files: 0, bytes: 0, skipped: [] };
	for (const source of resolved) {
		await copyEntry(source, target, basename(source), summary);
	}
	return summary;
}

/** Copy one node; destRel is its path under the export target. */
async function copyEntry(source: string, target: string, destRel: string, summary: CopySummary): Promise<void> {
	const info = await lstat(source);
	const dest = join(target, destRel);
	if (info.isSymbolicLink()) {
		summary.skipped.push(`${destRel} (symlink, not followed)`);
		return;
	}
	if (info.isDirectory()) {
		await mkdir(dest, { recursive: true });
		const entries = await readdir(source, { withFileTypes: true });
		for (const entry of entries) await copyEntry(join(source, entry.name), target, join(destRel, entry.name), summary);
		await utimes(dest, info.atime, info.mtime);
		return;
	}
	if (info.isFile()) {
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(source, dest);
		await utimes(dest, info.atime, info.mtime);
		summary.files += 1;
		summary.bytes += info.size;
		return;
	}
	summary.skipped.push(`${destRel} (${info.isSocket() ? "socket" : "special file"})`);
}

export function formatBytes(bytes: number): string {
	if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
	if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)} MiB`;
	if (bytes >= 2 ** 10) return `${(bytes / 2 ** 10).toFixed(1)} KiB`;
	return `${bytes} B`;
}
