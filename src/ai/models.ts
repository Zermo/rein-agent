/**
 * Model registry + local-server discovery.
 *
 * Local AI is the default provider. rein probes well-known OpenAI-compatible
 * servers in priority order and uses the first one that answers:
 *
 *   Ollama      http://localhost:11434/v1
 *   LM Studio   http://localhost:1234/v1
 *   llama.cpp   http://localhost:8080/v1
 *   vLLM        http://localhost:8000/v1
 *
 * Anything OpenAI-compatible works: set REIN_BASE_URL + REIN_MODEL and rein
 * will use it. Config file: ~/.rein/config.json
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "./types.ts";
import { discoverServers as probeServers, type DiscoverServersOptions, type DiscoveryDependencies, type DiscoveryEndpoint, type ServerDiscoveryReport } from "./discovery.ts";
export type { DiscoverServersOptions, DiscoveredServer, ServerDiscoveryReport, DiscoveryStatus, DiscoverySource } from "./discovery.ts";

import { PROVIDER_PRESETS, detectEndpoint, normalizeBaseUrl, guessProvider, GITHUB_MODELS_RETIRED } from "./endpoints.ts";
export { PROVIDER_PRESETS, normalizeBaseUrl, detectEndpoint, guessProvider } from "./endpoints.ts";

export interface LocalServer {
	provider: string;
	baseUrl: string;
	modelsEndpoint: string;
	/** Models the server currently has. Filled by discover(). */
	models?: string[];
	/** Filled when /models is empty but a tagged list endpoint exists (Ollama). */
	knownModels?: string[];
}

export const LOCAL_SERVERS: LocalServer[] = [
	{ provider: "ollama", baseUrl: "http://localhost:11434/v1", modelsEndpoint: "http://localhost:11434/api/tags" },
	{ provider: "lmstudio", baseUrl: "http://localhost:1234/v1", modelsEndpoint: "http://localhost:1234/v1/models" },
	{ provider: "llamacpp", baseUrl: "http://localhost:8080/v1", modelsEndpoint: "http://localhost:8080/v1/models" },
	{ provider: "vllm", baseUrl: "http://localhost:8000/v1", modelsEndpoint: "http://localhost:8000/v1/models" },
];

/** Model preferences when picking a default from a server's list. */
const PREFERRED_MODELS = [
	/qwen3-coder/i,
	/qwen2\.5-coder/i,
	/deepseek-coder/i,
	/gpt-oss/i,
	/llama3\.[12]-8b/i,
	/llama3\.1/i,
	/mistral/i,
	/codestral/i,
];

export function pickDefaultModelId(ids: string[]): string | undefined {
	if (ids.length === 0) return undefined;
	for (const re of PREFERRED_MODELS) {
		const hit = ids.find((id) => re.test(id));
		if (hit) return hit;
	}
	// Prefer larger models when names carry sizes (local models usually do)
	const withSize = ids
		.map((id) => {
			const m = id.match(/(\d+(?:\.\d+)?)\s*([bBkKmMgG])\b/);
			return { id, size: m ? parseFloat(m[1]) * ({ k: 0.000001, m: 0.001, b: 1, g: 1 }[m[2].toLowerCase()] ?? 1) : -1 };
		})
		.filter((x) => x.size >= 7)
		.sort((a, b) => b.size - a.size);
	if (withSize.length > 0) return withSize[0].id;
	return ids[0];
}

/** Probe known local addresses concurrently while retaining the configured priority. */
export async function discoverLocalServers(): Promise<LocalServer[]> {
	const results = await Promise.all(LOCAL_SERVERS.map(async server => {
		const detected = await detectEndpoint(server.baseUrl, { provider: server.provider, apiKey: scopedApiKeyFor(server.provider, server.baseUrl, undefined, false), timeoutMs: 1500 });
		return detected.models.length ? { ...server, baseUrl: detected.baseUrl, models: detected.models } : undefined;
	}));
	return results.filter((server): server is LocalServer & { models: string[] } => server !== undefined);
}

