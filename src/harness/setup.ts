/** Interactive and unattended setup. Credentials are collected before discovery. */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Readable } from "node:stream";
import { PROVIDER_PRESETS, discoverLocalServers, loadConfig, pickDefaultModelId, apiKeyFor, normalizeBaseUrl, detectEndpoint } from "../ai/models.ts";
import { CLI_PROVIDERS, loginCli, checkCliAuth } from "./auth.ts";
import { withSshTunnel } from "../ai/ssh.ts";
import { postChatCompletion } from "../ai/chat-request.ts";
import { GITHUB_MODELS_RETIRED } from "../ai/endpoints.ts";

type CliProvider = "codex" | "copilot";
export interface SetupOptions {
	yes?: boolean;
	status?: boolean;
	provider?: string;
	baseUrl?: string;
	model?: string;
	auth?: "api-key" | "cli";
	cliProvider?: CliProvider;
	deviceAuth?: boolean;
	sshHost?: string;
	noBrowser?: boolean;
}
export interface SetupPrompt {
	ask(prompt: string, fallback?: string): Promise<string>;
	secret(prompt: string): Promise<string | undefined>;
	close(): void;
}
export interface SetupDependencies {
	prompt?: SetupPrompt;
	log?: (text: string) => void;
	discover?: typeof discoverLocalServers;
	detect?: typeof detectEndpoint;
	keyFor?: typeof apiKeyFor;
	connection?: typeof testConnection;
	openBrowser?: (url: string) => Promise<boolean>;
	login?: typeof loginCli;
	cliStatus?: typeof checkCliAuth;
}

const LOCAL = new Set(["ollama", "lmstudio", "llamacpp", "vllm"]);
// Official provider account pages. CLI subscription sign-in is a separate flow.
export const API_KEY_PAGES: Record<string, string> = {
	openai: "https://platform.openai.com/api-keys",
	deepseek: "https://platform.deepseek.com/api_keys",
	groq: "https://console.groq.com/keys",
	together: "https://api.together.ai/settings/api-keys",
	openrouter: "https://openrouter.ai/settings/keys",
	mistral: "https://console.mistral.ai/api-keys",
	fireworks: "https://app.fireworks.ai/settings/users/api-keys",
	cerebras: "https://cloud.cerebras.ai/platform/api-keys",
	huggingface: "https://huggingface.co/settings/tokens",
	gemini: "https://aistudio.google.com/apikey",
};
const configPath = () => join(process.env.REIN_HOME || join(homedir(), ".rein"), "config.json");

function saveConfig(config: Record<string, unknown>): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		renameSync(temp, path);
	} finally { try { unlinkSync(temp); } catch {} }
}

/** One interface per invocation: queued input, hidden secrets, explicit EOF, cleanup. */
export function createSetupPrompt(input: Readable = process.stdin, output: Writable = process.stdout): SetupPrompt {
	let hidden = false;
	const echo = new Writable({ write(chunk, _encoding, callback) { if (!hidden) output.write(chunk); callback(); } });
	const terminal = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
	const rl = createInterface({ input, output: echo, terminal });
	const queue: string[] = [];
	let closed = false;
	let pending: { resolve: (text: string) => void; reject: (error: Error) => void } | undefined;
	const eof = () => new Error("Setup input closed. Run setup again, or use --yes with --base-url/--provider and --model.");
	rl.on("line", line => {
		if (pending) { const waiter = pending; pending = undefined; waiter.resolve(line); }
		else queue.push(line);
	});
	rl.on("close", () => { closed = true; pending?.reject(eof()); pending = undefined; });
	const next = async (text: string, fallback = "") => {
		output.write(text);
		if (queue.length) return queue.shift()!.trim() || fallback;
		if (closed) throw eof();
		const answer = await new Promise<string>((resolve, reject) => { pending = { resolve, reject }; });
		return answer.trim() || fallback;
	};
	return {
		ask: next,
		async secret(text) {
			if (!terminal) return undefined; // Piped answers are never treated as credentials.
			hidden = true;
			try { return await next(text); } finally { hidden = false; output.write("\n"); }
		},
		close() { rl.close(); echo.end(); },
	};
}

async function openBrowser(url: string): Promise<boolean> {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try { await promisify(execFile)(command, args, { timeout: 5000 }); return true; } catch { return false; }
}

function redactKey(text: string, key?: string): string { return key ? text.split(key).join("[redacted]") : text; }

