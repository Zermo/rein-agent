import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createGunzip, createInflateRaw } from "node:zlib";

export const OBSCURA_VERSION = "0.2.2";
const REPOSITORY = "https://github.com/h4ckf0r0day/obscura";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 180_000;

interface ReleaseAsset { filename: string; bytes: number; sha256: string; format: "tar.gz" | "zip"; members: string[]; }
interface ReleaseManifest { repository: string; version: string; tag: string; commit: string; variant: string; assets: Record<string, ReleaseAsset>; }
export interface ObscuraInstallOptions { signal?: AbortSignal; onProgress?: (text: string) => void; }
/** Internal dependency seam for offline installation tests; never populated from user configuration. */
export interface ObscuraInstallDependencies {
	fetch?: typeof globalThis.fetch;
	manifest?: ReleaseManifest;
	home?: string;
	platform?: string;
	arch?: string;
	timeoutMs?: number;
	maxArchiveBytes?: number;
	maxExtractedBytes?: number;
}

function manifest(): ReleaseManifest {
	const here = dirname(fileURLToPath(import.meta.url));
	const path = [resolve(here, "../../../vendor/obscura/releases.json"), resolve(here, "../vendor/obscura/releases.json")].find(existsSync);
	if (!path) throw new Error("Obscura release metadata is missing. Reinstall the complete Rein package.");
	return JSON.parse(readFileSync(path, "utf8"));
}
function installRoot(home = process.env.REIN_HOME || join(homedir(), ".rein"), platform: string = process.platform, arch: string = process.arch): string {
	return join(resolve(home), "native", "obscura", OBSCURA_VERSION, `${platform}-${arch}`);
}
function executable(path: string): boolean {
	try { if (!statSync(path).isFile()) return false; accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true; }
	catch { return false; }
}
function managedExecutable(directory: string, asset?: ReleaseAsset): string | undefined {
	try {
		if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return undefined;
		const installed = JSON.parse(readFileSync(join(directory, "install.json"), "utf8"));
		const members = asset?.members ?? (process.platform === "win32" ? ["obscura.exe", "obscura-worker.exe"] : ["obscura", "obscura-worker"]);
		if (installed.version !== OBSCURA_VERSION || (asset && installed.sha256 !== asset.sha256)) return undefined;
		for (const member of members) {
			const path = join(directory, member);
			if (lstatSync(path).isSymbolicLink() || !executable(path)) return undefined;
		}
		return join(directory, members[0]);
	} catch { return undefined; }
}

/** Resolve an explicit absolute binary, complete managed install, or PATH binary without downloading. */
export function resolveObscura(override?: string): string | undefined {
	if (override !== undefined) {
		if (!isAbsolute(override)) throw new Error("OBSCURA_BIN / obscura.bin must be an absolute path to the Obscura executable.");
		if (!executable(override)) throw new Error(`The configured Obscura executable is missing or not executable: ${override}`);
		return override;
	}
	const managed = managedExecutable(installRoot());
	if (managed) return managed;
	const name = process.platform === "win32" ? "obscura.exe" : "obscura";
	for (const directory of (process.env.PATH || "").split(delimiter)) {
		if (isAbsolute(directory) && executable(join(directory, name))) return join(directory, name);
	}
	return undefined;
}

function checkAbort(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Obscura installation cancelled.");
}
async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
	checkAbort(signal);
	return await new Promise<T>((resolveResult, reject) => {
		const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Obscura installation cancelled."));
		signal.addEventListener("abort", abort, { once: true });
		try { operation().then(resolveResult, reject).finally(() => signal.removeEventListener("abort", abort)); }
		catch (error) { signal.removeEventListener("abort", abort); reject(error); }
	});
}
async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < bytes.length) { const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset); if (!bytesWritten) throw new Error("Could not write Obscura runtime files."); offset += bytesWritten; }
}

async function download(asset: ReleaseAsset, path: string, signal: AbortSignal, fetcher: typeof fetch, maxBytes: number): Promise<void> {
	const url = `${REPOSITORY}/releases/download/v${OBSCURA_VERSION}/${asset.filename}`;
	const response = await abortable(() => fetcher(url, { signal, headers: { accept: "application/octet-stream" } }), signal);
	if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error(`Obscura download failed (HTTP ${response.status}). Try rein web install again.`); }
	const reader = response.body.getReader();
	let file: FileHandle | undefined;
	try {
		const length = response.headers.get("content-length");
		if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.bytes)) throw new Error("Obscura archive size does not match the pinned release.");
		file = await open(path, "wx", 0o600);
		const hash = createHash("sha256"); let bytes = 0;
		while (true) {
			const chunk = await abortable(() => reader.read(), signal); checkAbort(signal);
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > maxBytes || bytes > asset.bytes) throw new Error("Obscura archive exceeds the pinned download size limit.");
			hash.update(chunk.value); await writeAll(file, chunk.value);
		}
		if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error("Obscura archive failed SHA-256 verification against the pinned release.");
	} finally { void reader.cancel().catch(() => {}); await file?.close(); }
}