/** Localhost and explicitly configured endpoints are checked on every setup discovery. */
export async function discoverServers(options: DiscoverServersOptions = {}, dependencies: DiscoveryDependencies = {}): Promise<ServerDiscoveryReport> {
	const config = loadConfig();
	const configured: DiscoveryEndpoint[] = [];
	const savedBase = config.auth?.type !== "cli" ? config.baseUrl ?? (config.provider ? PROVIDER_PRESETS[config.provider.toLowerCase()]?.baseUrl : undefined) : undefined;
	const envBase = process.env.REIN_BASE_URL?.trim();
	if (envBase && !envBase.startsWith("cli://")) {
		try {
			const normalized = normalizeBaseUrl(envBase);
			let sameSaved = false;
			try { sameSaved = !!savedBase && normalizeBaseUrl(savedBase) === normalized; } catch { /* A malformed saved URL cannot hide a valid environment URL. */ }
			const sshHost = sameSaved ? config.sshHost : undefined;
			const inferred = guessProvider(normalized, "openai-compatible");
			const provider = sameSaved ? config.provider ?? "openai-compatible" : LOCAL_SERVERS.some(server => server.provider === inferred) ? "openai-compatible" : inferred;
			configured.push({ baseUrl: normalized, provider, source: "environment", sshHost, apiKey: apiKeyFor(provider, normalized, sshHost) });
		} catch { /* Invalid URLs remain actionable when explicitly selected in setup. */ }
	}
	if (savedBase && !savedBase.startsWith("cli://")) {
		const provider = config.provider ?? "openai-compatible";
		configured.push({ baseUrl: savedBase, provider, source: "configured", sshHost: config.sshHost,
			apiKey: scopedApiKeyFor(provider, savedBase, config.sshHost, !envBase) });
	}
	// Provider-specific local keys remain scoped to the exact documented local listener.
	for (const server of LOCAL_SERVERS) {
		const key = scopedApiKeyFor(server.provider, server.baseUrl, undefined, false);
		if (key) configured.push({ baseUrl: server.baseUrl, source: "localhost", provider: "openai-compatible", apiKey: key });
	}
	return probeServers({ ...options, configured: [...configured, ...(options.configured ?? [])] }, dependencies);
}

export interface ReinConfig {
	provider?: string;
	api?: "chat-completions";
	auth?: { type: "api-key" | "cli"; provider?: "codex" | "copilot" | "grok"; command?: never };
	sshHost?: string;
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	temperature?: number;
	maxTokens?: number;
	repeatToolLimit?: number;
	toolsMode?: "native" | "text" | "auto";
	contextWindow?: number;
	posthorse?: { enabled?: boolean; reserveTokens?: number };
	obscura?: { bin?: string; timeoutSeconds?: number; allowPrivateNetwork?: boolean };
}

/** Config files are untrusted JSON; only the implemented HTTP protocol is accepted. */
export function validateHttpApi(api: unknown): "chat-completions" {
	if (api !== undefined && api !== "chat-completions") throw new Error("Supported HTTP API: chat-completions. Use --api chat-completions with an OpenAI-compatible endpoint.");
	return "chat-completions";
}

/** Credentials are selected for the logical endpoint, before any SSH forwarding. */
export function apiKeyFor(provider?: string, baseUrl?: string, sshHost?: string): string | undefined {
	return scopedApiKeyFor(provider, baseUrl, sshHost, true);
}

function scopedApiKeyFor(provider?: string, baseUrl?: string, sshHost?: string, allowGeneric = true): string | undefined {
	provider = provider?.toLowerCase();
	if (provider === "codex" || provider === "copilot" || provider === "grok" || baseUrl?.startsWith("cli://")) return undefined;
	const config = loadConfig();
	const preset = provider ? PROVIDER_PRESETS[provider] : undefined;
	const target = baseUrl ?? preset?.baseUrl ?? config.baseUrl;
	let normalized: string | undefined;
	try { if (target) normalized = normalizeBaseUrl(target); } catch { return undefined; }
	// This explicit generic variable applies to the user's selected API endpoint.
	if (allowGeneric && process.env.REIN_API_KEY) return process.env.REIN_API_KEY;
	if (["custom", "openai-compatible"].includes(provider ?? "") && normalized && !sshHost) {
		// A provider-specific local key identifies its documented listener, not the
		// implementation answering there. Keep the custom adapter and exact path.
		const local = LOCAL_SERVERS.find(server => normalizeBaseUrl(server.baseUrl) === normalized);
		const key = local ? process.env[PROVIDER_PRESETS[local.provider].keyEnv] : undefined;
		if (key) return key;
	}
	if (preset && normalized && new URL(normalized).origin === new URL(preset.baseUrl).origin) {
		const key = process.env[preset.keyEnv];
		if (key) return key;
	}
	if (!normalized || !config.apiKey || config.auth?.type === "cli" || config.sshHost !== sshHost) return undefined;
	const configured = config.baseUrl ?? (config.provider ? PROVIDER_PRESETS[config.provider]?.baseUrl : undefined);
	try { return configured && normalizeBaseUrl(configured) === normalized ? config.apiKey : undefined; }
	catch { return undefined; }
}

export function loadConfig(): ReinConfig {
	const path = join(process.env.REIN_HOME || join(homedir(), ".rein"), "config.json");
	try {
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ReinConfig : {};
		}
	} catch {
		// bad config file: ignore (reported by `rein doctor` if we add one)
	}
	return {};
}

/**
 * Resolve the active model:
 *   1. CLI base URL or provider, then environment, then config
 *   2. Selected endpoint + explicit/configured model, or its /models list
 *   3. Local discovery only when no endpoint was selected
 */
