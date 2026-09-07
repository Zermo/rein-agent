/** Managed single-file GGUFs. Hub metadata pins the commit, size and LFS SHA256;
 * model cards, remote Python and repository scripts are never executed. */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, statfs, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ModelArtifact { schemaVersion: 1; id: string; repo: string; revision: string; file: string; sha256: string; sizeBytes: number; url: string }
export interface InstalledModel { artifact: ModelArtifact; path: string; installedAt: string }
interface Options { home?: string; token?: string; signal?: AbortSignal; onProgress?: (received: number, total: number) => void }
/** Fixture seams, deliberately absent from CLI/config. URLs are still validated. */
export interface ModelArtifactDependencies { fetch?: typeof fetch; freeDiskBytes?: (directory: string) => Promise<number>; stallMs?: number }
const HEX = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/;
const METADATA_LIMIT = 4 * 1024 ** 2, MANIFEST_LIMIT = 16 * 1024, RESERVE = 64 * 1024 ** 2;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new Error("Model operation cancelled."); }
function validateRepo(repo: string) {
	if (typeof repo !== "string" || repo.length > 193 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repo) || repo.includes("..") || repo.includes("--") || repo.split("/").some(p => /[.-]$/.test(p))) throw new Error("Use a Hugging Face model repository in owner/name form.");
}
function validateFile(file: string) {
	if (typeof file !== "string" || file.length > 512 || !/^[A-Za-z0-9_./+ -]+\.gguf$/i.test(file) || file.split("/").some(p => !p || p === "." || p === ".." || /[. ]$/.test(p))) throw new Error("Choose an explicit repository-relative .gguf file without traversal or special URL characters.");
	if (/-\d{5}-of-\d{5}\.gguf$/i.test(file)) throw new Error("Split GGUF shards are not supported yet. Choose a single-file GGUF or use an existing model server.");
}
function validateRevision(revision: string) {
	if (typeof revision !== "string" || revision.length > 200 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(revision) || revision.split("/").some(p => !p || p === "." || p === "..") || revision.includes("..")) throw new Error("Use a model branch, tag or full commit revision.");
}
function downloadUrl(repo: string, revision: string, file: string) { return `https://huggingface.co/${repo}/resolve/${revision}/${file.split("/").map(encodeURIComponent).join("/")}`; }
function artifactId(repo: string, revision: string, file: string, sha256: string) { return createHash("sha256").update(JSON.stringify([repo, revision, file, sha256])).digest("hex"); }
function validateArtifact(value: ModelArtifact): ModelArtifact {
	if (!value || value.schemaVersion !== 1) throw new Error("Invalid model artifact manifest version.");
	validateRepo(value.repo); validateFile(value.file);
	if (!COMMIT.test(value.revision) || !HEX.test(value.sha256) || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 24 || value.id !== artifactId(value.repo, value.revision, value.file, value.sha256) || value.url !== downloadUrl(value.repo, value.revision, value.file)) throw new Error("Invalid pinned model artifact metadata.");
	// Copy only the schema, excluding credentials or unrelated server fields.
	return { schemaVersion: 1, id: value.id, repo: value.repo, revision: value.revision, file: value.file, sha256: value.sha256, sizeBytes: value.sizeBytes, url: value.url };
}
function allowedUrl(url: string): URL {
	const parsed = new URL(url), host = parsed.hostname;
	const allowed = host === "huggingface.co" || /^cdn-lfs(?:-[a-z0-9-]+)?\.huggingface\.co$/.test(host) || host === "cdn-lfs.hf.co" || host.endsWith(".cdn.hf.co") || host.endsWith(".xethub.hf.co");
	if (!allowed || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash) throw new Error("Model download redirected outside the supported Hugging Face HTTPS hosts.");
	return parsed;
}
function authHeaders(token?: string): Record<string, string> {
	if (token && (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > 512)) throw new Error("Invalid Hugging Face token format.");
	return { "Accept-Encoding": "identity", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
/** Manual redirects keep account credentials on the initial origin only. A timer
 * covers headers and every body read, including a server that never sends data. */
async function request(url: string, headers: Record<string, string>, signal: AbortSignal | undefined, deps: ModelArtifactDependencies) {
	cancelled(signal);
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout>, timedOut = false;
	const touch = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, deps.stallMs ?? 30_000); };
	const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
	const close = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); };
	const fail = () => new Error(signal?.aborted ? "Model operation cancelled." : timedOut ? "Model network request stalled; retry to resume the download." : "Model network request failed; retry or check the connection.");
	let current = allowedUrl(url), currentHeaders = { ...headers };
	try {
		for (let redirects = 0; redirects <= 6; redirects++) {
			touch();
			const response = await (deps.fetch ?? fetch)(current, { headers: currentHeaders, signal: controller.signal, redirect: "manual" });
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const location = response.headers.get("location"); await response.body?.cancel();
				if (!location || redirects === 6) throw new Error("Model download has an invalid or excessive redirect chain.");
				const next = allowedUrl(new URL(location, current).href);
				if (next.origin !== current.origin) { delete currentHeaders.Authorization; delete currentHeaders.authorization; }
				current = next; continue;
			}
			return { response, touch, close, fail };
		}
		throw new Error("Invalid model redirect chain.");
	} catch (error) {
		close();
		if (error instanceof Error && /^(Model download|Invalid model redirect)/.test(error.message)) throw error;
		throw fail();
	}
}
function checkResponse(response: Response) {
	if (response.status === 401 || response.status === 403) throw new Error("Hugging Face access was denied. Supply an authorized token and accept any model access agreement on Hugging Face.");
	if (![200, 206].includes(response.status)) throw new Error(`Hugging Face returned HTTP ${response.status}. Check the repository, revision and file, or retry later.`);
	if (!response.body) throw new Error("Hugging Face returned an empty response.");
	if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") throw new Error("Encoded model responses cannot be verified or resumed safely.");
}
async function readMetadata(url: string, options: { token?: string; signal?: AbortSignal }, deps: ModelArtifactDependencies): Promise<any> {
	const timeout = new AbortController(), deadline = setTimeout(() => timeout.abort(), 20_000);
	const abort = () => timeout.abort(); options.signal?.addEventListener("abort", abort, { once: true });
	let connection: Awaited<ReturnType<typeof request>> | undefined;
	try {
		cancelled(options.signal); connection = await request(url, authHeaders(options.token), timeout.signal, deps);
		checkResponse(connection.response);
		if (connection.response.status !== 200) throw new Error("Expected a complete Hugging Face metadata response.");
		const chunks: Uint8Array[] = []; let size = 0;
		const reader = connection.response.body!.getReader();
		try { while (true) { connection.touch(); const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > METADATA_LIMIT) throw new Error("Model repository metadata exceeds the supported size; select a smaller repository."); chunks.push(value); } }
		catch (error) { if (timeout.signal.aborted) throw new Error(options.signal?.aborted ? "Model operation cancelled." : "Model metadata request timed out."); if (error instanceof Error && error.message.startsWith("Model repository metadata")) throw error; throw connection.fail(); }
		finally { await reader.cancel().catch(() => {}); }
		try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Hugging Face returned invalid model metadata."); }
	} finally { connection?.close(); clearTimeout(deadline); options.signal?.removeEventListener("abort", abort); }
}
/** Hub model_info(files_metadata=True) uses ?blobs=true and exposes siblings[].lfs.
 * https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api#huggingface_hub.HfApi.model_info */