function octal(bytes: Buffer): number {
	const text = bytes.toString("ascii").replace(/[\0 ]+$/g, "").replace(/^ +/g, "");
	if (!/^[0-7]+$/.test(text)) throw new Error("Invalid numeric field in Obscura archive.");
	const value = Number.parseInt(text, 8);
	if (!Number.isSafeInteger(value)) throw new Error("Invalid size in Obscura archive.");
	return value;
}
function cstring(bytes: Buffer): string { const end = bytes.indexOf(0); return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8"); }

async function extractTar(path: string, stage: string, asset: ReleaseAsset, signal: AbortSignal, maxBytes: number): Promise<void> {
	const input = createReadStream(path), unzip = createGunzip();
	input.on("error", error => unzip.destroy(error)); input.pipe(unzip);
	const abort = () => { input.destroy(); unzip.destroy(signal.reason instanceof Error ? signal.reason : new Error("Obscura installation cancelled.")); };
	signal.addEventListener("abort", abort, { once: true });
	const iterator = unzip[Symbol.asyncIterator]();
	let pending = Buffer.alloc(0), total = 0;
	async function take(length: number): Promise<Buffer> {
		while (pending.length < length) {
			checkAbort(signal); const chunk = await iterator.next();
			if (chunk.done) throw new Error("Obscura tar archive is truncated.");
			const bytes = Buffer.from(chunk.value); total += bytes.length;
			if (total > maxBytes) throw new Error("Obscura archive exceeds the extraction size limit.");
			pending = Buffer.concat([pending, bytes]);
		}
		const bytes = pending.subarray(0, length); pending = pending.subarray(length); return bytes;
	}
	const found = new Set<string>();
	try {
		while (true) {
			checkAbort(signal); const header = await take(512);
			if (header.every(byte => byte === 0)) {
				if (!(await take(512)).every(byte => byte === 0)) throw new Error("Invalid Obscura tar terminator.");
				if (!pending.every(byte => byte === 0)) throw new Error("Unexpected data after Obscura tar terminator.");
				for await (const chunk of iterator) {
					checkAbort(signal); total += chunk.length;
					if (total > maxBytes || !chunk.every((byte: number) => byte === 0)) throw new Error("Invalid or oversized Obscura tar padding.");
				}
				break;
			}
			let checksum = 0; for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
			if (checksum !== octal(header.subarray(148, 156))) throw new Error("Invalid Obscura tar header checksum.");
			const name = cstring(header.subarray(0, 100)), prefix = cstring(header.subarray(345, 500));
			if (prefix || !asset.members.includes(name) || found.has(name) || (header[156] !== 0 && header[156] !== 48)) throw new Error("Obscura archive contains an unexpected, duplicate, or non-regular member.");
			const size = octal(header.subarray(124, 136));
			if (!size || size > maxBytes) throw new Error("Invalid Obscura executable size.");
			found.add(name); const output = await open(join(stage, name), "wx", 0o700);
			try { for (let left = size; left > 0;) { checkAbort(signal); const chunk = await take(Math.min(left, 64 * 1024)); await writeAll(output, chunk); left -= chunk.length; } }
			finally { await output.close(); }
			const padding = (512 - (size % 512)) % 512;
			if (padding) await take(padding);
		}
		if (found.size !== asset.members.length) throw new Error("Obscura archive is missing a required executable.");
	} finally { signal.removeEventListener("abort", abort); input.destroy(); unzip.destroy(); }
}

async function extractZip(path: string, stage: string, asset: ReleaseAsset, signal: AbortSignal, maxBytes: number): Promise<void> {
	const bytes = await readFile(path); checkAbort(signal);
	let end = -1;
	for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
		if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
	}
	if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== asset.members.length || bytes.readUInt16LE(end + 10) !== asset.members.length) throw new Error("Invalid Obscura ZIP directory.");
	const directoryBytes = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16);
	if (directoryOffset + directoryBytes !== end) throw new Error("Invalid Obscura ZIP directory bounds.");
	let offset = directoryOffset, total = 0; const found = new Set<string>(), spans: [number, number][] = [];
	for (let index = 0; index < asset.members.length; index++) {
		checkAbort(signal);
		if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid Obscura ZIP entry.");
		const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
		const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
		const mode = bytes.readUInt32LE(offset + 38) >>> 16, name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		if (offset + 46 + nameLength + extraLength + commentLength > end || !asset.members.includes(name) || found.has(name) || flags & ~0x808 || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34) || ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000)) throw new Error("Obscura ZIP contains an unexpected or unsupported member.");
		total += size;
		if (!size || total > maxBytes || local + 30 > directoryOffset || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("Invalid or oversized Obscura ZIP member.");
		const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28), start = local + 30 + localNameLength + localExtraLength;
		if (bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || bytes.subarray(local + 30, local + 30 + localNameLength).toString("utf8") !== name || start + compressed > directoryOffset || spans.some(([a, b]) => local < b && start + compressed > a)) throw new Error("Invalid Obscura ZIP member bounds.");
		spans.push([local, start + compressed]); found.add(name);
		const output = await open(join(stage, name), "wx", 0o700); let written = 0;
		const source = Readable.from([bytes.subarray(start, start + compressed)]), stream = method === 8 ? source.pipe(createInflateRaw()) : source;
		const abort = () => stream.destroy(signal.reason instanceof Error ? signal.reason : new Error("Obscura installation cancelled."));
		signal.addEventListener("abort", abort, { once: true });
		try {
			for await (const chunk of stream) { checkAbort(signal); written += chunk.length; if (written > size) throw new Error("Obscura ZIP exceeds its declared member size."); await writeAll(output, chunk); }
			if (written !== size) throw new Error("Obscura ZIP member is truncated.");
		} finally { signal.removeEventListener("abort", abort); source.destroy(); stream.destroy(); await output.close(); }
		offset += 46 + nameLength + extraLength + commentLength;
	}
	if (offset !== end || found.size !== asset.members.length) throw new Error("Obscura ZIP is missing a required executable.");
}

