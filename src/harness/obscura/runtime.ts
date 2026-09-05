import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { loadConfig } from "../../ai/models.ts";
import { ensureObscura } from "./install.ts";

export interface WebOptions { bin?: string; timeoutSeconds: number; allowPrivateNetwork: boolean; }

export function webOptions(): WebOptions {
	const config = loadConfig().obscura;
	if (config !== undefined && (!config || typeof config !== "object" || Array.isArray(config))) throw new Error("obscura config must be an object.");
	const bin = process.env.OBSCURA_BIN ?? config?.bin;
	if (bin !== undefined && (typeof bin !== "string" || !bin.trim())) throw new Error("OBSCURA_BIN or obscura.bin must be an absolute executable path.");
	const timeoutSeconds = config?.timeoutSeconds ?? 30;
	if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) throw new Error("obscura.timeoutSeconds must be an integer from 1 to 120.");
	if (config?.allowPrivateNetwork !== undefined && typeof config.allowPrivateNetwork !== "boolean") throw new Error("obscura.allowPrivateNetwork must be true or false.");
	const privateNetwork = process.env.OBSCURA_ALLOW_PRIVATE_NETWORK;
	if (privateNetwork !== undefined && !/^(?:0|1|false|true)$/.test(privateNetwork)) throw new Error("OBSCURA_ALLOW_PRIVATE_NETWORK must be 0, 1, false, or true.");
	return { bin, timeoutSeconds, allowPrivateNetwork: privateNetwork === undefined ? config?.allowPrivateNetwork ?? false : privateNetwork === "1" || privateNetwork === "true" };
}

export function cleanWebText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function httpUrl(value: unknown, name = "url"): URL {
	if (typeof value !== "string" || !value.trim() || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw new Error(`${name} must be an HTTP(S) URL without whitespace.`);
	let url: URL;
	try { url = new URL(value); } catch { throw new Error(`${name} must be a valid HTTP(S) URL.`); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${name} must use HTTP(S) without embedded credentials.`);
	return url;
}

/** Each call has a fresh storage directory and an owned, cancellable process. */
export async function evaluatePage(url: URL, expression: string, signal?: AbortSignal, onProgress?: (text: string) => void): Promise<unknown> {
	signal?.throwIfAborted();
	const options = webOptions();
	const executable = await ensureObscura({ bin: options.bin, signal, onProgress });
	signal?.throwIfAborted();
	const directory = await mkdtemp(join(tmpdir(), "rein-obscura-page-"));
	try {
		signal?.throwIfAborted();
		onProgress?.(`Obscura: reading ${url.hostname}`);
		const args = [...(options.allowPrivateNetwork ? ["--allow-private-network"] : []), "fetch", url.href, "--quiet", "--timeout", String(options.timeoutSeconds), "--storage-dir", directory, "--eval", expression];
		const stdout = await runObscura(executable, args, directory, options.timeoutSeconds, signal);
		try { return JSON.parse(stdout); } catch { throw new Error("Obscura returned invalid extraction data. Update the configured binary or run rein web install."); }
	} finally { await rm(directory, { recursive: true, force: true }); }
}

function browserEnvironment(): NodeJS.ProcessEnv {
	const names = new Set(["PATH", "SystemRoot", "WINDIR", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "OBSCURA_PROXY", "OBSCURA_FETCH_TIMEOUT_MS", "OBSCURA_SCRIPT_DEADLINE_MS", "OBSCURA_MODULE_BUDGET_MS", "OBSCURA_TIMEZONE"]);
	return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name))), RUST_LOG: "error", NO_COLOR: "1" };
}

function runObscura(executable: string, args: string[], cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { cwd, env: browserEnvironment(), detached: process.platform !== "win32", shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "", bytes = 0, closed = false, settled = false, exitCode: number | null = null, error: Error | undefined;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const kill = (value: NodeJS.Signals) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, value); else child.kill(value); } catch { /* Already exited. */ } };
		const finish = () => {
			if (settled || !closed || escalation) return;
			settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else if (exitCode !== 0) reject(new Error(`Obscura exited ${exitCode ?? "with a signal"}: ${cleanWebText(stderr).trim().slice(-1500) || "page navigation failed"}`));
			else resolve(stdout);
		};
		const stop = (message: string) => {
			if (error) return;
			error = new Error(message); kill("SIGTERM");
			// Await group escalation even if the parent closes first.
			escalation = setTimeout(() => { kill("SIGKILL"); escalation = undefined; finish(); }, 250);
		};
		const abort = () => stop("Obscura operation aborted.");
		const timer = setTimeout(() => stop(`Obscura timed out after ${timeoutSeconds + 10}s.`), (timeoutSeconds + 10) * 1000);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
		child.stdout.on("data", (text: string) => { bytes += Buffer.byteLength(text); if (bytes > 2 * 1024 * 1024) stop("Obscura output exceeded 2 MB."); else stdout += text; });
		child.stderr.on("data", (text: string) => { bytes += Buffer.byteLength(text); stderr = (stderr + text).slice(-4000); if (bytes > 2 * 1024 * 1024) stop("Obscura output exceeded 2 MB."); });
		child.on("error", (cause: NodeJS.ErrnoException) => { error ??= new Error(cause.code === "ENOENT" ? "Obscura executable is missing. Run rein web install or correct OBSCURA_BIN." : cleanWebText(cause.message)); closed = true; finish(); });
		child.on("close", code => { exitCode = code; closed = true; finish(); });
	});
}