export async function resolveModelArtifact(repo: string, file: string, options: { revision?: string; token?: string; signal?: AbortSignal } = {}, deps: ModelArtifactDependencies = {}): Promise<ModelArtifact> {
	validateRepo(repo); validateFile(file); const revision = options.revision ?? "main"; validateRevision(revision);
	const metadata = await readMetadata(`https://huggingface.co/api/models/${repo}/revision/${encodeURIComponent(revision)}?blobs=true`, options, deps);
	if (!metadata || !COMMIT.test(metadata.sha) || !Array.isArray(metadata.siblings)) throw new Error("Hub metadata did not provide a full immutable model commit and file list.");
	if (COMMIT.test(revision) && metadata.sha !== revision) throw new Error("Hub metadata did not match the explicitly requested model commit.");
	const matches = metadata.siblings.filter((entry: any) => entry?.rfilename === file);
	if (matches.length !== 1) throw new Error("The selected GGUF file was not uniquely found at this model revision.");
	const entry = matches[0], sha256 = entry.lfs?.sha256, sizeBytes = entry.lfs?.size;
	if (!HEX.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 24 || (entry.size !== undefined && entry.size !== sizeBytes)) throw new Error("The selected file has no consistent LFS SHA256 and size. Choose a published, single-file GGUF with verifiable metadata.");
	return validateArtifact({ schemaVersion: 1, id: artifactId(repo, metadata.sha, file, sha256), repo, revision: metadata.sha, file, sha256, sizeBytes, url: downloadUrl(repo, metadata.sha, file) });
}

