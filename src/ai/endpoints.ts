/** OpenAI-compatible endpoint normalization and bounded, same-origin discovery. */
import { withSshTunnel } from "./ssh.ts";
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
	// https://ai.google.dev/gemini-api/docs/openai
	gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY" },
};
export const GITHUB_MODELS_RETIRED = "GitHub Models was retired on July 30, 2026. Choose an active API provider, or explicitly choose Copilot CLI subscription authentication. See https://docs.github.com/en/github-models.";
const PORT_PROVIDERS: Record<string, string> = { "11434": "ollama", "1234": "lmstudio", "8080": "llamacpp", "8000": "vllm" };

function localHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host === "::1" || host.startsWith("fc") && host.includes(":") || host.startsWith("fd") && host.includes(":")) return true;
	if (!host.includes(".") && !host.includes(":")) return true;
	if (/\.(?:localhost|local|lan|internal|netbird\.cloud|netbird\.selfhosted|ts\.net)$/.test(host)) return true;
	const parts = host.split(".").map(Number);
	if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	return parts[0] === 10 || parts[0] === 127 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127 || parts[0] === 169 && parts[1] === 254;
}

function parseEndpoint(input: string): URL {
	const value = input.trim();
	if (!value) throw new Error("Enter the host or API URL, for example 100.64.0.5:1234 or https://server.example/v1.");
	let url: URL;
	try {
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) url = new URL(value);
		else {
			const bare = value.replace(/^\/\//, "");
			const candidate = new URL(`http://${bare}`);
			url = new URL(`${localHost(candidate.hostname) || candidate.port && candidate.port !== "443" ? "http" : "https"}://${bare}`);
		}
	} catch { throw new Error("Invalid API URL. Use a host and optional port, or an http:// or https:// URL."); }
	if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error("API endpoints must use http:// or https://.");
	if (url.username || url.password) throw new Error("Do not put credentials in the API URL. Enter the API key separately.");
	if (url.search || url.hash) throw new Error("Use the API base URL without query parameters or a fragment; enter credentials separately.");
	return url;
}

export function guessProvider(input: string, fallback = "openai-compatible"): string {
	const url = parseEndpoint(input);
	if (["models.github.ai", "models.inference.ai.azure.com"].includes(url.hostname)) return "github";
	for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
		if (url.origin === new URL(preset.baseUrl).origin) return name;
	}
	if (localHost(url.hostname) && PORT_PROVIDERS[url.port]) return PORT_PROVIDERS[url.port];
	return fallback;
}

export function normalizeBaseUrl(input: string, provider?: string): string {
	const url = parseEndpoint(input);
	const inferred = guessProvider(url.toString());
	if (inferred === "github" || provider?.toLowerCase() === "github") throw new Error(GITHUB_MODELS_RETIRED);
	let path = url.pathname.replace(/\/+$/, "");
	const wasRoute = /\/(?:chat\/completions|models)$/.test(path);
	path = path.replace(/\/(?:chat\/completions|models)$/, "");
	const preset = PROVIDER_PRESETS[inferred];
	// Canonical cloud API prefixes are only inferred on the provider's own origin.
	if (preset && url.origin === new URL(preset.baseUrl).origin && (!path || path === "/v1" || new URL(preset.baseUrl).pathname.startsWith(path + "/"))) {
		path = new URL(preset.baseUrl).pathname;
	} else if ((provider === "ollama" || inferred === "ollama") && ["/api", "/api/chat", "/api/tags", "/api/generate"].includes(path)) {
		path = "/v1";
	} else if (!path && !wasRoute && !/^https?:\/\/[^/]+\/$/i.test(input.trim())) path = "/v1";
	return url.origin + (path || "/");
}

export interface DetectedEndpoint { baseUrl: string; provider: string; models: string[]; error?: string; }

function modelIds(doc: any): string[] | undefined {
	const values = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc?.models) ? doc.models : undefined;
	if (!values) return undefined;
	const ids = values.map((item: any) => typeof item === "string" ? item : item?.id ?? item?.name ?? item?.model).filter((id: unknown) => typeof id === "string" && id.length > 0);
	if (values.length && !ids.length) return undefined;
	return [...new Set(ids)] as string[];
}

/** Some self-hosted servers advertise their implementation in the model list. */
function serverProvider(doc: any, fallback: string): string {
	if (fallback !== "custom" && fallback !== "openai-compatible") return fallback;
	const values = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc?.models) ? doc.models : [];
	const owner = values.map((item: any) => `${item?.owned_by ?? ""} ${item?.object ?? ""}`).join(" ").toLowerCase();
	if (/llama[._ -]?cpp|llama-server/.test(owner)) return "llamacpp";
	if (/\bollama\b/.test(owner)) return "ollama";
	if (/\bvllm\b/.test(owner)) return "vllm";
	if (/lm[ _-]?studio/.test(owner)) return "lmstudio";
	return fallback;
}

