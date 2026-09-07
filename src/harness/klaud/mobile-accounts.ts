/** Mobile account setup. Official CLIs own their credentials; only device challenges leave the host. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig, saveConfig } from "../../ai/config.ts";
import { apiKeyFor, normalizeBaseUrl, PROVIDER_PRESETS } from "../../ai/models.ts";
import { CLI_PROVIDERS, cliAuthDirectory, cliEnvironment, prepareCliProfile } from "../../ai/cli-provider.ts";
import type { CliProvider } from "../../ai/cli-provider.ts";

export class MobileAccountError extends Error {
	status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}
export type MobileLoginStatus = "starting" | "waiting" | "succeeded" | "failed" | "cancelled" | "expired";
export interface MobileLogin {
	id: string;
	provider: CliProvider;
	status: MobileLoginStatus;
	verificationURL?: string;
	userCode?: string;
	message: string;
}
export interface MobileAccountOptions {
	home: string;
	/** Test injection only. Never accepted from an HTTP request. */
	executables?: Partial<Record<CliProvider, string>>;
	env?: NodeJS.ProcessEnv;
	loginTimeoutMs?: number;
	challengeTimeoutMs?: number;
	statusTimeoutMs?: number;
}
interface LoginRecord { value: MobileLogin; child?: ChildProcess; stop?: (status: MobileLoginStatus, message: string) => void; done: Promise<void>; }
const providers = Object.keys(CLI_PROVIDERS) as CliProvider[];
const isCli = (value: unknown): value is CliProvider => typeof value === "string" && Object.hasOwn(CLI_PROVIDERS, value);
const active = (status: MobileLoginStatus) => status === "starting" || status === "waiting";
const field = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const overrides = () => ["REIN_BASE_URL", "REIN_MODEL", "REIN_API"].filter(name => process.env[name]?.trim());
const challengeCode = (value: string) => /^(?:[A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{3}-[A-Z0-9]{3}|[A-Z0-9]{8,12})$/.test(value);

/** The only CLI output that can reach a phone is a small, official device challenge. */
export function mobileDeviceChallenge(provider: CliProvider, output: string): Pick<MobileLogin, "verificationURL" | "userCode"> {
	const text = output.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
	let verificationURL: string | undefined, userCode: string | undefined;
	for (const candidate of text.match(/https:\/\/[^\s<>\u001b"']+/g) ?? []) {
		try {
			const url = new URL(candidate.replace(/[),.;]+$/, ""));
			const expected = provider === "codex" ? url.origin === "https://auth.openai.com" && url.pathname === "/codex/device"
				: provider === "copilot" ? url.origin === "https://github.com" && url.pathname === "/login/device"
				: url.origin === "https://auth.x.ai" && /^\/[A-Za-z0-9/_-]{1,128}$/.test(url.pathname);
			if (!expected || url.username || url.password || url.hash) continue;
			const params = [...url.searchParams];
			if (params.length > 1 || params.some(([key, value]) => !["user_code", "code"].includes(key) || !challengeCode(value))) continue;
			verificationURL = url.toString();
			userCode = params[0]?.[1];
			break;
		} catch { /* Ignore everything except a complete allowed verification URL. */ }
	}
	for (const line of text.split(/\r?\n/)) {
		const match = /^(?:(?:your |one.time |device |verification |enter (?:the |this )?)?code\s*[:=]?\s*)([A-Z0-9]{3,12}(?:-[A-Z0-9]{3,4})?)\s*$/i.exec(line.trim()) ?? /^([A-Z0-9]{4}-[A-Z0-9]{4})$/.exec(line.trim());
		if (match && challengeCode(match[1])) { userCode ??= match[1]; break; }
	}
	return { ...(verificationURL ? { verificationURL } : {}), ...(userCode ? { userCode } : {}) };
}

/** No model request or login: discard all status output and own every subprocess. */
function checkCommand(provider: CliProvider, args: string[], options: MobileAccountOptions, signal: AbortSignal): Promise<{ ok: boolean; missing: boolean }> {
	if (signal.aborted) return Promise.resolve({ ok: false, missing: false });
	return new Promise(resolveCheck => {
		const child = spawn(options.executables?.[provider] ?? CLI_PROVIDERS[provider].command, args, {
			env: cliEnvironment(provider, { ...options.env, REIN_HOME: options.home, BROWSER: "false", NO_COLOR: "1" }), cwd: options.home,
			stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform !== "win32",
		});
		let bytes = 0, ok = false, missing = false, failed = false, ended = false, settled = false, escalation: NodeJS.Timeout | undefined;
		const kill = (name: NodeJS.Signals) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* Already exited. */ } };
		const finish = () => { if (settled || !ended || escalation) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolveCheck({ ok: ok && !failed, missing }); };
		const stop = () => { if (failed) return; failed = true; kill("SIGTERM"); if (!escalation) escalation = setTimeout(() => { kill("SIGKILL"); escalation = undefined; finish(); }, 1000); };
		const abort = () => stop();
		const timer = setTimeout(stop, options.statusTimeoutMs ?? 1500); timer.unref();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		const receive = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) stop(); };
		child.stdout!.on("data", receive); child.stderr!.on("data", receive);
		child.once("error", (error: NodeJS.ErrnoException) => { missing = error.code === "ENOENT"; failed = true; ended = true; finish(); });
		child.once("close", code => {
			ok = code === 0; ended = true; clearTimeout(timer);
			// CLI status is complete; terminate any background helper in its group.
			if (!escalation && child.pid && process.platform !== "win32") {
				kill("SIGTERM"); escalation = setTimeout(() => { kill("SIGKILL"); escalation = undefined; finish(); }, 1000);
			}
			finish();
		});
	});
}

