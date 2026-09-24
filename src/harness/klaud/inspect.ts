import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
	".png": "image/png",
	".svg": "image/svg+xml",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".json": "application/json",
	".csv": "text/plain; charset=utf-8",
	".js": "text/plain; charset=utf-8",
	".mjs": "text/plain; charset=utf-8",
	".cjs": "text/plain; charset=utf-8",
	".ts": "text/plain; charset=utf-8",
	".jsx": "text/plain; charset=utf-8",
	".tsx": "text/plain; charset=utf-8",
	".css": "text/plain; charset=utf-8",
	".py": "text/plain; charset=utf-8",
	".yml": "text/plain; charset=utf-8",
	".yaml": "text/plain; charset=utf-8",
	".sh": "text/plain; charset=utf-8",
};
const MAX_BYTES = 5 * 1024 * 1024;
const BLOCK = /(?:^|[\\/])(?:\.env|secrets?|credentials?|.*token.*|.*password.*)(?:$|[\\/])/i;

export type InspectKind = "image" | "html" | "text";

function kindFor(ext: string): InspectKind {
	if (ext === ".html" || ext === ".htm") return "html";
	if ([".png", ".svg", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
	return "text";
}

export function inspectRoot(cwd: string | undefined, fallback: string): string {
	return resolve(cwd && cwd.trim() ? cwd : fallback);
}

function underRoot(root: string, file: string): boolean {
	const base = realpathSync(root);
	const real = realpathSync(file);
	return real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
}

export function resolveInspectFile(root: string, rel: string): { file: string; type: string; path: string; size: number; kind: InspectKind } {
	if (typeof rel !== "string" || !rel.trim() || rel.includes("\0") || rel.length > 1024) throw new Error("Invalid inspect path.");
	if (BLOCK.test(rel)) throw new Error("That file is not inspectable.");
	if (rel.includes("..")) throw new Error("Invalid inspect path.");
	const abs = resolve(root, rel.replace(/^\.\//, ""));
	const base = resolve(root);
	if (abs !== base && !abs.startsWith(base.endsWith(sep) ? base : base + sep)) throw new Error("Inspect path must stay in the bot workspace.");
	let st;
	try { st = lstatSync(abs); } catch {
		const name = rel.split("/").pop() || "";
		const hit = name && listInspectFiles(root).find(file => file.path === name || file.path.endsWith("/" + name));
		if (!hit || hit.path === rel) throw new Error("Inspect file is missing.");
		return resolveInspectFile(root, hit.path);
	}
	if (st.isSymbolicLink() || !st.isFile()) throw new Error("Inspect file is missing.");
	if (!underRoot(root, abs)) throw new Error("Inspect path must stay in the bot workspace.");
	const ext = extname(abs).toLowerCase();
	const type = TYPES[ext];
	if (!type) throw new Error("Inspect only png, svg, html, md, txt, json, csv, and source text.");
	if (st.size > MAX_BYTES && kindFor(ext) === "image") throw new Error("Inspect file is too large to preview.");
	return { file: abs, type, path: relative(realpathSync(root), realpathSync(abs)).split("\\").join("/"), size: st.size, kind: kindFor(ext) };
}

export function listInspectFiles(root: string): { path: string; size: number; kind: InspectKind; mtime: number }[] {
	const out: { path: string; size: number; kind: InspectKind; mtime: number }[] = [];
	const walk = (dir: string, depth: number) => {
		if (out.length >= 24 || depth > 2) return;
		let entries: string[] = [];
		try { entries = readdirSync(dir); } catch { return; }
		for (const name of entries) {
			if (name.startsWith(".")) continue;
			if (BLOCK.test(name)) continue;
			const abs = join(dir, name);
			let st;
			try { st = lstatSync(abs); } catch { continue; }
			if (st.isSymbolicLink()) continue;
			if (st.isDirectory()) { walk(abs, depth + 1); continue; }
			if (!st.isFile() || st.size > MAX_BYTES) continue;
			const ext = extname(name).toLowerCase();
			if (!TYPES[ext]) continue;
			out.push({ path: relative(root, abs).split("\\").join("/"), size: st.size, kind: kindFor(ext), mtime: st.mtimeMs });
		}
	};
	walk(root, 0);
	return out.sort((a, b) => b.mtime - a.mtime).slice(0, 20);
}

export function readInspectFile(file: string): Buffer {
	const size = lstatSync(file).size;
	if (size <= MAX_BYTES) return readFileSync(file);
	const fd = openSync(file, "r");
	try {
		const page = Buffer.alloc(32 * 1024);
		const read = readSync(fd, page, 0, page.length, 0);
		const notice = Buffer.from(`\n\n[file is ${size} bytes. first page only. this is not a failed action.]`);
		return Buffer.concat([page.subarray(0, read), notice]);
	} finally { closeSync(fd); }
}
