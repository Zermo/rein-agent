/** Interactive and unattended setup. Credentials are collected before discovery. */
import { configPath, saveConfig } from "../ai/config.ts";
import { resolveRunBudgets } from "./run-budgets.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Readable } from "node:stream";
import { PROVIDER_PRESETS, discoverLocalServers, discoverServers, loadConfig, pickDefaultModelId, apiKeyFor, normalizeBaseUrl, detectEndpoint, validateHttpApi } from "../ai/models.ts";
import { CLI_PROVIDERS, loginCli, checkCliAuth } from "./auth.ts";
import type { CliProvider } from "./auth.ts";
import { XAI_API_KEY_PAGE } from "../ai/xai.ts";
import { printDiscoverySummary, printServingAdvice } from "./server-setup.ts";
import { withSshTunnel } from "../ai/ssh.ts";
import { postChatCompletion } from "../ai/chat-request.ts";
import { GITHUB_MODELS_RETIRED } from "../ai/endpoints.ts";
import { chatCompletionChunks, chatCompletionReasoning, chatCompletionText } from "../ai/openai-completions.ts";

export interface SetupOptions {
	api?: string;
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
	discoverNetwork?: boolean;
	discoverHosts?: string[];
	discoverPorts?: number[];
	maxTurns?: number;
	maxIterations?: number;
}
export interface SetupPrompt {
	ask(prompt: string, fallback?: string): Promise<string>;
	secret(prompt: string): Promise<string | undefined>;
	close(): void;
}
export interface SetupDependencies {
	prompt?: SetupPrompt;
	/** The full walkthrough shares one readline queue across non-login stages. */
	keepPromptOpen?: boolean;
	onPromptReleased?: () => void;
	log?: (text: string) => void;
	discover?: typeof discoverLocalServers;
	discoverServers?: typeof discoverServers;
	servingAdvice?: typeof printServingAdvice;
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
	xai: XAI_API_KEY_PAGE,
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
/** One interface per invocation: queued input, hidden secrets, explicit EOF, cleanup. */
export function createSetupPrompt(input: Readable = process.stdin, output: Writable = process.stdout): SetupPrompt {
	let hidden = false;
	const echo = new Writable({ write(chunk, _encoding, callback) { if (!hidden) output.write(chunk); callback(); } });
	const terminal = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
	const rl = createInterface({ input, output: echo, terminal });
	const queue: string[] = [];
	let closed = input.readableEnded || input.destroyed;
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
		// Reasoning models spend part of this budget before writing their visible answer.
		const response = await postChatCompletion(`${baseUrl.replace(/\/$/, "")}/chat/completions`, { model, messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 128 }, {
			signal: AbortSignal.timeout(20_000), redirect: "error",
			headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
		});
		if (!response.ok) {
			const detail = redactKey(await response.text().catch(() => ""), apiKey).slice(0, 300);
			return { ok: false, detail: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
		}
		let usable = false, reasoning = false;
		for await (const chunk of chatCompletionChunks(response)) {
			if (chunk.error) throw new Error(typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? "The provider returned an error.");
			const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
			if (choice?.finish_reason === "content_filter") return { ok: false, detail: "The provider blocked this response (content_filter)." };
			if (choice?.finish_reason === "aborted") return { ok: false, detail: "The provider aborted this response (aborted)." };
			const message = choice?.delta ?? choice?.message;
			if (message && (chatCompletionText(message).trim() || Array.isArray(message.tool_calls) && message.tool_calls.length)) usable = true;
			if (message && chatCompletionReasoning(message).trim()) reasoning = true;
		}
		if (!usable && !reasoning) {
			return { ok: false, detail: "Endpoint returned no valid chat completion. Check the API server URL and selected model." };
		}
		if (!usable) return { ok: true, detail: `valid chat completion in ${Date.now() - started}ms; the probe returned reasoning rather than a final answer` };
		return { ok: true, detail: `valid chat completion in ${Date.now() - started}ms` };
	} catch (error) {
		return { ok: false, detail: `${redactKey(error instanceof Error ? error.message : String(error), apiKey)}. For direct remote access, check the server's listening address and port, network routing, and firewall rules. For a loopback-only server, use --ssh <host>.` };
	}
}

interface Selection { provider?: string; baseUrl?: string; model?: string; cli?: CliProvider; label: string; sshHost?: string; hardware?: boolean; status?: string; error?: string }
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
	const releasePrompt = () => { prompt?.close(); prompt = undefined; dependencies.onPromptReleased?.(); };
	const logRaw = dependencies.log ?? console.log;
	const loaded = loadConfig();
	const config = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
	const secrets = new Set<string>();
	if (config.apiKey) secrets.add(config.apiKey);
	for (const name of ["REIN_API_KEY", ...Object.values(PROVIDER_PRESETS).map(p => p.keyEnv)]) if (process.env[name]) secrets.add(process.env[name]!);
	const log = (text: string) => { for (const secret of secrets) text = text.split(secret).join("[redacted]"); logRaw(text); };
	const safeDisplayUrl = (value: string) => {
		try {
			const parsed = new URL(value);
			return `${parsed.origin}${parsed.pathname}`;
		} catch {
			return "[invalid-url]";
		}
	};
	const keyFor = dependencies.keyFor ?? apiKeyFor;
	const detect = dependencies.detect ?? detectEndpoint;
	const connection = dependencies.connection ?? testConnection;
	const cliStatus = dependencies.cliStatus ?? checkCliAuth;
	try {
		const budgets = resolveRunBudgets(config, opts);
		const persist = (saved: Record<string, unknown>) => {
			if (JSON.stringify(loadConfig()) !== JSON.stringify(config)) throw new Error("Rein config changed during connection setup. The newer settings were preserved. Rerun setup to test and save the latest configuration.");
			saveConfig({ ...saved, ...budgets });
		};
		const requestedApi = opts.api ?? (process.env.REIN_API?.trim() || undefined);
		if (requestedApi !== undefined) validateHttpApi(requestedApi);
		if (opts.status) {
			if (opts.maxTurns !== undefined || opts.maxIterations !== undefined) throw new Error("Connection status does not save task limits. Use rein setup budgets to change them.");
			log(`config: ${configPath()}`);
			log(`Task limits: ${budgets.maxTurns} model turns per prompt; ${budgets.maxIterations} loop/improve iterations. Change with rein setup budgets.`);
			log(`provider: ${config.provider ?? "(unset)"}\nmodel: ${config.model ?? "(unset)"}\nauth: ${config.auth?.type ?? "api-key"}`);
			if (config.auth?.type === "cli") {
				if (requestedApi !== undefined) throw new Error("Chat Completions requires an HTTP API provider. CLI subscriptions manage their own transport.");
				if (!(config.auth.provider in CLI_PROVIDERS)) throw new Error("Unknown saved CLI provider. Run rein setup to repair the configuration.");
				const status = await cliStatus(config.auth.provider);
				log(status.detail);
				return status.available && status.authenticated !== false ? 0 : 1;
			}
			const api = validateHttpApi(requestedApi ?? config.api);
			log(`API protocol: ${api} (OpenAI Chat Completions, JSON or SSE)`);
			log(`base URL: ${config.baseUrl ?? "(unset)"}${config.sshHost ? `\nSSH host: ${config.sshHost}` : ""}\nAPI key: ${config.apiKey ? "saved (hidden)" : "not saved"}`);
			if (!config.baseUrl || !config.model) { log("Run rein setup to configure a connection."); return 0; }
			const key = keyFor(config.provider, config.baseUrl, config.sshHost); if (key) secrets.add(key);
			const result = await connection(normalizeBaseUrl(config.baseUrl), config.model, key, { sshHost: config.sshHost });
			log(`connection: ${result.ok ? "passed" : "failed"} — ${result.detail}`);
			return result.ok ? 0 : 1;
		}
		if (opts.auth !== undefined && opts.auth !== "api-key" && opts.auth !== "cli") throw new Error("--auth must be api-key or cli.");
		const cliProviders = Object.keys(CLI_PROVIDERS) as CliProvider[];
		if (opts.cliProvider && !cliProviders.includes(opts.cliProvider)) throw new Error(`--cli-provider must be ${cliProviders.join(", ")}.`);
		const envBase = process.env.REIN_BASE_URL?.trim() || undefined;
		const envModel = process.env.REIN_MODEL?.trim() || undefined;
		const selectedProvider = opts.provider?.trim().toLowerCase() || undefined;
		const explicitSelection = Boolean(selectedProvider || opts.baseUrl || opts.auth || opts.cliProvider || opts.sshHost || envBase);
		let selection: Selection = { label: "selected endpoint", provider: selectedProvider, baseUrl: opts.baseUrl?.trim() || (selectedProvider ? PROVIDER_PRESETS[selectedProvider]?.baseUrl : undefined) || envBase, model: opts.model?.trim() || envModel };
		const cli = opts.cliProvider ?? (cliProviders.includes(selection.provider as CliProvider) ? selection.provider as CliProvider : undefined);
		if (opts.auth === "api-key" && cli) throw new Error("CLI providers use --auth cli; API-key setup requires an HTTP provider or --base-url.");
		if ((opts.auth === "cli" || cli) && (opts.baseUrl || opts.sshHost || envBase)) throw new Error("CLI account setup does not accept --base-url, REIN_BASE_URL or --ssh; choose an HTTP API connection for those options.");
		if (opts.auth === "cli" || cli) {
			selection.cli = cli;
			if (!selection.cli && opts.yes) throw new Error(`CLI setup needs --cli-provider ${cliProviders.join(" | ")}.`);
			if (!selection.cli) selection.cli = cliProviders[await choose(getPrompt(), log, "Choose CLI account", cliProviders.map(p => CLI_PROVIDERS[p].label))];
		} else if (!explicitSelection && opts.yes && config.auth?.type === "cli") {
			selection.cli = config.auth.provider;
		} else if (!explicitSelection && !opts.yes) {
			log("rein setup — local server, remote host, cloud API, or CLI account");
			await (dependencies.servingAdvice ?? printServingAdvice)(false, log);
			for (;;) {
				log(opts.discoverNetwork === false ? "Checking localhost and configured endpoints…" : "Checking localhost, configured endpoints, and known LAN/mesh peers (up to 10 seconds)…");
				const report = dependencies.discover && !dependencies.discoverServers ? undefined : await (dependencies.discoverServers ?? discoverServers)({ network: opts.discoverNetwork !== false, hosts: opts.discoverHosts, ports: opts.discoverPorts });
				if (report) printDiscoverySummary(report, log);
				const servers: Array<{ provider: string; baseUrl: string; sshHost?: string; status?: string; error?: string }> = report?.servers ?? await dependencies.discover!();
				const choices: Selection[] = servers.map(server => ({ ...server, label: `${server.provider} — ${server.baseUrl}${server.sshHost ? ` via SSH ${server.sshHost}` : ""}${"status" in server ? ` [${server.status}]` : ""}` }));
				choices.push({ label: "Custom Chat Completions API / remote host (LAN, VPN, mesh)", provider: "custom" });
				choices.push(...cliProviders.map(provider => ({ label: CLI_PROVIDERS[provider].label, cli: provider })));
				for (const [provider, preset] of Object.entries(PROVIDER_PRESETS)) if (!LOCAL.has(provider)) choices.push({ label: `${provider} — cloud API key`, provider, baseUrl: preset.baseUrl });
				choices.push({ label: "Help me host a model — hardware fit and serving recipes", hardware: true });
				const picked = choices[await choose(getPrompt(), log, "Choose connection", choices.map(c => c.label))];
				if (!picked.hardware) { selection = { ...picked, model: selection.model }; break; }
				await (dependencies.servingAdvice ?? printServingAdvice)(true, log);
				await getPrompt().ask("Start a server using a recipe in another terminal, then press Enter to scan again (or choose a cloud connection next): ");
			}
		}

		if (selection.cli) {
			if (requestedApi !== undefined) throw new Error("Chat Completions requires an HTTP API provider. CLI subscriptions manage their own transport.");
			const provider = selection.cli;
			const info = CLI_PROVIDERS[provider];
			if (!info) throw new Error("Unknown saved CLI provider. Run rein setup to repair the configuration.");
			const status = await cliStatus(provider);
			if (!status.available) throw new Error(`${status.detail}\nInstall with: ${info.installCommand}`);
			if (!opts.yes && status.authenticated !== true) {
				// Release readline before an official CLI takes control of the terminal.
				releasePrompt();
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
			delete saved.api;
			persist(saved);
			log(`Saved ${info.label} configuration to ${configPath()}. Credentials remain with the official CLI.`);
			log("For optional proactive task suggestions, run rein autonomy init, then rein autonomy scan and rein autonomy tui.");
			return 0;
		}

		validateHttpApi(requestedApi ?? config.api);
		if (selection.provider === "github") throw new Error(GITHUB_MODELS_RETIRED);
		if (selection.provider && !["custom", "openai-compatible"].includes(selection.provider) && !PROVIDER_PRESETS[selection.provider]) throw new Error(`Unknown API provider "${selection.provider}". Use --base-url for a custom host.`);
		selection.baseUrl ??= selection.provider && PROVIDER_PRESETS[selection.provider]?.baseUrl;
		if (!selection.baseUrl && opts.yes && !opts.provider) {
			selection.baseUrl = config.auth?.type !== "cli" ? config.baseUrl : undefined;
			selection.provider ??= config.provider;
			if (!selection.baseUrl) {
				const expanded = opts.discoverNetwork || opts.discoverHosts?.length || opts.discoverPorts?.length;
				const report = expanded ? await (dependencies.discoverServers ?? discoverServers)({ network: opts.discoverNetwork === true, hosts: opts.discoverHosts, ports: opts.discoverPorts }) : undefined;
				if (report) printDiscoverySummary(report, log);
				const local = report ? report.servers.find(s => s.status === "ready") : (await (dependencies.discover ?? discoverLocalServers)())[0];
				if (local) {
					selection.baseUrl = local.baseUrl; selection.provider = local.provider;
					if ("sshHost" in local && typeof local.sshHost === "string") selection.sshHost = local.sshHost;
				}
			}
		}
		if (!selection.baseUrl) {
			if (opts.yes) throw new Error("No endpoint configured. Pass --base-url <host-or-IP>:<port> or --provider <name>; add --model if discovery is unavailable.");
			log("Enter the server host and listening port. For remote LM Studio, use its LAN or mesh address and port (often 1234); localhost means this machine.");
			selection.baseUrl = await getPrompt().ask("Server URL or host:port: ");
		}
		let baseUrl = normalizeBaseUrl(selection.baseUrl);
		const inferredProvider = Object.entries(PROVIDER_PRESETS).find(([name, preset]) => !LOCAL.has(name) && normalizeBaseUrl(preset.baseUrl) === baseUrl)?.[0];
		let provider = (!selection.provider || ["custom", "openai-compatible"].includes(selection.provider) ? inferredProvider : selection.provider) ?? "custom";
		let sameEndpoint = false;
		try { sameEndpoint = Boolean(config.baseUrl && config.auth?.type !== "cli" && normalizeBaseUrl(config.baseUrl) === baseUrl); } catch {}
		let sshHost = opts.sshHost ?? selection.sshHost ?? (sameEndpoint ? config.sshHost : undefined);
		if (!opts.yes && !sshHost && provider === "custom" && !selection.status) {
			log("If the remote API listens only on 127.0.0.1, Rein can reach it through an SSH host from your SSH config (for example, model-host).");
			sshHost = await getPrompt().ask("SSH host (optional; Enter for direct LAN or mesh access): ") || undefined;
		}
		const sameConnection = sameEndpoint && (config.sshHost ?? undefined) === sshHost;
		let model = selection.model ?? (sameConnection ? config.model : undefined);
		// An exact local preset may name a credential without proving the server's
		// implementation. A remote SSH loopback route never inherits that local key.
		const credentialProvider = provider === "custom" && !sshHost
			? Object.entries(PROVIDER_PRESETS).find(([name, preset]) => LOCAL.has(name) && normalizeBaseUrl(preset.baseUrl) === baseUrl)?.[0] ?? provider : provider;
		let key = keyFor(credentialProvider, baseUrl, sshHost);
		if (!sameConnection && key === config.apiKey && !process.env.REIN_API_KEY && !process.env[PROVIDER_PRESETS[credentialProvider]?.keyEnv ?? "REIN_API_KEY"]) key = undefined;
		if (key) secrets.add(key);
		let saveKey = sameConnection && key === config.apiKey ? config.apiKey : undefined;
		const keyEnv = PROVIDER_PRESETS[credentialProvider]?.keyEnv ?? "REIN_API_KEY";
		if (process.env.REIN_API_KEY || process.env[keyEnv]) saveKey = undefined;
		if (selection.status === "auth-required" && key && /Authentication was rejected/.test(selection.error ?? "")) {
			if (process.env.REIN_API_KEY === key || process.env[keyEnv] === key) throw new Error(`This server rejected the environment credential. Correct or unset ${process.env.REIN_API_KEY === key ? "REIN_API_KEY" : keyEnv}, then rerun setup.`);
			log("The server rejected its saved credential. Enter a replacement key; the existing configuration stays intact until a chat reply passes.");
			key = undefined; saveKey = undefined;
		}
		const cloud = Boolean(PROVIDER_PRESETS[provider] && !LOCAL.has(provider));
		if (!key && !opts.yes) {
			const url = API_KEY_PAGES[provider];
			if (url) {
				log(`Create an API key: ${safeDisplayUrl(url)}`);
				if (!opts.noBrowser && !await (dependencies.openBrowser ?? openBrowser)(url)) log("Browser could not open. Use the URL above on this or another device.");
			}
			key = await getPrompt().secret(cloud ? "API key (hidden): " : "API key if required (hidden; Enter for none): ");
			if (key) { secrets.add(key); saveKey = key; }
		}
		if (cloud && !key) throw new Error(`No API key for ${provider}. Set ${keyEnv} and rerun setup${provider === "xai" ? ", or choose --provider grok for SuperGrok / X Premium+ CLI sign-in" : "; choose a supported CLI provider for subscription sign-in"}.`);
		const endpoint = await detect(baseUrl, { provider, apiKey: key, sshHost });
		baseUrl = endpoint.baseUrl; provider = endpoint.provider;
		if (endpoint.error) log(`Model discovery: ${endpoint.error}`);
		if (!model && endpoint.models.length) {
			const preferred = pickDefaultModelId(endpoint.models);
			if (opts.yes) model = preferred;
			else model = endpoint.models[await choose(getPrompt(), log, "Choose model", endpoint.models, Math.max(0, endpoint.models.indexOf(preferred ?? "")))];
		}
		if (!model && !opts.yes) model = await getPrompt().ask("Model ID (if the server does not list models): ");
		if (!model) throw new Error("No model available. Load a model on the remote server or pass --model <id>. For direct access, check the listening address, port, network routing and firewall rules if discovery failed; loopback-only servers need --ssh <host>.");
		const result = await connection(baseUrl, model, key, { sshHost });
		if (!result.ok) throw new Error(`Connection test failed: ${result.detail}\nConfiguration was not saved. Correct the endpoint, credentials or model and rerun setup.`);
		const saved: Record<string, unknown> = { ...config, provider, baseUrl, model, api: "chat-completions", auth: { type: "api-key" } };
		delete saved.apiKey;
		delete saved.sshHost;
		if (sshHost) saved.sshHost = sshHost;
		if (saveKey) saved.apiKey = saveKey;
		persist(saved);
		log(`Chat Completions connection passed: ${result.detail}\nPOST ${baseUrl.replace(/\/$/, "")}/chat/completions\nSaved ${provider}/${model} at ${baseUrl} to ${configPath()}.`);
		if (key && !saveKey) log(`Using credentials from the environment; no API key was written to config.`);
		log("For optional proactive task suggestions, run rein autonomy init, then rein autonomy scan and rein autonomy tui.");
		return 0;
	} catch (error) {
		log(error instanceof Error ? error.message : String(error));
		return 1;
	} finally { if (!dependencies.keepPromptOpen) releasePrompt(); }
}
