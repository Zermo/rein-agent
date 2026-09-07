/** Owned, headless llama.cpp server. No model/runtime downloads or detached PID adoption. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { matchCatalog } from "../hardware/catalog.ts";
import { profileHardware, type HardwareProfile } from "../hardware/profile.ts";
import { verifyInstalledModel, type InstalledModel } from "./artifacts.ts";
import { chatCompletionText, chatCompletionReasoning } from "../ai/openai-completions.ts";

export const DEFAULT_MODEL_PORT = 11436;
const GiB = 1024 ** 3;
export interface ServingOptions { runtime?: string; port?: number; context?: number; gpuLayers?: number; threads?: number }
export interface ServingPlan {
	command: string; args: string[]; baseUrl: string; context: number; modelId: string; port: number;
	gpuLayers: number; estimatedMemoryBytes: number; notes: string[];
}
export interface RunModelOptions extends ServingOptions {
	home?: string; signal?: AbortSignal; log?: (text: string) => void;
	onReady?: (plan: ServingPlan) => void; readyTimeoutMs?: number;
}
interface RuntimeDependencies {
	verify?: typeof verifyInstalledModel;
	hardware?: () => Promise<HardwareProfile>;
	/** Fixtures may use a script runtime, but production always spawns argv directly. */
	spawn?: typeof spawn;
}
function integer(value: number, name: string, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
	return value;
}
export function validateModelId(id: string): string {
	if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid installed model ID; expected a 64-character artifact digest.");
	return id;
}
function runtimeName(value: string): string {
	if (!value || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("-") || (!isAbsolute(value) && /[/\\]/.test(value))) throw new Error("Runtime must be an absolute executable path or a command name on PATH, without control characters.");
	return value;
}
/** Pure argv plan. Filesystem integrity and current memory are checked again at launch. */
export function servingPlan(model: InstalledModel, options: ServingOptions = {}): ServingPlan {
	const modelId = validateModelId(model.artifact.id), command = runtimeName(options.runtime ?? "llama-server");
	if (!isAbsolute(model.path) || /[\x00-\x1f\x7f]/.test(model.path)) throw new Error("Installed model path must be absolute and contain no control characters.");
	if (!Number.isSafeInteger(model.artifact.sizeBytes) || model.artifact.sizeBytes < 1) throw new Error("Installed artifact size is invalid.");
	const port = integer(options.port ?? DEFAULT_MODEL_PORT, "Port", 1024, 65535);
	const context = integer(options.context ?? 4096, "Context", 256, 131072);
	const gpuLayers = integer(options.gpuLayers ?? 0, "GPU layers", 0, 999);
	const known = matchCatalog(model.artifact.repo);
	if (known && context > known.contextLength) throw new Error(`Context exceeds the catalog limit of ${known.contextLength} for this model.`);
	const kv = known?.kv;
	const kvBytes = kv ? 4 * kv.layers * kv.heads * kv.headDim * context : context * 512 * 1024;
	const estimatedMemoryBytes = model.artifact.sizeBytes + kvBytes + Math.max(GiB, model.artifact.sizeBytes * 0.1);
	const args = ["--model", model.path, "--alias", modelId, "--host", "127.0.0.1", "--port", String(port), "--ctx-size", String(context), "--parallel", "1", "--gpu-layers", String(gpuLayers), "--split-mode", "none", "--cache-type-k", "f16", "--cache-type-v", "f16", "--no-webui"];
	if (options.threads !== undefined) args.push("--threads", String(integer(options.threads, "Threads", 1, 1024)));
	return { command, args, baseUrl: `http://127.0.0.1:${port}/v1`, context, modelId, port, gpuLayers, estimatedMemoryBytes,
		notes: ["One local sequence; CPU is the default. GPU layers use one device and must be chosen explicitly.",
			kv ? "Memory is an estimate using exact artifact bytes and catalog f16 KV geometry." : "Unknown KV geometry: memory preflight reserves 512 KiB per context token; actual allocation can differ.",
			"Dedicated VRAM can satisfy preflight only for full catalog-layer offload to one unmasked GPU. Other layouts must fit the RAM estimate.",
			"Startup validates JSON Chat Completions. This does not establish tool-use quality, streaming compatibility, or sustained performance."] };
}
function modelHome(home?: string): string {
	const root = home ?? process.env.REIN_HOME ?? join(homedir(), ".rein");
	if (!isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root)) throw new Error("REIN_HOME must be an absolute path without control characters.");
	return resolve(root);
}
function keyPath(id: string, home?: string): string { return join(modelHome(home), "models", "connections", `${validateModelId(id)}.key`); }
async function privateParents(path: string, home?: string, create = false): Promise<void> {
	const root = modelHome(home);
	for (const directory of [root, join(root, "models"), dirname(path)]) {
		if (create) { try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
		const stat = await lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Model connection directory must be owned by the user and cannot be a symlink or writable by other users.");
	}
}
async function readKey(path: string): Promise<string> {
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 65 || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Model API key must be an owned, ordinary 0600 file.");
		const key = (await file.readFile("utf8")).trim();
		if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Model API key file is invalid; it was preserved.");
		return key;
	} finally { await file.close(); }
}
async function ensureKey(id: string, home?: string): Promise<string> {
	const path = keyPath(id, home); await privateParents(path, home, true);
	try {
		const file = await open(path, "wx", 0o600);
		try { await file.writeFile(`${randomBytes(32).toString("hex")}\n`); } finally { await file.close(); }
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	return readKey(path);
}
/** Explicit connection handoff only. Never creates a credential or logs it. */
export async function readModelConnection(id: string, options: { home?: string; port?: number } = {}): Promise<{ baseUrl: string; model: string; apiKey: string; context?: number }> {
	const path = keyPath(id, options.home); await privateParents(path, options.home);
	let state: any;
	try { state = await ownedJson(`${path}.ready`); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (!state) throw new Error("Model is not ready. Start rein model serve or its user service, then retry.");
	if (state.version !== 1 || state.id !== id) throw new Error("Model connection state is invalid; it was preserved.");
	if (options.port !== undefined && options.port !== state.port) throw new Error("The requested port does not match this model's ready server. Check its serving command or service.");
	const port = integer(options.port ?? state?.port ?? DEFAULT_MODEL_PORT, "Port", 1024, 65535);
	const context = state && state.port === port ? integer(state.context, "Context", 256, 131072) : undefined;
	return { baseUrl: `http://127.0.0.1:${port}/v1`, model: validateModelId(id), apiKey: await readKey(path), ...(context ? { context } : {}) };
}
async function ownedJson(path: string): Promise<any> {
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Model runtime state must be an owned, ordinary 0600 file.");
		return JSON.parse(await file.readFile("utf8"));
	} finally { await file.close(); }
}
/** PID is used only to reject/reclaim a stale lease, never to adopt or signal a server. */
async function modelLease(id: string, home?: string): Promise<{ ready(plan: ServingPlan): Promise<void>; release(): Promise<void> }> {
	const key = keyPath(id, home), lock = `${key}.lock`, state = `${key}.ready`;
	await privateParents(key, home, true);
	const token = randomBytes(32).toString("hex");
	const record = { version: 1, id, pid: process.pid, token };
	for (let attempt = 0; ; attempt++) {
		try { await writeFile(lock, JSON.stringify(record), { flag: "wx", mode: 0o600 }); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
			const prior = await ownedJson(lock);
			if (prior.version !== 1 || prior.id !== id || !Number.isSafeInteger(prior.pid) || prior.pid < 1 || !/^[a-f0-9]{64}$/.test(prior.token ?? "")) throw new Error("Model ownership lease is invalid; it was preserved.");
			let alive = true;
			try { process.kill(prior.pid, 0); } catch (probeError) { if ((probeError as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
			if (alive) throw new Error("This model already has a serving owner. Stop its foreground command or scoped service first.");
			// Serialize stale-owner recovery. A second reclaimer must never unlink
			// the replacement owner's lease in the check/delete gap.
			const recovery = `${lock}.recovery`;
			try { await writeFile(recovery, JSON.stringify(record), { flag: "wx", mode: 0o600 }); }
			catch (recoveryError) { if ((recoveryError as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Model lease recovery is in progress or was interrupted. Inspect the model's .lock.recovery file after stopping its service before retrying."); throw recoveryError; }
			try {
				if (JSON.stringify(await ownedJson(lock)) !== JSON.stringify(prior)) throw new Error("Model ownership changed while checking a stale lease.");
				await unlink(lock);
				await writeFile(lock, JSON.stringify(record), { flag: "wx", mode: 0o600 });
				break;
			} finally { if ((await ownedJson(recovery)).token === token) await unlink(recovery); }
		}
	}
	const owned = async () => (await ownedJson(lock)).token === token;
	return {
		async ready(plan) {
			if (!await owned()) throw new Error("Model ownership lease changed.");
			try { const prior = await ownedJson(state); if (prior.version !== 1 || prior.id !== id) throw new Error("Unrelated model connection state was preserved."); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			const temp = `${state}.${token}.tmp`;
			try { await writeFile(temp, JSON.stringify({ version: 1, id, port: plan.port, context: plan.context, token }), { flag: "wx", mode: 0o600 }); await rename(temp, state); }
			finally { try { await unlink(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
		},
		async release() {
			if (!await owned()) throw new Error("Model ownership lease changed; its files were preserved.");
			try { if ((await ownedJson(state)).token === token) await unlink(state); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			await unlink(lock);
		},
	};
}
async function assertPortFree(port: number): Promise<void> {
	await new Promise<void>((resolvePort, reject) => {
		const probe = createServer();
		probe.once("error", () => reject(new Error(`Port ${port} is already in use or unavailable. Choose another port; no existing process was changed.`)));
		probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(error => error ? reject(error) : resolvePort()));
	});
}
function memoryPreflight(plan: ServingPlan, profile: HardwareProfile, model: InstalledModel): void {
	if (!Number.isFinite(profile.ram.totalBytes) || !Number.isFinite(profile.ram.availableBytes) || profile.ram.totalBytes <= 0 || profile.ram.availableBytes < 0) throw new Error("Available system memory could not be verified; no model process was started.");
	const reserve = Math.max(GiB, profile.ram.totalBytes * 0.1);
	const ram = Math.max(0, Math.min(profile.ram.totalBytes, profile.ram.availableBytes) - reserve);
	// Partial offload does not move the whole model into VRAM. Driver probes do
	// not establish runtime ordering under visibility masks or multiple GPUs.
	const firstGpu = profile.gpus[0], layers = matchCatalog(model.artifact.repo)?.kv?.layers;
	const masked = ["CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "GGML_VK_VISIBLE_DEVICES"].some(name => process.env[name] !== undefined);
	const fullOffload = layers !== undefined && plan.gpuLayers > layers && profile.gpus.length === 1 && !masked;
	const free = Math.min(firstGpu?.vramFreeBytes ?? 0, firstGpu?.vramTotalBytes ?? 0);
	const gpu = fullOffload && !profile.unifiedMemory && !firstGpu?.sharedMemory && Number.isFinite(free) ? Math.max(0, free - GiB) : 0;
	if (plan.estimatedMemoryBytes > Math.max(ram, gpu)) throw new Error(`Memory preflight needs about ${(plan.estimatedMemoryBytes / GiB).toFixed(1)} GiB plus reserve in one available memory pool. Free memory, lower --context, or choose a smaller model. This is a planning estimate, not a benchmark.`);
}
/** HTTP only to the exact loopback listener; redirects are never followed. */
async function jsonRequest(plan: ServingPlan, path: string, key: string, signal: AbortSignal, body?: unknown): Promise<any> {
	return new Promise((resolveJson, reject) => {
		const encoded = body === undefined ? undefined : JSON.stringify(body);
		const req = request({ hostname: "127.0.0.1", port: plan.port, path, method: encoded ? "POST" : "GET", signal,
			headers: { Authorization: `Bearer ${key}`, ...(encoded ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) } : {}) } }, response => {
			let bytes = 0; const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 128 * 1024) req.destroy(new Error("Model health response exceeded its limit.")); else chunks.push(chunk); });
			response.on("error", reject);
			response.on("end", () => {
				if (response.statusCode !== 200) { reject(new Error(`Model health request returned HTTP ${response.statusCode}.`)); return; }
				try { resolveJson(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Model health response was not JSON.")); }
			});
		});
		const timer = setTimeout(() => req.destroy(new Error("Model health request timed out.")), encoded ? 30_000 : 2000);
		req.on("close", () => clearTimeout(timer)); req.on("error", reject);
		req.end(encoded);
	});
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolvePause, reject) => {
		const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("Model server cancelled.")); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolvePause(); }, ms);
		signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
	});
}
/** Owns the foreground child until it exits. Abort stops only this process group. */
export async function runModelServer(id: string, options: RunModelOptions = {}, dependencies: RuntimeDependencies = {}): Promise<ServingPlan> {
	options.signal?.throwIfAborted();
	const installed = await (dependencies.verify ?? verifyInstalledModel)(validateModelId(id), { home: options.home, signal: options.signal });
	const plan = servingPlan(installed, options);
	const readyTimeoutMs = integer(options.readyTimeoutMs ?? 120_000, "Readiness timeout", 100, 30 * 60_000);
	memoryPreflight(plan, await (dependencies.hardware ?? profileHardware)(), installed);
	options.signal?.throwIfAborted(); await assertPortFree(plan.port);
	const lease = await modelLease(id, options.home);
	try {
	const key = await ensureKey(id, options.home);
	options.signal?.throwIfAborted();
	const keep = new Set(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "GGML_VK_VISIBLE_DEVICES", "OMP_NUM_THREADS"]);
	const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => keep.has(name)));
	env.LLAMA_API_KEY = key;
	const child = (dependencies.spawn ?? spawn)(plan.command, plan.args, { shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env });
	const controller = new AbortController();
	const redact = (value: string) => value.split(key).join("[redacted]").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
	let diagnostic = "", stopping = false, ready = false, exited = false, failure: Error | undefined;
	let stopTimer: ReturnType<typeof setTimeout> | undefined;
	let drain: Promise<void> | undefined;
	const kill = (signal: NodeJS.Signals) => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
	const stop = () => { if (stopping) return; stopping = true; controller.abort(new Error("Model server stopped.")); kill("SIGTERM"); drain = new Promise(resolveDrain => { stopTimer = setTimeout(() => { kill("SIGKILL"); resolveDrain(); }, 1000); }); };
	const externalAbort = () => stop(); options.signal?.addEventListener("abort", externalAbort, { once: true });
	const completion = new Promise<void>(resolveExit => {
		child.once("error", error => { failure = new Error(`Cannot start model runtime: ${redact(error.message)}`); controller.abort(failure); });
		child.once("close", (code, signal) => {
			exited = true;
			if (!stopping && (code !== 0 || !ready)) failure ??= new Error(`Model runtime exited${signal ? ` on ${signal}` : ` with code ${code}`} before it was stopped.${diagnostic ? ` ${redact(diagnostic).slice(-1000)}` : ""}`);
			controller.abort(failure ?? new Error("Model runtime exited."));
			resolveExit();
		});
	});
	for (const stream of [child.stdout, child.stderr]) {
		let line = "";
		stream?.on("data", chunk => {
			diagnostic = (diagnostic + chunk.toString("utf8")).slice(-8192);
			line += chunk.toString("utf8"); const lines = line.split("\n"); line = lines.pop()!.slice(-8192);
			for (const output of lines) options.log?.(redact(output).slice(0, 4096));
		});
	}
	if (options.signal?.aborted) stop();
	const deadline = Date.now() + readyTimeoutMs;
	const readinessTimer = setTimeout(() => controller.abort(new Error("Model server readiness timed out.")), readyTimeoutMs);
	try {
		let lastError: Error | undefined, healthReady = false;
		while (!healthReady && Date.now() < deadline) {
			controller.signal.throwIfAborted();
			try {
				const health = await jsonRequest(plan, "/health", key, controller.signal);
				if (health?.status !== "ok") throw new Error("Model health status was not ok.");
				healthReady = true;
			} catch (error) { lastError = error as Error; if (!controller.signal.aborted) await pause(250, controller.signal); }
		}
		if (!healthReady) throw new Error(`Model server did not become ready: ${lastError?.message ?? "timeout"}`);
		const models = await jsonRequest(plan, "/v1/models", key, controller.signal);
		if (!Array.isArray(models?.data) || !models.data.some((entry: any) => entry?.id === id)) throw new Error("The owned server did not advertise the selected model.");
		const chat = await jsonRequest(plan, "/v1/chat/completions", key, controller.signal, { model: id, messages: [{ role: "user", content: "Reply with a short greeting." }], max_tokens: 128, temperature: 0, stream: false });
		const choice = chat?.choices?.[0], message = choice?.message;
		if (chat?.error || !message || ["content_filter", "aborted"].includes(choice?.finish_reason) || !(chatCompletionText(message).trim() || chatCompletionReasoning(message).trim())) throw new Error("The owned server returned no usable Chat Completion.");
		controller.signal.throwIfAborted();
		if (exited) throw new Error("Model runtime stopped during readiness checks.");
		ready = true; await lease.ready(plan); controller.signal.throwIfAborted();
		clearTimeout(readinessTimer); options.onReady?.(plan);
		await completion;
		if (failure) throw failure;
		return plan;
	} catch (error) {
		if (options.signal?.aborted) { stop(); await completion; return plan; }
		stop(); await completion;
		throw failure ?? new Error(redact((error as Error).message));
	} finally {
		clearTimeout(readinessTimer); options.signal?.removeEventListener("abort", externalAbort);
		if (!exited) { stop(); await completion; }
		await drain;
		if (stopTimer) clearTimeout(stopTimer);
	}
	} finally { await lease.release(); }
}
