/** Bounded background inspection without subprocesses or directory-link traversal. */
import { constants, lstatSync } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentTool } from "../../agent/agent-loop.ts";
import { canonicalWorkspace } from "./state.ts";

const MAX_FILE_BYTES = 200_000;
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const PRIVATE_PATH = /^(?:credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|keys?(?:\.(?:json|ya?ml|toml))?|auth(?:entication)?\.(?:json|ya?ml|toml|ini)|service[-_]account(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keystore|jks|crt|cer|der))$/i;
const privateName = (name: string) => name.startsWith(".") || PRIVATE_PATH.test(name);
const aborted = (signal?: AbortSignal) => signal?.throwIfAborted();

export function inspectionTools(cwd: string): AgentTool[] {
	const root = canonicalWorkspace(cwd);
	const originalRoot = lstatSync(root);
	const pathSchema = { type: "string", description: "Path within the enrolled workspace" };
	async function scoped(input: unknown, signal?: AbortSignal) {
		aborted(signal);
		if (typeof input !== "string" || input.includes("\0") || input.length > 4096) throw new Error("A workspace-relative path is required.");
		const path = resolve(root, input); const rel = relative(root, path);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path is outside the approved workspace.");
		const rootStat = await lstat(root); aborted(signal);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== originalRoot.dev || rootStat.ino !== originalRoot.ino) throw new Error("The enrolled workspace directory changed. Restart inspection before continuing.");
		let current = root;
		let stat = rootStat;
		for (const part of rel.split(sep).filter(Boolean)) {
			if (privateName(part)) throw new Error("Hidden and private configuration paths are excluded from background inspection.");
			current = join(current, part);
			stat = await lstat(current); aborted(signal);
			if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error("Links and special files are excluded from background inspection.");
		}
		return { path, stat };
	}
	async function readOrdinary(input: unknown, maximum: number, signal?: AbortSignal): Promise<{ text: string; bytes: number }> {
		const { path, stat } = await scoped(input, signal); aborted(signal);
		if (!stat.isFile() || stat.size > maximum) throw new Error(`Read requires a regular file no larger than ${maximum} bytes.`);
		// NOFOLLOW prevents replacing the checked leaf with a symlink; NONBLOCK
		// prevents a concurrently substituted FIFO from blocking before fstat.
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try {
			aborted(signal);
			const opened = await handle.stat(); aborted(signal);
			if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > maximum) throw new Error("The inspected file changed or is not a bounded ordinary file.");
			const buffer = Buffer.alloc(opened.size);
			let bytes = 0;
			while (bytes < buffer.length) {
				const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes); aborted(signal);
				if (!result.bytesRead) break;
				bytes += result.bytesRead;
			}
			return { text: buffer.subarray(0, bytes).toString("utf8"), bytes };
		} finally { await handle.close(); }
	}
	async function* entries(input: unknown, maximum: number, signal?: AbortSignal) {
		const { path, stat } = await scoped(input, signal); aborted(signal);
		if (!stat.isDirectory()) throw new Error("Inspection requires a directory.");
		const directory = await opendir(path, { bufferSize: 32 });
		try {
			aborted(signal);
			for (let scanned = 0; scanned < maximum; scanned++) {
				const entry = await directory.read(); aborted(signal);
				if (!entry) break;
				yield { entry, path: join(path, entry.name) };
			}
		} finally { await directory.close(); }
	}
	return [
		{ name: "read", description: "Read an ordinary workspace file, at most 200000 bytes. Hidden/private paths and links are excluded.", parameters: { type: "object", required: ["path"], properties: { path: pathSchema } }, async execute(_id, args, signal) {
			const result = await readOrdinary(args?.path, MAX_FILE_BYTES, signal); aborted(signal);
			return { content: result.text.slice(0, 15000) };
		} },
		{ name: "ls", description: "List up to 200 visible workspace entries, inspecting at most 1000 directory entries.", parameters: { type: "object", properties: { path: pathSchema } }, async execute(_id, args, signal) {
			const names: string[] = [];
			for await (const { entry, path } of entries(args?.path ?? ".", 1000, signal)) {
				aborted(signal);
				if (privateName(entry.name) || entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) continue;
				try { await scoped(path, signal); aborted(signal); } catch { aborted(signal); continue; }
				names.push(entry.name + (entry.isDirectory() ? "/" : ""));
				if (names.length >= 200) break;
			}
			aborted(signal);
			return { content: names.join("\n") };
		} },
		{ name: "search", description: "Find literal text in up to 500 workspace files and 8 MB of content. Excludes hidden/private paths, links, dependencies, and files over 100000 bytes.", parameters: { type: "object", required: ["query"], properties: { query: { type: "string" }, path: pathSchema } }, async execute(_id, args, signal) {
			aborted(signal);
			if (typeof args?.query !== "string" || !args.query || args.query.length > 300) throw new Error("query must be 1-300 characters.");
			const query = args.query.toLowerCase();
			const hits: string[] = [];
			let files = 0; let directories = 0; let inspectedEntries = 0; let bytes = 0;
			const full = () => files >= 500 || inspectedEntries >= 6000 || bytes >= MAX_SEARCH_BYTES || hits.length >= 40;
			const visit = async (input: unknown, depth: number): Promise<void> => {
				aborted(signal);
				if (depth > 8 || full() || directories >= 100) return;
				directories++;
				for await (const { entry, path } of entries(input, Math.min(1000, 6000 - inspectedEntries), signal)) {
					aborted(signal);
					inspectedEntries++;
					if (full()) break;
					if (privateName(entry.name) || entry.name === "node_modules" || entry.name === "vendor" || entry.isSymbolicLink()) continue;
					try {
						if (entry.isDirectory()) { await visit(path, depth + 1); aborted(signal); }
						else if (entry.isFile()) {
							files++;
							const result = await readOrdinary(path, Math.min(100_000, MAX_SEARCH_BYTES - bytes), signal); aborted(signal);
							bytes += result.bytes;
							if (result.text.includes("\0")) continue;
							for (const [index, line] of result.text.split("\n").entries()) {
								if (line.toLowerCase().includes(query)) hits.push(`${relative(root, path)}:${index + 1}: ${line.slice(0, 240)}`);
								if (hits.length >= 40) break;
							}
						}
					} catch { aborted(signal); /* Inaccessible or concurrently changed paths are skipped. */ }
				}
			};
			await visit(args?.path ?? ".", 0); aborted(signal);
			return { content: hits.join("\n") || "No matches in inspected files." };
		} },
	];
}
