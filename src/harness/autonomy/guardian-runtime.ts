/** Pinned standalone runtime only: no desktop app, installer script or system service. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, statfsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { release } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { HardwareProfile } from "../../hardware/profile.ts";
import { privateDirectory } from "./state.ts";

export interface HeadlessRuntimePlan {
	version: string; asset: string; url: string; sha256: string; downloadBytes: number;
	executableRelative: string; prerequisites: string[];
}
// Official release assets and SHA256 digests, verified from release v0.33.3.
// https://github.com/ollama/ollama/releases/tag/v0.33.3
export function headlessRuntimePlan(profile: Pick<HardwareProfile, "os" | "arch">): HeadlessRuntimePlan | undefined {
	if (!["x64", "arm64"].includes(profile.arch)) return undefined;
	const platform = profile.os.toLowerCase();
	const artifact = platform === "darwin" ? ["ollama-darwin.tgz", 159236337, "342db03df80bb9db84ff64246031bd5f70c09b59ff52fa5cc9aaae3476cc4a9d", "ollama"]
		: platform === "linux" && profile.arch === "x64" ? ["ollama-linux-amd64.tar.zst", 1433825108, "c13cea8f3389db4145f8a6cb88d1747242a48639d7c13e3bda7c1ebdc6eebb2f", "bin/ollama"]
		: platform === "linux" ? ["ollama-linux-arm64.tar.zst", 1554076220, "4425a112af999ae6572c1ce211fbabeaca7bab23ed5860972acdfc0cc2358420", "bin/ollama"] : undefined;
	if (!artifact) return undefined;
	const [asset, downloadBytes, sha256, executableRelative] = artifact as [string, number, string, string];
	return { version: "0.33.3", asset, url: `https://github.com/ollama/ollama/releases/download/v0.33.3/${asset}`, downloadBytes, sha256, executableRelative,
		prerequisites: platform === "darwin" ? ["macOS 14 or later", "tar", "free disk space for the archive and extracted runtime"] : ["GNU tar or bsdtar with zstd support", "zstd", "free disk space for the archive and extracted runtime"] };
}
type Options = { signal?: AbortSignal; log?: (text: string) => void };
type Command = (command: string, args: string[], options: { signal?: AbortSignal; timeoutMs: number }) => Promise<string>;
/** Dependency seams are for fixture tests; artifact overrides have no CLI/config surface. */
interface Dependencies { command?: Command; download?: (url: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>; artifact?: HeadlessRuntimePlan }
const MANIFEST = ".rein-runtime.json", MAX_ENTRIES = 20_000, MAX_EXPANDED = 16 * 1024 ** 3;
const runtimeDirectory = () => join(privateDirectory(), "guardian-runtime");
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function safeName(name: string): string {
	if (!name || !/^[A-Za-z0-9_./+@-]+$/.test(name) || name.startsWith("/") || name.split("/").includes("..")) throw new Error("Unsafe path in guardian runtime archive.");
	return name.split("/").filter(part => part && part !== ".").join("/");
}

/** Capture bounded tar output; cancellation drains the complete owned process group. */
export const runRuntimeArchiveCommand: Command = (command, args, options) => {
	options.signal?.throwIfAborted();
	return new Promise((resolveResult, reject) => {
		const env = { ...process.env, LC_ALL: "C", LANG: "C" };
		for (const key of ["TAR_OPTIONS", "TAPE", "RSH", "RSH_COMMAND", "GZIP", "BZIP", "BZIP2", "XZ_OPT", "XZ_DEFAULTS", "ZSTD_CLEVEL", "ZSTD_NBTHREADS", "BASH_ENV", "ENV"]) delete env[key];
		const child = spawn(command, args, { shell: false, detached: process.platform !== "win32", env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", diagnostic = "", bytes = 0, closed = false, settled = false, code: number | null = null, failure: Error | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
		const kill = (signal: NodeJS.Signals) => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
		const finish = () => {
			if (!closed || settled || escalation) return;
			settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else if (code !== 0) reject(new Error(`Guardian archive command failed (${command}, ${code}): ${diagnostic.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 400)}`));
			else resolveResult(output);
		};
		const stop = (error: Error) => { if (failure) return; failure = error; kill("SIGTERM"); escalation = setTimeout(() => { kill("SIGKILL"); escalation = undefined; finish(); }, 1000); };
		const abort = () => stop(new Error("Guardian runtime installation cancelled."));
		const timer = setTimeout(() => stop(new Error("Guardian archive command timed out.")), options.timeoutMs);
		child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 2 * 1024 ** 2) stop(new Error("Guardian archive listing exceeds its limit.")); else output += chunk.toString("utf8"); });
		child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-4096); });
		child.on("error", error => { failure ??= error; closed = true; finish(); });
		child.on("close", value => { closed = true; code = value; finish(); });
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
};