/** Install the exact pinned release. Existing versions and another process's completed install are preserved. */
export async function installObscura(options: ObscuraInstallOptions = {}, dependencies: ObscuraInstallDependencies = {}): Promise<string> {
	options.signal?.throwIfAborted();
	const platform = dependencies.platform ?? process.platform, arch = dependencies.arch ?? process.arch;
	const release = dependencies.manifest ?? manifest(), asset = release.assets[`${platform}-${arch}`];
	const maxArchive = dependencies.maxArchiveBytes ?? MAX_ARCHIVE_BYTES, maxExtracted = dependencies.maxExtractedBytes ?? MAX_EXTRACTED_BYTES;
	if (!asset) throw new Error(`No pinned Obscura binary is available for ${platform}/${arch}. Install Obscura manually and set OBSCURA_BIN to its absolute executable path.`);
	const members = platform === "win32" ? ["obscura.exe", "obscura-worker.exe"] : ["obscura", "obscura-worker"];
	if (release.repository !== REPOSITORY || release.version !== OBSCURA_VERSION || release.tag !== `v${OBSCURA_VERSION}` || !/^[a-f0-9]{40}$/.test(release.commit) || release.variant !== "no-render" || !/^obscura-[a-z0-9_-]+\.(tar\.gz|zip)$/.test(asset.filename) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > maxArchive || !["tar.gz", "zip"].includes(asset.format) || JSON.stringify(asset.members) !== JSON.stringify(members)) throw new Error("Invalid pinned Obscura release metadata.");
	const target = installRoot(dependencies.home, platform, arch), existing = managedExecutable(target, asset);
	if (existing) return existing;
	if (existsSync(target)) throw new Error(`The Obscura install is incomplete: ${target}. Move that directory aside and run rein web install again.`);
	const controller = new AbortController();
	const abort = () => controller.abort(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Obscura installation cancelled."));
	options.signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => controller.abort(new Error("Obscura installation exceeded its three-minute download and extraction budget. Try rein web install again.")), dependencies.timeoutMs ?? INSTALL_TIMEOUT_MS);
	let temporary: string | undefined;
	try {
		checkAbort(controller.signal); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		temporary = await mkdtemp(join(dirname(target), ".install-")); await chmod(temporary, 0o700);
		const archive = join(temporary, "archive"), stage = join(temporary, "runtime"); await mkdir(stage, { mode: 0o700 });
		options.onProgress?.(`Downloading Obscura ${OBSCURA_VERSION} for ${platform}/${arch} (${Math.ceil(asset.bytes / 1024 / 1024)} MiB)…`);
		await download(asset, archive, controller.signal, dependencies.fetch ?? globalThis.fetch, maxArchive);
		checkAbort(controller.signal); options.onProgress?.("Obscura SHA-256 verified. Installing the pinned runtime…");
		if (asset.format === "tar.gz") await extractTar(archive, stage, asset, controller.signal, maxExtracted);
		else await extractZip(archive, stage, asset, controller.signal, maxExtracted);
		checkAbort(controller.signal);
		await writeFile(join(stage, "install.json"), JSON.stringify({ version: OBSCURA_VERSION, commit: release.commit, sha256: asset.sha256, asset: asset.filename }) + "\n", { mode: 0o600, flag: "wx" });
		checkAbort(controller.signal);
		try { await rename(stage, target); }
		catch (error) { const concurrent = managedExecutable(target, asset); if (concurrent) return concurrent; throw error; }
		return join(target, members[0]);
	} finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); if (temporary) await rm(temporary, { recursive: true, force: true }); }
}

export async function ensureObscura(options: ObscuraInstallOptions & { bin?: string } = {}): Promise<string> {
	options.signal?.throwIfAborted();
	return resolveObscura(options.bin) ?? await installObscura(options);
}