async function directory(path: string, create: boolean, privateMode = true) {
	if (create) { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (privateMode && (info.mode & 0o077) !== 0)) throw new Error("Managed model storage must use private, owned directories without symbolic links.");
	return path;
}
async function storage(home: string | undefined, create = false): Promise<string> {
	const base = resolve(home ?? process.env.REIN_HOME ?? join(homedir(), ".rein"));
	if (create) await mkdir(base, { recursive: true, mode: 0o700 });
	await directory(base, false, false);
	const canonical = await realpath(base);
	const models = await directory(join(canonical, "models"), create);
	return directory(join(models, "artifacts"), create);
}
async function safeOpen(path: string, flags: number): Promise<FileHandle> {
	// O_NOFOLLOW is not available on every platform; reject existing links before
	// opening too, so O_CREAT cannot create the target of a dangling symlink.
	try { const existing = await lstat(path); if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error("Managed model files must be ordinary files without symbolic or hard links."); } catch (error) { if (!missing(error)) throw error; }
	const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0), 0o600);
	try { const info = await handle.stat(); const named = await lstat(path); if (!info.isFile() || info.nlink !== 1 || named.isSymbolicLink() || info.ino !== named.ino || info.dev !== named.dev || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Managed model files must be ordinary, owned files without symbolic or hard links."); return handle; }
	catch (error) { await handle.close(); throw error; }
}
async function jsonFile(path: string): Promise<any> {
	const file = await safeOpen(path, constants.O_RDONLY);
	try { const stat = await file.stat(); if (stat.size > MANIFEST_LIMIT) throw new Error("Model manifest exceeds its size limit."); return JSON.parse(await file.readFile("utf8")); }
	finally { await file.close(); }
}
async function manifest(root: string, id: string): Promise<InstalledModel> {
	if (!HEX.test(id)) throw new Error("Use the model ID printed by rein models list.");
	const dir = await directory(join(root, id), false), data = await jsonFile(join(dir, "manifest.json")), artifact = validateArtifact(data.artifact);
	if (artifact.id !== id || typeof data.installedAt !== "string" || !Number.isFinite(Date.parse(data.installedAt))) throw new Error("Invalid installed model manifest.");
	return { artifact, path: join(dir, "model.gguf"), installedAt: data.installedAt };
}
async function verifyHandle(handle: FileHandle, artifact: ModelArtifact, signal?: AbortSignal) {
	cancelled(signal); const info = await handle.stat();
	if (info.nlink !== 1 || info.size !== artifact.sizeBytes) throw new Error("Installed model size or link count changed; the existing file was preserved.");
	const buffer = Buffer.allocUnsafe(1024 * 1024), hash = createHash("sha256"); let offset = 0;
	while (offset < info.size) {
		cancelled(signal); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
		if (!bytesRead) throw new Error("Model file changed during verification.");
		if (offset === 0 && (bytesRead < 24 || buffer.toString("ascii", 0, 4) !== "GGUF" || ![2, 3].includes(buffer.readUInt32LE(4)))) throw new Error("The downloaded file is not a supported GGUF model (expected GGUF version 2 or 3).");
		hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
	}
	const after = await handle.stat();
	if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.nlink !== 1 || hash.digest("hex") !== artifact.sha256) throw new Error("Model SHA256 verification failed; no new model was published.");
}
export async function listInstalledModels(options: { home?: string } = {}): Promise<InstalledModel[]> {
	let root: string; try { root = await storage(options.home); } catch (error) { if (missing(error)) return []; throw error; }
	const result: InstalledModel[] = [];
	for (const id of (await readdir(root)).sort()) { if (!HEX.test(id)) continue; try { result.push(await manifest(root, id)); } catch (error) { if (!missing(error)) throw error; } }
	return result;
}
export async function verifyInstalledModel(id: string, options: { home?: string; signal?: AbortSignal } = {}): Promise<InstalledModel> {
	const installed = await manifest(await storage(options.home), id), file = await safeOpen(installed.path, constants.O_RDONLY);
	try { await verifyHandle(file, installed.artifact, options.signal); } finally { await file.close(); }
	return installed;
}
async function writeAll(file: FileHandle, bytes: Uint8Array, offset: number) {
	let written = 0;
	while (written < bytes.length) { const result = await file.write(bytes, written, bytes.length - written, offset + written); if (!result.bytesWritten) throw new Error("Unable to write model bytes."); written += result.bytesWritten; }
}
async function download(artifact: ModelArtifact, file: FileHandle, offset: number, options: Options, deps: ModelArtifactDependencies) {
	const headers = authHeaders(options.token); if (offset) headers.Range = `bytes=${offset}-`;
	const connection = await request(artifact.url, headers, options.signal, deps);
	try {
		const response = connection.response; checkResponse(response);
		if (/text\/html|application\/json/i.test(response.headers.get("content-type") ?? "")) throw new Error("Model endpoint returned a document instead of GGUF data.");
		const restart = offset > 0 && response.status === 200;
		if (restart) offset = 0;
		if (response.status === 206) {
			const expected = `bytes ${offset}-${artifact.sizeBytes - 1}/${artifact.sizeBytes}`;
			if (response.headers.get("content-range") !== expected) throw new Error("Model resume response has an incorrect Content-Range; partial data was preserved.");
		} else if (response.headers.has("content-range")) throw new Error("Unexpected Content-Range on a complete model response.");
		const length = response.headers.get("content-length");
		if (length !== null && (!/^\d+$/.test(length) || Number(length) !== artifact.sizeBytes - offset)) throw new Error("Model response length does not match pinned metadata.");
		if (restart) await file.truncate(0);
		const reader = response.body!.getReader();
		try {
			options.onProgress?.(offset, artifact.sizeBytes);
			while (true) {
				cancelled(options.signal); connection.touch();
				let chunk: ReadableStreamReadResult<Uint8Array>; try { chunk = await reader.read(); } catch { throw connection.fail(); }
				if (chunk.done) break;
				if (offset + chunk.value.length > artifact.sizeBytes) throw new Error("Model download exceeded its pinned size; no new model was published.");
				await writeAll(file, chunk.value, offset); offset += chunk.value.length; options.onProgress?.(offset, artifact.sizeBytes);
			}
			if (offset !== artifact.sizeBytes) throw new Error("Model download ended early; retry to resume the partial download.");
		} finally { await reader.cancel().catch(() => {}); }
	} finally { connection.close(); }
}
async function acquireLock(root: string, id: string) {
	if (!HEX.test(id)) throw new Error("Use the model ID printed by rein models list.");
	const path = join(root, `${id}.lock`);
	let file: FileHandle;
	try { file = await safeOpen(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another install owns this model lock. Wait for it to finish; after a crashed process, inspect and remove only this model's .lock file before retrying."); throw error; }
	return { file, release: async () => { await file.close(); await unlink(path); } };
}
export async function installModelArtifact(input: ModelArtifact, options: Options = {}, deps: ModelArtifactDependencies = {}): Promise<InstalledModel> {
	cancelled(options.signal); const artifact = validateArtifact(input), root = await storage(options.home, true), lock = await acquireLock(root, artifact.id);
	let partial: FileHandle | undefined;
	try {
		await lock.file.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
		const dir = await directory(join(root, artifact.id), true), partialPath = join(dir, "download.part"), finalPath = join(dir, "model.gguf");
		try { await manifest(root, artifact.id); return await verifyInstalledModel(artifact.id, options); } catch (error) { if (!missing(error)) throw error; }
		// Recover publication interrupted after verified model rename but before manifest.
		let completed = false;
		try { const file = await safeOpen(finalPath, constants.O_RDONLY); try { await verifyHandle(file, artifact, options.signal); completed = true; } finally { await file.close(); } } catch (error) { if (!missing(error)) throw error; }
		if (!completed) {
			partial = await safeOpen(partialPath, constants.O_RDWR | constants.O_CREAT);
			const offset = (await partial.stat()).size;
			if (offset > artifact.sizeBytes) throw new Error("Partial model exceeds the pinned size; remove this model's download.part file before retrying.");
			const free = deps.freeDiskBytes ? await deps.freeDiskBytes(dir) : await statfs(dir).then(s => s.bavail * s.bsize);
			if (!Number.isFinite(free) || free < artifact.sizeBytes - offset + RESERVE) throw new Error("Insufficient free disk space for this model and a 64 MiB safety reserve.");
			if (offset < artifact.sizeBytes) await download(artifact, partial, offset, options, deps);
			await partial.sync();
			try { await verifyHandle(partial, artifact, options.signal); } catch (error) { if (!options.signal?.aborted) { await partial.close(); partial = undefined; await unlink(partialPath); } throw error; }
			await partial.close(); partial = undefined; cancelled(options.signal);
			await directory(root, false); await directory(dir, false); await rename(partialPath, finalPath);
		}
		cancelled(options.signal);
		const installed = { artifact, path: finalPath, installedAt: new Date().toISOString() }, temporary = join(dir, `manifest-${randomBytes(8).toString("hex")}.tmp`);
		try {
			const manifestFile = await safeOpen(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
			try { await manifestFile.writeFile(JSON.stringify({ artifact, installedAt: installed.installedAt }, null, 2) + "\n"); await manifestFile.sync(); } finally { await manifestFile.close(); }
			await rename(temporary, join(dir, "manifest.json"));
		} finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
		return installed;
	} finally { try { await partial?.close(); } finally { await lock.release(); } }
}

/** The caller must stop any serving process first. Unknown contents are preserved. */
export async function removeInstalledModel(id: string, options: { home?: string } = {}): Promise<void> {
	if (!HEX.test(id)) throw new Error("Use the model ID printed by rein models list.");
	const root = await storage(options.home), lock = await acquireLock(root, id);
	try {
		await manifest(root, id); const dir = await directory(join(root, id), false), names = await readdir(dir);
		if (names.some(name => !["model.gguf", "manifest.json", "download.part"].includes(name))) throw new Error("Model directory contains unexpected files; nothing was removed.");
		for (const name of names) { const file = await safeOpen(join(dir, name), constants.O_RDONLY); await file.close(); }
		// Unlinking exact, checked names cannot recursively follow a directory link.
		await storage(options.home); await directory(dir, false);
		for (const name of names.filter(name => name !== "manifest.json")) await unlink(join(dir, name));
		await unlink(join(dir, "manifest.json")); await rmdir(dir);
	} finally { await lock.release(); }
}