/** Probe a few path variants on the supplied origin; never scan hosts or ports. */
export interface DetectEndpointOptions { provider?: string; apiKey?: string; timeoutMs?: number; sshHost?: string; }
export async function detectEndpoint(input: string, options: DetectEndpointOptions = {}): Promise<DetectedEndpoint> {
	const logicalBase = normalizeBaseUrl(input, options.provider);
	const provider = options.provider?.toLowerCase() ?? guessProvider(logicalBase, "custom");
	try {
		return await withSshTunnel(logicalBase, options.sshHost, async forwardedBase => {
			const detected = await detectEndpointDirect(forwardedBase, { ...options, provider });
			const logicalOrigin = new URL(logicalBase).origin;
			const forwardedOrigin = new URL(forwardedBase).origin;
			return { ...detected, baseUrl: logicalOrigin + (new URL(detected.baseUrl).pathname === "/" ? "/" : new URL(detected.baseUrl).pathname.replace(/\/$/, "")),
				...(detected.error ? { error: detected.error.replaceAll(forwardedOrigin, logicalOrigin) } : {}) };
		});
	} catch (error) { return { baseUrl: logicalBase, provider, models: [], error: (error as Error).message }; }
}

async function detectEndpointDirect(input: string, options: DetectEndpointOptions): Promise<DetectedEndpoint> {
	const baseUrl = normalizeBaseUrl(input, options.provider);
	const provider = options.provider?.toLowerCase() ?? guessProvider(baseUrl, "custom");
	const result: DetectedEndpoint = { baseUrl, provider, models: [] };
	const url = new URL(baseUrl);
	const bases = [baseUrl.replace(/\/$/, "")];
	if (url.pathname.endsWith("/v1")) bases.push(baseUrl.slice(0, -3));
	else if (provider === "custom" || provider === "openai-compatible") bases.push(`${baseUrl.replace(/\/$/, "")}/v1`);
	const probes = [...new Set(bases)].map(base => ({ base, endpoint: `${base}/models` }));
	if (provider === "ollama") probes.push({ base: `${url.origin}/v1`, endpoint: `${url.origin}/api/tags` });
	const deadline = Date.now() + Math.max(1, options.timeoutMs ?? 2500);
	let error = "No compatible model list was found.";
	for (const probe of probes) {
		const controller = new AbortController();
		const remaining = deadline - Date.now();
		if (remaining <= 0) return { ...result, error: `Connection timed out while checking ${url.origin}. Check the host, port, VPN connection, and server bind address.` };
		const timer = setTimeout(() => controller.abort(), remaining);
		try {
			let endpoint = probe.endpoint;
			let response: Response | undefined;
			for (let redirects = 0; redirects <= 2; redirects++) {
				response = await fetch(endpoint, { signal: controller.signal, redirect: "manual", headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : undefined });
				if (![301, 302, 303, 307, 308].includes(response.status)) break;
				const location = response.headers.get("location");
				if (!location) break;
				const target = new URL(location, endpoint);
				await response.body?.cancel();
				if (target.origin !== url.origin || target.username || target.password) return { ...result, error: "Endpoint redirected to another origin. Enter the final trusted API URL explicitly; credentials were not forwarded." };
				endpoint = target.toString();
				if (redirects === 2) return { ...result, error: "Too many API endpoint redirects. Enter the final API base URL." };
			}
			if (response!.status === 401 || response!.status === 403) {
				await response!.body?.cancel();
				return { ...result, baseUrl: probe.base, error: `Authentication ${options.apiKey ? "was rejected" : "is required"} (HTTP ${response!.status}). Enter a valid API key for this endpoint.` };
			}
			if (!response!.ok) {
				error = response!.status === 404 ? `API path not found (HTTP 404) at ${probe.endpoint}. Check the server's OpenAI-compatible API prefix.` : `API returned HTTP ${response!.status} at ${probe.endpoint}.`;
				await response!.body?.cancel();
				continue;
			}
			let doc: unknown;
			try { doc = await response!.json(); } catch {
				if (controller.signal.aborted) throw new Error("Timed out");
				error = `Invalid model list at ${probe.endpoint}: expected JSON, but received another response (possibly a web UI).`;
				continue;
			}
			const models = modelIds(doc);
			if (!models) { error = `Invalid model list at ${probe.endpoint}: expected a data[] or models[] array of model IDs.`; continue; }
			const rawDetectedBase = endpoint.endsWith("/models") ? endpoint.slice(0, -7) : probe.base;
			const detectedBase = new URL(rawDetectedBase).pathname === "/" ? new URL(rawDetectedBase).origin + "/" : rawDetectedBase;
			return { baseUrl: detectedBase, provider: serverProvider(doc, provider), models, ...(models.length ? {} : { error: "The API is reachable but has no available models. Load a model in the server, or specify its model ID manually." }) };
		} catch (err) {
			if (controller.signal.aborted || (err as Error).name === "AbortError") return { ...result, error: `Connection timed out while checking ${url.origin}. Check the host, port, VPN connection, and server bind address.` };
			const cause = (err as { cause?: { code?: string }; code?: string });
			const code = cause.cause?.code ?? cause.code;
			return { ...result, error: `${code === "ECONNREFUSED" ? "Connection refused" : code === "ENOTFOUND" || code === "EAI_AGAIN" ? "Host name could not be resolved" : "Could not connect"} at ${url.origin}. Check the host, port, VPN connection, and server bind address.` };
		} finally { clearTimeout(timer); }
	}
	return { ...result, error };
}