/** No auth headers or proxy configuration; permit only GitHub's HTTPS release redirect. */
export async function downloadRuntimeArchive(url: string, signal: AbortSignal, redirects = 0): Promise<AsyncIterable<Uint8Array>> {
	signal.throwIfAborted();
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(parsed.hostname) || redirects > 4) throw new Error("Unexpected guardian runtime download redirect.");
	return new Promise<AsyncIterable<Uint8Array>>((resolveBody, reject) => {
		const request = get(parsed, { signal, headers: { "User-Agent": "rein-agent", "Accept-Encoding": "identity" } }, response => {
			if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
				try { resolveBody(downloadRuntimeArchive(new URL(response.headers.location, parsed).href, signal, redirects + 1)); }
				catch (error) { reject(error); }
				// Settle to the next request before closing this socket, so a late
				// ECONNRESET on the redirect cannot override the next response.
				response.destroy(); request.destroy(); return;
			}
			if (response.statusCode !== 200) { response.destroy(); request.destroy(); reject(new Error(`Guardian runtime download returned HTTP ${response.statusCode}.`)); return; }
			resolveBody(response);
		});
		request.setTimeout(30_000, () => request.destroy(new Error("Guardian runtime download stalled.")));
		request.on("error", reject);
	});
}
type Entry = { path: string; kind: "directory" | "file" | "link"; bytes?: number; sha256?: string; executable?: boolean; target?: string };
async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
	return hash.digest("hex");
}
/** Check links and inode containment before chmod/hash, so links cannot alter outside files. */
async function inspectTree(root: string, signal?: AbortSignal, normalize = false): Promise<Entry[]> {
	const rootStat = await lstat(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Guardian runtime must be an ordinary directory.");
	if (!normalize && (rootStat.mode & 0o777) !== 0o700) throw new Error("Guardian runtime directory is no longer private.");
	const canonicalRoot = await realpath(root);
	const entries: Entry[] = [], inodes = new Map<string, { count: number; links: number }>();
	let totalBytes = 0;
	async function visit(directory: string) {
		for (const name of (await readdir(directory)).sort()) {
			signal?.throwIfAborted();
			const full = join(directory, name), path = relative(root, full).split(sep).join("/");
			if (path === MANIFEST) continue;
			safeName(path);
			if (entries.length >= MAX_ENTRIES) throw new Error("Too many guardian runtime files.");
			const stat = await lstat(full);
			if (!normalize && !stat.isSymbolicLink() && (stat.mode & 0o7777) !== (stat.isDirectory() || stat.mode & 0o111 ? 0o700 : 0o600)) throw new Error("Guardian runtime file permissions changed.");
			if (stat.isSymbolicLink()) {
				const target = await readlink(full);
				if (!target || target.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(target) || !inside(root, resolve(directory, target)) || !inside(canonicalRoot, await realpath(full))) throw new Error("Guardian runtime link escapes its private directory.");
				entries.push({ path, kind: "link", target });
			} else if (stat.isDirectory()) { entries.push({ path, kind: "directory" }); await visit(full);
			} else if (stat.isFile()) {
				totalBytes += stat.size;
				if (totalBytes > MAX_EXPANDED) throw new Error("Guardian runtime exceeds its extraction size limit.");
				const key = `${stat.dev}:${stat.ino}`, inode = inodes.get(key) ?? { count: 0, links: stat.nlink }; inode.count++; inodes.set(key, inode);
				entries.push({ path, kind: "file", bytes: stat.size, executable: !!(stat.mode & 0o111) });
			} else throw new Error("Guardian runtime contains a device, pipe, socket or unsupported entry.");
		}
	}
	await visit(root);
	if ([...inodes.values()].some(inode => inode.count !== inode.links)) throw new Error("Guardian runtime has hard links outside its private directory.");
	for (const entry of entries) {
		signal?.throwIfAborted();
		const full = join(root, entry.path);
		if (entry.kind === "file") entry.sha256 = await hashFile(full, signal);
		if (normalize && entry.kind !== "link") await chmod(full, entry.kind === "directory" || entry.executable ? 0o700 : 0o600);
	}
	if (normalize) await chmod(root, 0o700);
	return entries;
}
async function verify(root: string, plan: HeadlessRuntimePlan, signal?: AbortSignal): Promise<string | undefined> {
	try { await lstat(root); } catch (error) { if (absent(error)) return undefined; throw error; }
	try {
		const rootStat = await lstat(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Runtime root must be an ordinary directory.");
		const stat = await lstat(join(root, MANIFEST));
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 ** 2 || (stat.mode & 0o7777) !== 0o600) throw new Error("Invalid manifest file.");
		const manifest = JSON.parse(await readFile(join(root, MANIFEST), "utf8"));
		if (manifest.version !== 1 || manifest.asset !== plan.asset || manifest.archiveSha256 !== plan.sha256 || manifest.runtimeVersion !== plan.version) throw new Error("Unrecognized archive manifest.");
		const entries = await inspectTree(root, signal);
		if (JSON.stringify(entries) !== JSON.stringify(manifest.entries)) throw new Error("Runtime file integrity mismatch.");
		const binary = entries.find(entry => entry.path === plan.executableRelative);
		if (binary?.kind !== "file" || !binary.executable) throw new Error("Missing executable.");
		return join(root, plan.executableRelative);
	} catch (error) { signal?.throwIfAborted(); throw new Error(`Existing guardian runtime was preserved because verification failed: ${(error as Error).message} Move the guardian-runtime directory aside after stopping its service, then retry installation.`); }
}
export async function verifyHeadlessRuntime(profile: Pick<HardwareProfile, "os" | "arch">): Promise<string | undefined> {
	const plan = headlessRuntimePlan(profile);
	return plan ? verify(runtimeDirectory(), plan) : undefined;
}

export async function installHeadlessRuntime(profile: HardwareProfile, options: Options = {}, dependencies: Dependencies = {}): Promise<string> {
	options.signal?.throwIfAborted();
	const plan = dependencies.artifact ?? headlessRuntimePlan(profile);
	if (!plan) throw new Error("No verified headless runtime is available for this platform. Rules-only coordination remains available.");
	if (!dependencies.artifact && process.platform === "darwin" && Number.parseInt(release(), 10) < 23) throw new Error("The pinned headless runtime requires macOS 14 or later. Rules-only coordination remains available.");
	const root = runtimeDirectory(), cached = await verify(root, plan, options.signal);
	if (cached) return cached;
	const command = dependencies.command ?? runRuntimeArchiveCommand;
	try {
		await command("tar", ["--version"], { signal: options.signal, timeoutMs: 5000 });
		if (plan.asset.endsWith(".zst")) await command("zstd", ["--version"], { signal: options.signal, timeoutMs: 5000 });
	} catch (error) { options.signal?.throwIfAborted(); throw new Error(`Headless runtime needs ${plan.prerequisites.join(", ")}. ${(error as Error).message}`); }
	const parent = privateDirectory(), filesystem = statfsSync(parent);
	if (Number(filesystem.bavail) * Number(filesystem.bsize) < plan.downloadBytes * 4 + 1024 ** 3) throw new Error("Insufficient free disk space for the headless runtime archive and private extraction staging.");
	const stage = await mkdtemp(join(parent, ".guardian-runtime-")), archive = join(stage, plan.asset), extracted = join(stage, "runtime");
	const controller = new AbortController(), abort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const timer = setTimeout(() => controller.abort(new Error("Headless runtime installation timed out.")), 20 * 60_000);
	try {
		options.log?.(`Downloading headless runtime ${plan.version} (${Math.ceil(plan.downloadBytes / 1_000_000)} MB).`);
		const hash = createHash("sha256"); let bytes = 0;
		const bounded = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > plan.downloadBytes) callback(new Error("Guardian runtime download exceeded its pinned size.")); else { hash.update(chunk); callback(null, chunk); } } });
		await pipeline(await (dependencies.download ?? downloadRuntimeArchive)(plan.url, controller.signal), bounded, createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
		if (bytes !== plan.downloadBytes || hash.digest("hex") !== plan.sha256) throw new Error("Guardian runtime archive failed its pinned SHA256/size check. Nothing was extracted.");
		controller.signal.throwIfAborted();
		const compression = plan.asset.endsWith(".zst") ? ["--zstd"] : [];
		const listing = await command("tar", [...compression, "-tf", archive], { signal: controller.signal, timeoutMs: 120_000 });
		const names = listing.trimEnd().split("\n"), seen = new Set<string>();
		if (!listing || names.length > MAX_ENTRIES) throw new Error("Invalid guardian runtime archive listing.");
		for (const name of names) {
			const normalized = safeName(name);
			if (!normalized || normalized === ".") continue;
			if (seen.has(normalized) || normalized === MANIFEST) throw new Error("Duplicate or reserved path in guardian runtime archive.");
			seen.add(normalized);
		}
		await mkdir(extracted, { mode: 0o700 });
		options.log?.("Archive verified. Extracting the private headless runtime.");
		// Default GNU/BSD tar protections reject traversal through symlinks. -k
		// refuses replacement, and nothing is extracted before the trusted digest.
		await command("tar", [...compression, "-xkf", archive, "--no-same-owner", "--no-same-permissions", "-C", extracted], { signal: controller.signal, timeoutMs: 5 * 60_000 });
		const entries = await inspectTree(extracted, controller.signal, true);
		const binary = entries.find(entry => entry.path === plan.executableRelative);
		if (binary?.kind !== "file" || !binary.executable) throw new Error("Verified runtime archive did not contain its expected executable.");
		await writeFile(join(extracted, MANIFEST), JSON.stringify({ version: 1, runtimeVersion: plan.version, asset: plan.asset, archiveSha256: plan.sha256, entries }), { flag: "wx", mode: 0o600 });
		controller.signal.throwIfAborted();
		// The caller holds guardian-install.lock. Never replace a competing cache.
		try { await lstat(root); throw new Error("A guardian runtime directory appeared during installation; it was preserved."); } catch (error) { if (!absent(error)) throw error; }
		await rename(extracted, root);
		return join(root, plan.executableRelative);
	} finally {
		clearTimeout(timer); options.signal?.removeEventListener("abort", abort); controller.abort();
		await rm(stage, { recursive: true, force: true });
	}
}