export async function resolveModel(
	overrides: { model?: string; baseUrl?: string; provider?: string; sshHost?: string; api?: string } = {},
): Promise<Model> {
	const config = loadConfig();
	const envBase = process.env.REIN_BASE_URL?.trim() || undefined;
	const envModel = process.env.REIN_MODEL?.trim() || undefined;
	const providerOverride = overrides.provider?.toLowerCase();
	const requestedApi = overrides.api ?? (process.env.REIN_API?.trim() || undefined);
	if (requestedApi !== undefined) validateHttpApi(requestedApi);
	const selectingEndpoint = overrides.baseUrl !== undefined || !!envBase;
	const configuredProvider = config.provider?.toLowerCase() ?? (config.auth?.type === "cli" ? config.auth.provider : undefined);
	const providerName = providerOverride ?? (selectingEndpoint ? undefined : configuredProvider);
	if (providerName === "github") throw new Error(GITHUB_MODELS_RETIRED);
	if (providerName === "codex" || providerName === "copilot" || providerName === "grok") {
		if (requestedApi !== undefined) throw new Error("--api/REIN_API selects an HTTP API protocol. Subscription CLI providers manage their own transport.");
		if (overrides.baseUrl !== undefined || envBase) throw new Error(`CLI provider ${providerName} cannot be combined with an HTTP base URL. Remove --base-url/REIN_BASE_URL or select an API provider.`);
		if (overrides.sshHost) throw new Error("SSH forwarding applies to HTTP API providers, not subscription CLI providers.");
		return {
			id: overrides.model ?? envModel ?? (configuredProvider === providerName ? config.model : undefined) ?? "default",
			provider: providerName, baseUrl: `cli://${providerName}`,
			contextWindow: config.contextWindow ?? 32_768, maxTokens: config.maxTokens ?? 4096,
		};
	}
	validateHttpApi(requestedApi ?? config.api);
	const preset = providerName ? PROVIDER_PRESETS[providerName] : undefined;
	if (providerOverride && !preset && !["custom", "openai-compatible"].includes(providerOverride)) {
		throw new Error(`Unknown provider "${overrides.provider}". Known: ${Object.keys(PROVIDER_PRESETS).join(", ")}, codex, copilot, grok, custom`);
	}
	// Config URLs belong to their auth mode; selecting an API cannot inherit a CLI URL.
	const configuredBase = config.auth?.type !== "cli" && !config.baseUrl?.startsWith("cli://") ? config.baseUrl : undefined;
	const rawBase = overrides.baseUrl ?? (providerOverride ? preset?.baseUrl : undefined) ?? envBase ?? configuredBase ?? preset?.baseUrl;
	const baseUrl = rawBase ? normalizeBaseUrl(rawBase, providerName) : "";
	let sameEndpoint = false;
	try { sameEndpoint = !!baseUrl && normalizeBaseUrl(configuredBase ?? (configuredProvider ? PROVIDER_PRESETS[configuredProvider]?.baseUrl ?? "" : "")) === baseUrl; } catch { /* No valid saved endpoint. */ }
	if (overrides.sshHost !== undefined && overrides.sshHost !== config.sshHost) sameEndpoint = false;
	const modelId = overrides.model ?? envModel ?? (sameEndpoint || !baseUrl && !configuredBase && config.auth?.type !== "cli" ? config.model : undefined);
	const sshHost = overrides.sshHost ?? (sameEndpoint ? config.sshHost : undefined);
	const metadata = { contextWindow: config.contextWindow ?? 32_768, maxTokens: config.maxTokens ?? 4096, ...(sshHost ? { sshHost } : {}) };
	if (baseUrl) {
		const provider = providerName ?? guessProvider(baseUrl, "custom");
		if (modelId) return { id: modelId, provider, baseUrl, ...metadata };
		const detected = await detectEndpoint(baseUrl, { provider, apiKey: apiKeyFor(provider, baseUrl, sshHost), sshHost });
		const id = pickDefaultModelId(detected.models);
		if (!id) throw new Error(`No models found at ${baseUrl}. ${detected.error ?? "Specify --model or REIN_MODEL for this endpoint."}`);
		return { id, provider: detected.provider, baseUrl: detected.baseUrl, ...metadata };
	}
	const servers = await discoverLocalServers();
	const server = modelId ? servers.find(server => server.models?.includes(modelId)) : servers[0];
	if (server) {
		const id = modelId ?? pickDefaultModelId(server.models ?? []);
		if (id) return { id, provider: server.provider, baseUrl: server.baseUrl, ...metadata };
	}
	if (modelId) throw new Error(`Model "${modelId}" was not found on a local server. Specify --base-url or --provider for its endpoint.`);
	throw new Error(
		"No local AI server found.\n" +
		"Start one (e.g. ollama serve or LM Studio's local server), or run rein setup with the host and port.\n" +
		"Example: REIN_BASE_URL=http://localhost:11434/v1 REIN_MODEL=qwen2.5-coder:7b rein ...",
	);
}
