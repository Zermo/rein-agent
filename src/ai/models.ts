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

/**
 * Cloud provider presets — "any provider" works with `rein --provider <name>`.
 * API key is read from the provider's conventional env var.
 */
export const PROVIDER_PRESETS: Record<string, { baseUrl: string; keyEnv: string }> = {
	ollama: { baseUrl: "http://localhost:11434/v1", keyEnv: "OLLAMA_API_KEY" },
	lmstudio: { baseUrl: "http://localhost:1234/v1", keyEnv: "LMSTUDIO_API_KEY" },
	llamacpp: { baseUrl: "http://localhost:8080/v1", keyEnv: "LLAMACPP_API_KEY" },
	vllm: { baseUrl: "http://localhost:8000/v1", keyEnv: "VLLM_API_KEY" },
	openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
	deepseek: { baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
	groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
	together: { baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY" },
	openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
	mistral: { baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY" },
	fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY" },
	cerebras: { baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY" },
	huggingface: { baseUrl: "https://router.huggingface.co/v1", keyEnv: "HF_TOKEN" },
	github: { baseUrl: "https://models.inference.ai.azure.com/v1", keyEnv: "GITHUB_TOKEN" },
};

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
			const m = id.match(/(\d+(?:\.\d+)?)\s*[bBkKmMgG]\b/);
			return { id, size: m ? parseFloat(m[1]) * (m[2]!.toLowerCase() === "k" ? 0.001 : 1) : -1 };
		})
		.filter((x) => x.size >= 7)
		.sort((a, b) => b.size - a.size);
	if (withSize.length > 0) return withSize[0].id;
	return ids[0];
}

async function fetchJson(url: string, timeoutMs = 1500): Promise<any> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) return undefined;
		return await res.json();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** Probe each well-known local server. Returns those that are alive, in priority order. */
export async function discoverLocalServers(): Promise<LocalServer[]> {
	const alive: LocalServer[] = [];
	for (const server of LOCAL_SERVERS) {
		// /v1/models is the OpenAI-compatible shape; Ollama also serves /api/tags
		let models: string[] = [];
		let data = await fetchJson(server.baseUrl + "/models");
		if (data?.data?.map) models = data.data.map((m: any) => m.id).filter(Boolean);
		if (models.length === 0) {
			data = await fetchJson(server.modelsEndpoint);
			if (data?.models?.map) models = data.models.map((m: any) => m.name ?? m.model ?? m.id).filter(Boolean);
		}
		if (models.length === 0) continue; // server not running (or no models)
		alive.push({ ...server, models });
		if (alive.length >= 1 && server.provider === "ollama") continue; // keep probing all, but stop early on ollama for default pick
	}
	return alive;
}

export interface ReinConfig {
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	temperature?: number;
	maxTokens?: number;
	toolsMode?: "native" | "text" | "auto";
	contextWindow?: number;
	tinyfish?: { apiKey?: string };
}

export function apiKeyFor(provider?: string): string | undefined {
	if (provider && PROVIDER_PRESETS[provider]) {
		const envKey = process.env[PROVIDER_PRESETS[provider].keyEnv];
		if (envKey) return envKey;
	}
	const config = loadConfig();
	return config.apiKey;
}

export function loadConfig(): ReinConfig {
	const path = join(homedir(), ".rein", "config.json");
	try {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as ReinConfig;
	} catch {
		// bad config file: ignore (reported by `rein doctor` if we add one)
	}
	return {};
}

/**
 * Resolve the active model:
 *   1. explicit override (env REIN_BASE_URL+REIN_MODEL, or --model with --base-url)
 *   2. config file model (if its base url is set)
 *   3. first discovered local server + preferred model
 *   4. config file base url + model with no discovery
 */
export async function resolveModel(
	overrides: { model?: string; baseUrl?: string; provider?: string } = {},
): Promise<Model> {
	const config = loadConfig();
	const envBase = process.env.REIN_BASE_URL;
	const envModel = process.env.REIN_MODEL;

	// --provider name → preset base url (unless an explicit --base-url wins)
	let providerBaseUrl: string | undefined;
	let providerName: string | undefined;
	if (overrides.provider) {
		const preset = PROVIDER_PRESETS[overrides.provider.toLowerCase()];
		if (!preset) {
			throw new Error(`Unknown provider "${overrides.provider}". Known: ${Object.keys(PROVIDER_PRESETS).join(", ")}`);
		}
		providerBaseUrl = preset.baseUrl;
		providerName = overrides.provider.toLowerCase();
	}

	const baseUrl = (overrides.baseUrl ?? envBase ?? config.baseUrl ?? (providerBaseUrl ?? "")).replace(/\/$/, "");
	const modelId = overrides.model ?? envModel ?? config.model;

	if (baseUrl && modelId) {
		return {
			id: modelId,
			provider: providerName ?? (overrides.baseUrl ? "custom" : (await guessProvider(baseUrl))),
			baseUrl,
			contextWindow: config.contextWindow ?? 32_768,
			maxTokens: config.maxTokens ?? 4096,
		};
	}

	const servers = await discoverLocalServers();
	if (servers.length > 0) {
		const server = servers[0];
		const id = modelId && server.models?.includes(modelId) ? modelId : pickDefaultModelId(server.models ?? []);
		if (id) {
			return {
				id,
				provider: server.provider,
				baseUrl: server.baseUrl,
				contextWindow: config.contextWindow ?? 32_768,
				maxTokens: config.maxTokens ?? 4096,
			};
		}
	}

	if (baseUrl && config.model) {
		return { id: config.model, provider: "custom", baseUrl, contextWindow: config.contextWindow ?? 32_768, maxTokens: config.maxTokens ?? 4096 };
	}

	throw new Error(
		"No local AI server found.\n" +
			"Start one (e.g. `ollama serve` + `ollama pull qwen2.5-coder:7b`, or LM Studio's local server), or set:\n" +
			"  REIN_BASE_URL=http://localhost:11434/v1 REIN_MODEL=qwen2.5-coder:7b rein ...\n" +
			"See `rein models` for what rein can see.",
	);
}

async function guessProvider(baseUrl: string): Promise<string> {
	if (baseUrl.includes("11434")) return "ollama";
	if (baseUrl.includes("1234")) return "lmstudio";
	if (baseUrl.includes("8080")) return "llamacpp";
	if (baseUrl.includes("8000")) return "vllm";
	return "openai-compatible";
}