async function subscriptionStatus(provider: CliProvider, options: MobileAccountOptions, signal: AbortSignal) {
	const version = await checkCommand(provider, ["--version"], options, signal);
	if (!version.ok) return { provider, label: CLI_PROVIDERS[provider].label, available: false, authenticated: false,
		detail: version.missing ? `Install the official CLI on the gateway: ${CLI_PROVIDERS[provider].installCommand}.` : "The CLI could not be checked within its limits. Update it on the gateway host and retry." };
	if (provider !== "codex") return { provider, label: CLI_PROVIDERS[provider].label, available: true, authenticated: null,
		detail: "CLI installed. It does not offer a separate read-only account check; sign in if needed." };
	const auth = await checkCommand(provider, ["login", "status"], options, signal);
	return { provider, label: CLI_PROVIDERS[provider].label, available: true, authenticated: auth.ok,
		detail: auth.ok ? "Codex reports authenticated in Rein's isolated profile." : "Codex did not confirm authentication. Start device sign-in to connect it." };
}

export function createMobileAccounts(options: MobileAccountOptions) {
	const records = new Map<string, LoginRecord>(), controller = new AbortController();
	let closed = false, statusPromise: Promise<unknown[]> | undefined, statusAt = 0;
	const checkHome = () => {
		if (closed) throw new MobileAccountError(503, "Mobile account setup is closed.");
		if (resolve(options.home) !== resolve(process.env.REIN_HOME || join(homedir(), ".rein"))) throw new MobileAccountError(409, "Start the gateway with REIN_HOME set to its configuration directory before managing accounts.");
	};
	const configuration = () => {
		checkHome();
		const config = readConfig(), auth = config.auth as { type?: unknown; provider?: unknown } | undefined;
		const candidate = config.provider ?? (auth?.type === "cli" ? auth.provider : undefined);
		const provider = typeof candidate === "string" && (isCli(candidate) || Object.hasOwn(PROVIDER_PRESETS, candidate) || ["custom", "openai-compatible"].includes(candidate)) ? candidate : undefined;
		let baseUrl: string | undefined;
		try { if (provider && isCli(provider)) baseUrl = `cli://${provider}`; else if (typeof config.baseUrl === "string") baseUrl = normalizeBaseUrl(config.baseUrl); else if (provider) baseUrl = PROVIDER_PRESETS[provider]?.baseUrl; } catch { /* Never echo malformed URLs, which may contain credentials. */ }
		return {
			configured: { ...(provider ? { provider } : {}), ...(field(config.model, 512) ? { model: config.model as string } : {}), ...(baseUrl ? { baseUrl } : {}),
				auth: provider && isCli(provider) ? "cli" as const : "api-key" as const,
				apiKeyConfigured: !!(baseUrl && !baseUrl.startsWith("cli://") && apiKeyFor(provider, baseUrl, typeof config.sshHost === "string" ? config.sshHost : undefined)),
			}, environmentOverrides: overrides(),
		};
	};
	return {
		async list() {
			const config = configuration();
			if (!statusPromise || Date.now() - statusAt > 10_000) {
				statusAt = Date.now();
				statusPromise = Promise.all(providers.map(provider => subscriptionStatus(provider, options, controller.signal)));
			}
			return { ...config, subscriptions: await statusPromise };
		},
		select(input: Record<string, unknown>) {
			checkHome();
			if (Object.keys(input).some(key => !["provider", "model", "baseUrl", "apiKey"].includes(key))) throw new MobileAccountError(400, "Unknown provider setup field.");
			const provider = input.provider;
			if (typeof provider !== "string" || !(isCli(provider) || Object.hasOwn(PROVIDER_PRESETS, provider) || ["custom", "openai-compatible"].includes(provider))) throw new MobileAccountError(400, "Choose a supported API or CLI provider.");
			if (!field(input.model, 512)) throw new MobileAccountError(400, "Enter a nonempty model ID of at most 512 characters.");
			const dominating = overrides();
			if (dominating.length) throw new MobileAccountError(409, `The gateway uses ${dominating.join(", ")}. Remove these environment overrides and restart it before changing its provider from iOS.`);
			const current = readConfig(), next: Record<string, unknown> = { ...current, provider, model: input.model };
			if (isCli(provider)) {
				if (input.baseUrl !== undefined || input.apiKey !== undefined) throw new MobileAccountError(400, "Subscription CLIs manage their own endpoint and credentials.");
				Object.assign(next, { auth: { type: "cli", provider }, baseUrl: `cli://${provider}` });
				delete next.apiKey; delete next.api; delete next.sshHost;
			} else {
				if (input.baseUrl !== undefined && !field(input.baseUrl, 2048)) throw new MobileAccountError(400, "Enter a valid HTTP API base URL.");
				let baseUrl: string;
				try { baseUrl = normalizeBaseUrl((input.baseUrl as string | undefined) ?? PROVIDER_PRESETS[provider]?.baseUrl ?? "", provider); }
				catch { throw new MobileAccountError(400, "Enter an HTTP API base URL without credentials, query parameters, or a fragment."); }
				if (input.apiKey !== undefined && input.apiKey !== null && !field(input.apiKey, 8192)) throw new MobileAccountError(400, "Enter an API key without surrounding whitespace or control characters, or null to remove it.");
				const keyEnv = PROVIDER_PRESETS[provider]?.keyEnv;
				const envKey = process.env.REIN_API_KEY ? "REIN_API_KEY" : keyEnv && process.env[keyEnv] && new URL(baseUrl).origin === new URL(PROVIDER_PRESETS[provider].baseUrl).origin ? keyEnv : undefined;
				if (envKey && (input.apiKey !== undefined || envKey === "REIN_API_KEY")) throw new MobileAccountError(409, `The gateway uses ${envKey}. Remove that environment override and restart it before replacing its API key from iOS.`);
				let sameEndpoint = false;
				try { sameEndpoint = typeof current.baseUrl === "string" && normalizeBaseUrl(current.baseUrl) === baseUrl && (current.auth as { type?: unknown } | undefined)?.type !== "cli"; } catch { /* Changed endpoints never inherit old credentials. */ }
				if (!sameEndpoint) { delete next.apiKey; delete next.sshHost; }
				Object.assign(next, { auth: { type: "api-key" }, api: "chat-completions", baseUrl });
				if (input.apiKey === null) delete next.apiKey;
				else if (typeof input.apiKey === "string") next.apiKey = input.apiKey;
			}
			saveConfig(next);
			return { ...configuration(), message: "Saved for new runs on this gateway. Existing runs keep their current provider." };
		},
		start(input: Record<string, unknown>): MobileLogin {
			checkHome();
			if (Object.keys(input).some(key => key !== "provider") || !isCli(input.provider)) throw new MobileAccountError(400, "Choose codex, copilot, or grok for official CLI device sign-in.");
			const provider = input.provider;
			for (const record of records.values()) if (record.value.provider === provider) {
				if (active(record.value.status)) return { ...record.value };
				if (record.child) throw new MobileAccountError(409, "The previous sign-in is still stopping. Retry in a moment.");
			}
			while (records.size >= 32) {
				const oldest = [...records].find(([, record]) => !active(record.value.status) && !record.child);
				if (!oldest) throw new MobileAccountError(429, "Too many active sign-ins.");
				records.delete(oldest[0]);
			}
			const env = cliEnvironment(provider, { ...options.env, REIN_HOME: options.home, BROWSER: "false", NO_COLOR: "1", TERM: "dumb" });
			try { prepareCliProfile(provider, env); } catch { throw new MobileAccountError(409, `The isolated ${provider} CLI profile needs attention. Run 'rein login ${provider}' on the gateway host to resolve it.`); }
			const value: MobileLogin = { id: randomUUID(), provider, status: "starting", message: "Starting official CLI device sign-in on this gateway." };
			let finishDone!: () => void;
			const record: LoginRecord = { value, done: new Promise(resolveDone => { finishDone = resolveDone; }) };
			records.set(value.id, record);
			const child = spawn(options.executables?.[provider] ?? CLI_PROVIDERS[provider].command, ["login", provider === "copilot" ? "--device-code" : "--device-auth"], {
				env, cwd: cliAuthDirectory(provider, env), stdio: ["ignore", "pipe", "pipe"], shell: false, detached: process.platform !== "win32",
			});
			record.child = child;
			let bytes = 0, stdout = "", stderr = "", pendingCode: string | undefined, ended = false, settled = false, escalation: NodeJS.Timeout | undefined;
			const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Owned process already exited. */ } };
			const finish = () => { if (settled || !ended || escalation) return; settled = true; clearTimeout(timeout); clearTimeout(challengeTimeout); stdout = ""; stderr = ""; record.child = undefined; record.stop = undefined; statusPromise = undefined; finishDone(); };
			record.stop = (status, message) => {
				if (!active(value.status)) return;
				value.status = status; value.message = message; delete value.verificationURL; delete value.userCode;
				clearTimeout(timeout); clearTimeout(challengeTimeout); kill("SIGTERM");
				escalation = setTimeout(() => { kill("SIGKILL"); escalation = undefined; finish(); }, 1000);
			};
			const timeout = setTimeout(() => record.stop?.("expired", "Device sign-in expired. Start it again when ready."), options.loginTimeoutMs ?? 600_000); timeout.unref();
			const challengeTimeout = setTimeout(() => { if (!value.verificationURL) record.stop?.("failed", `This CLI did not provide a supported device challenge. Update it or run 'rein login ${provider}' in a terminal on the gateway host.`); }, options.challengeTimeoutMs ?? 30_000); challengeTimeout.unref();
			const inspect = (text: string) => {
				if (!active(value.status)) return;
				const challenge = mobileDeviceChallenge(provider, text);
				if (challenge.verificationURL) { value.verificationURL = challenge.verificationURL; value.status = "waiting"; value.message = "Open the verification page and approve this sign-in. Credentials stay managed by the official CLI on this gateway."; clearTimeout(challengeTimeout); }
				if (challenge.userCode) pendingCode = challenge.userCode;
				if (value.verificationURL && pendingCode) value.userCode = pendingCode;
			};
			const receive = (source: "stdout" | "stderr", chunk: Buffer) => {
				if (!active(value.status)) return;
				bytes += chunk.length;
				if (bytes > 64 * 1024) { record.stop?.("failed", "CLI sign-in exceeded its output limit. Update the CLI and retry on the gateway host."); return; }
				let buffer = (source === "stdout" ? stdout : stderr) + chunk.toString("utf8");
				const end = Math.max(buffer.lastIndexOf("\n"), buffer.lastIndexOf("\r"));
				if (end >= 0) { inspect(buffer.slice(0, end + 1)); buffer = buffer.slice(end + 1); }
				if (buffer.length > 8192) { record.stop?.("failed", "CLI sign-in returned an unsupported response. Run sign-in on the gateway host."); return; }
				if (source === "stdout") stdout = buffer; else stderr = buffer;
			};
			child.stdout!.on("data", chunk => receive("stdout", chunk)); child.stderr!.on("data", chunk => receive("stderr", chunk));
			child.once("error", (error: NodeJS.ErrnoException) => {
				if (active(value.status)) { value.status = "failed"; value.message = error.code === "ENOENT" ? `Install the official CLI on this gateway with '${CLI_PROVIDERS[provider].installCommand}', then retry.` : `The ${provider} CLI could not start. Check its installation on the gateway host.`; }
				ended = true; finish();
			});
			child.once("close", code => {
				inspect(stdout); inspect(stderr);
				if (active(value.status)) { value.status = code === 0 ? "succeeded" : "failed"; value.message = code === 0 ? "Official CLI sign-in completed on this gateway. Select this provider to use it for new runs." : `CLI device sign-in could not finish. Update it or run 'rein login ${provider}' in a terminal on the gateway host.`; delete value.verificationURL; delete value.userCode; }
				ended = true;
				// Reap owned background descendants even when the CLI exits first.
				if (!escalation && child.pid && process.platform !== "win32") {
					kill("SIGTERM"); escalation = setTimeout(() => { kill("SIGKILL"); escalation = undefined; finish(); }, 1000);
				}
				finish();
			});
			return { ...value };
		},
		get(id: string): MobileLogin {
			checkHome(); const record = records.get(id);
			if (!record) throw new MobileAccountError(404, "Sign-in record has expired or was not found.");
			return { ...record.value };
		},
		cancel(id: string): MobileLogin {
			checkHome(); const record = records.get(id);
			if (!record) throw new MobileAccountError(404, "Sign-in record has expired or was not found.");
			record.stop?.("cancelled", "Device sign-in cancelled."); return { ...record.value };
		},
		async close() {
			closed = true; controller.abort();
			for (const record of records.values()) record.stop?.("cancelled", "Gateway stopped; device sign-in cancelled.");
			await Promise.allSettled([...records.values()].map(record => record.done));
			await statusPromise?.catch(() => {});
		},
	};
}