export async function testConnection(baseUrl: string, model: string, apiKey?: string, options: { sshHost?: string } = {}): Promise<{ ok: boolean; detail: string }> {
	if (options.sshHost) {
		try { return await withSshTunnel(baseUrl, options.sshHost, tunneledUrl => testConnection(tunneledUrl, model, apiKey)); }
		catch (error) { return { ok: false, detail: `SSH connection failed: ${redactKey(error instanceof Error ? error.message : String(error), apiKey)}` }; }
	}
	const started = Date.now();
	try {
		const response = await postChatCompletion(`${baseUrl.replace(/\/$/, "")}/chat/completions`, { model, messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 8 }, {
			signal: AbortSignal.timeout(20_000), redirect: "error",
			headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
		});
		if (!response.ok) {
			const detail = redactKey(await response.text().catch(() => ""), apiKey).slice(0, 300);
			return { ok: false, detail: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
		}
		const body = await response.json() as { choices?: { message?: { content?: unknown; tool_calls?: unknown[] } }[] };
		const message = body.choices?.[0]?.message;
		if (!message || (typeof message.content !== "string" && !Array.isArray(message.content) && !message.tool_calls?.length)) {
			return { ok: false, detail: "Endpoint returned no valid chat completion. Check the API server URL and selected model." };
		}
		return { ok: true, detail: `valid chat completion in ${Date.now() - started}ms` };
	} catch (error) {
		return { ok: false, detail: `${redactKey(error instanceof Error ? error.message : String(error), apiKey)}. For a remote server, check its listening port, bind to 0.0.0.0, and verify NetBird/firewall reachability.` };
	}
}

interface Selection { provider?: string; baseUrl?: string; model?: string; cli?: CliProvider; label: string }
async function choose(prompt: SetupPrompt, log: (text: string) => void, label: string, choices: string[], defaultIndex = 0): Promise<number> {
	choices.forEach((item, i) => log(`  ${i + 1}. ${item}`));
	for (;;) {
		const answer = await prompt.ask(`${label} [${defaultIndex + 1}]: `, String(defaultIndex + 1));
		const value = Number(answer);
		if (Number.isInteger(value) && value >= 1 && value <= choices.length) return value - 1;
		log("Choose a number from the list.");
	}
}

export async function runSetup(opts: SetupOptions = {}, dependencies: SetupDependencies = {}): Promise<number> {
	let prompt = dependencies.prompt;
	const getPrompt = () => prompt ??= createSetupPrompt();
	const logRaw = dependencies.log ?? console.log;
	const loaded = loadConfig();
	const config = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
	const secrets = new Set<string>();
	if (config.apiKey) secrets.add(config.apiKey);
	for (const name of ["REIN_API_KEY", ...Object.values(PROVIDER_PRESETS).map(p => p.keyEnv)]) if (process.env[name]) secrets.add(process.env[name]!);
	const log = (text: string) => { for (const secret of secrets) text = text.split(secret).join("[redacted]"); logRaw(text); };
	const keyFor = dependencies.keyFor ?? apiKeyFor;
	const detect = dependencies.detect ?? detectEndpoint;
	const connection = dependencies.connection ?? testConnection;
	const cliStatus = dependencies.cliStatus ?? checkCliAuth;
	try {
		if (opts.status) {
			log(`config: ${configPath()}`);
			log(`provider: ${config.provider ?? "(unset)"}\nmodel: ${config.model ?? "(unset)"}\nauth: ${config.auth?.type ?? "api-key"}`);
			if (config.auth?.type === "cli") {
				if (!(config.auth.provider in CLI_PROVIDERS)) throw new Error("Unknown saved CLI provider. Run rein setup to repair the configuration.");
				const status = await cliStatus(config.auth.provider);
				log(status.detail);
				return status.available && status.authenticated !== false ? 0 : 1;
			}
			log(`base URL: ${config.baseUrl ?? "(unset)"}${config.sshHost ? `\nSSH host: ${config.sshHost}` : ""}\nAPI key: ${config.apiKey ? "saved (hidden)" : "not saved"}`);
			if (!config.baseUrl || !config.model) { log("Run rein setup to configure a connection."); return 0; }
			const key = keyFor(config.provider, config.baseUrl, config.sshHost); if (key) secrets.add(key);
			const result = await connection(normalizeBaseUrl(config.baseUrl), config.model, key, { sshHost: config.sshHost });
			log(`connection: ${result.ok ? "passed" : "failed"} — ${result.detail}`);
			return result.ok ? 0 : 1;
		}
		if (opts.auth !== undefined && opts.auth !== "api-key" && opts.auth !== "cli") throw new Error("--auth must be api-key or cli.");
		if (opts.cliProvider && !(opts.cliProvider in CLI_PROVIDERS)) throw new Error("--cli-provider must be codex or copilot.");
		const envBase = process.env.REIN_BASE_URL?.trim() || undefined;
		const envModel = process.env.REIN_MODEL?.trim() || undefined;
		const selectedProvider = opts.provider?.trim().toLowerCase() || undefined;
		const explicitSelection = Boolean(selectedProvider || opts.baseUrl || opts.auth || opts.cliProvider || opts.sshHost || envBase);
		let selection: Selection = { label: "selected endpoint", provider: selectedProvider, baseUrl: opts.baseUrl?.trim() || (selectedProvider ? PROVIDER_PRESETS[selectedProvider]?.baseUrl : undefined) || envBase, model: opts.model?.trim() || envModel };
		const cli = opts.cliProvider ?? (selection.provider === "codex" || selection.provider === "copilot" ? selection.provider : undefined);
		if (opts.auth === "api-key" && cli) throw new Error("CLI providers use --auth cli; API-key setup requires an HTTP provider or --base-url.");
		if ((opts.auth === "cli" || cli) && (opts.baseUrl || opts.sshHost || envBase)) throw new Error("CLI account setup does not accept --base-url, REIN_BASE_URL or --ssh; choose an HTTP API connection for those options.");
		if (opts.auth === "cli" || cli) {
			selection.cli = cli;
			if (!selection.cli && opts.yes) throw new Error("CLI setup needs --cli-provider codex or --cli-provider copilot.");
			if (!selection.cli) selection.cli = (["codex", "copilot"] as const)[await choose(getPrompt(), log, "Choose CLI account", [CLI_PROVIDERS.codex.label, CLI_PROVIDERS.copilot.label])];
		} else if (!explicitSelection && opts.yes && config.auth?.type === "cli") {
			selection.cli = config.auth.provider;
		} else if (!explicitSelection && !opts.yes) {
			log("rein setup — local server, remote host, cloud API, or CLI account");
			const locals = await (dependencies.discover ?? discoverLocalServers)();
			const choices: Selection[] = locals.map(server => ({ ...server, label: `${server.provider} — ${server.baseUrl}` }));
			choices.push({ label: "Custom / remote host (DGX, NetBird, LAN, or OpenAI-compatible API)", provider: "custom" });
			choices.push(...(["codex", "copilot"] as const).map(provider => ({ label: CLI_PROVIDERS[provider].label, cli: provider })));
			for (const [provider, preset] of Object.entries(PROVIDER_PRESETS)) if (!LOCAL.has(provider) && provider !== "github") choices.push({ label: `${provider} — cloud API key`, provider, baseUrl: preset.baseUrl });
			selection = { ...choices[await choose(getPrompt(), log, "Choose connection", choices.map(c => c.label))], model: selection.model };
		}

		if (selection.cli) {
			const provider = selection.cli;
			const info = CLI_PROVIDERS[provider];
			if (!info) throw new Error("Unknown saved CLI provider. Run rein setup to repair the configuration.");
			const status = await cliStatus(provider);
			if (!status.available) throw new Error(`${status.detail}\nInstall with: ${info.installCommand}`);
			if (!opts.yes && status.authenticated !== true) {
				// Release readline before an official CLI takes control of the terminal.
				prompt?.close(); prompt = undefined;
				log(`Sign in through ${info.label} in Rein's dedicated CLI profile. Browser fallback: ${info.loginUrl}`);
				const result = await (dependencies.login ?? loginCli)(provider, { deviceAuth: opts.deviceAuth !== false, interactive: true, openBrowser: !opts.noBrowser });
				if (!result.ok) throw new Error(result.detail);
				log(result.detail);
			} else {
				log(status.detail);
				if (status.authenticated === false) throw new Error(`Run rein login ${provider}, then rerun rein setup. --yes never starts an interactive login.`);
			}
			const model = selection.model ?? (config.auth?.type === "cli" && config.auth.provider === provider ? config.model : undefined) ?? info.defaultModel;
			const saved: Record<string, unknown> = { ...config, provider, baseUrl: info.baseUrl, model, auth: { type: "cli", provider } };
			delete saved.apiKey;
			delete saved.sshHost;
			saveConfig(saved);
			log(`Saved ${info.label} configuration to ${configPath()}. Credentials remain with the official CLI.`);
			log("For optional proactive task suggestions, run rein autonomy init, then rein autonomy scan and rein autonomy tui.");
			return 0;
		}

		if (selection.provider === "github") throw new Error(GITHUB_MODELS_RETIRED);
		if (selection.provider && selection.provider !== "custom" && !PROVIDER_PRESETS[selection.provider]) throw new Error(`Unknown API provider "${selection.provider}". Use --base-url for a custom host.`);
		selection.baseUrl ??= selection.provider && PROVIDER_PRESETS[selection.provider]?.baseUrl;
		if (!selection.baseUrl && opts.yes && !opts.provider) {
			selection.baseUrl = config.auth?.type !== "cli" ? config.baseUrl : undefined;
			selection.provider ??= config.provider;
			if (!selection.baseUrl) {
				const local = (await (dependencies.discover ?? discoverLocalServers)())[0];
				if (local) { selection.baseUrl = local.baseUrl; selection.provider = local.provider; }
			}
		}
		if (!selection.baseUrl) {
			if (opts.yes) throw new Error("No endpoint configured. Pass --base-url <NetBird-host-or-IP>:<port> or --provider <name>; add --model if discovery is unavailable.");
			log("Enter the server host and listening port. For remote LM Studio, use its NetBird/LAN address and port (often 1234); localhost means this machine.");
			selection.baseUrl = await getPrompt().ask("Server URL or host:port: ");
		}
		let baseUrl = normalizeBaseUrl(selection.baseUrl);
		const inferredProvider = Object.entries(PROVIDER_PRESETS).find(([, preset]) => normalizeBaseUrl(preset.baseUrl) === baseUrl)?.[0];
		let provider = (!selection.provider || selection.provider === "custom" ? inferredProvider : selection.provider) ?? "custom";
		let sameEndpoint = false;
		try { sameEndpoint = Boolean(config.baseUrl && config.auth?.type !== "cli" && normalizeBaseUrl(config.baseUrl) === baseUrl && (!config.provider || config.provider === provider || provider === "custom")); } catch {}
		let sshHost = opts.sshHost ?? (sameEndpoint ? config.sshHost : undefined);
		if (!opts.yes && !sshHost && provider === "custom") {
			log("If the remote API listens only on 127.0.0.1, Rein can reach it through an SSH host from your SSH config (for example, dgx).");
			sshHost = await getPrompt().ask("SSH host (optional; Enter for direct NetBird/LAN access): ") || undefined;
		}
		const sameConnection = sameEndpoint && (config.sshHost ?? undefined) === sshHost;
		let model = selection.model ?? (sameConnection ? config.model : undefined);
		let key = keyFor(provider, baseUrl, sshHost);
		if (!sameConnection && key === config.apiKey && !process.env.REIN_API_KEY && !process.env[PROVIDER_PRESETS[provider]?.keyEnv ?? "REIN_API_KEY"]) key = undefined;
		if (key) secrets.add(key);
		let saveKey = sameConnection && key === config.apiKey ? config.apiKey : undefined;
		const keyEnv = PROVIDER_PRESETS[provider]?.keyEnv ?? "REIN_API_KEY";
		if (process.env.REIN_API_KEY || process.env[keyEnv]) saveKey = undefined;
		const cloud = Boolean(PROVIDER_PRESETS[provider] && !LOCAL.has(provider));
		if (!key && !opts.yes) {
			const url = API_KEY_PAGES[provider];
			if (url) {
				log(`Create an API key: ${url}`);
				if (!opts.noBrowser && !await (dependencies.openBrowser ?? openBrowser)(url)) log("Browser could not open. Use the URL above on this or another device.");
			}
			key = await getPrompt().secret(cloud ? "API key (hidden): " : "API key if required (hidden; Enter for none): ");
			if (key) { secrets.add(key); saveKey = key; }
		}
		if (cloud && !key) throw new Error(`No API key for ${provider}. Set ${keyEnv} and rerun setup; API keys are separate from CLI subscriptions.`);
		const endpoint = await detect(baseUrl, { provider, apiKey: key, sshHost });
		baseUrl = endpoint.baseUrl; provider = endpoint.provider;
		if (endpoint.error) log(`Model discovery: ${endpoint.error}`);
		if (!model && endpoint.models.length) {
			const preferred = pickDefaultModelId(endpoint.models);
			if (opts.yes) model = preferred;
			else model = endpoint.models[await choose(getPrompt(), log, "Choose model", endpoint.models, Math.max(0, endpoint.models.indexOf(preferred ?? "")))];
		}
		if (!model && !opts.yes) model = await getPrompt().ask("Model ID (if the server does not list models): ");
		if (!model) throw new Error("No model available. Load a model on the remote server or pass --model <id>. Check the listening port, 0.0.0.0 binding and NetBird reachability if discovery failed.");
		const result = await connection(baseUrl, model, key, { sshHost });
		if (!result.ok) throw new Error(`Connection test failed: ${result.detail}\nConfiguration was not saved. Correct the endpoint, credentials or model and rerun setup.`);
		const saved: Record<string, unknown> = { ...config, provider, baseUrl, model, auth: { type: "api-key" } };
		delete saved.apiKey;
		delete saved.sshHost;
		if (sshHost) saved.sshHost = sshHost;
		if (saveKey) saved.apiKey = saveKey;
		saveConfig(saved);
		log(`Connection passed: ${result.detail}\nSaved ${provider}/${model} at ${baseUrl} to ${configPath()}.`);
		if (key && !saveKey) log(`Using credentials from the environment; no API key was written to config.`);
		log("For optional proactive task suggestions, run rein autonomy init, then rein autonomy scan and rein autonomy tui.");
		return 0;
	} catch (error) {
		log(error instanceof Error ? error.message : String(error));
		return 1;
	} finally { prompt?.close(); }
}
