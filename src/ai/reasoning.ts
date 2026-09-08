/** Request controls, never a claim about hidden reasoning or response quality.
 * Protocol sources checked 2026-09-07:
 * https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
 * https://developers.openai.com/api/docs/guides/latest-model
 * https://docs.x.ai/developers/model-capabilities/text/reasoning
 * https://docs.ollama.com/api/openai-compatibility
 * https://docs.ollama.com/capabilities/thinking
 * https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 * https://docs.vllm.ai/en/stable/features/reasoning_outputs/
 */
import type { Model } from "./types.ts";

export const REASONING_EFFORTS = ["default", "off", "low", "medium", "high"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export interface ReasoningCapabilities {
	supported: ReasoningEffort[];
	mode: "supported" | "server-dependent" | "unsupported";
	description: string;
	field?: "reasoning_effort";
}
type Target = Pick<Model, "id" | "provider" | "baseUrl">;
const graded: ReasoningEffort[] = ["default", "low", "medium", "high"];
const all: ReasoningEffort[] = [...REASONING_EFFORTS];
export function validateReasoningEffort(value: unknown): ReasoningEffort {
	if (value === undefined) return "default";
	if (typeof value !== "string" || !REASONING_EFFORTS.includes(value as ReasoningEffort)) throw new Error("reasoningEffort must be default, off, low, medium, or high.");
	return value as ReasoningEffort;
}
function result(supported: ReasoningEffort[], mode: ReasoningCapabilities["mode"], description: string): ReasoningCapabilities {
	return { supported: [...supported], mode, description, ...(supported.length > 1 ? { field: "reasoning_effort" as const } : {}) };
}
/** A local API can accept a field without its template implementing graded effort. */
export function reasoningCapabilities(model: Target): ReasoningCapabilities {
	const provider = model.provider.toLowerCase(), id = model.id.toLowerCase();
	let host = "";
	try { host = new URL(model.baseUrl).hostname; } catch { /* Invalid URLs are rejected by endpoint setup. */ }
	if (model.baseUrl.startsWith("cli://") || ["codex", "copilot", "grok"].includes(provider)) return result(["default"], "unsupported", "The subscription CLI manages its own reasoning settings; Rein cannot override them through Chat Completions.");
	if (provider === "openai" || host === "api.openai.com") {
		const dated = id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
		if (dated === "gpt-6-astra") return result(graded, "supported", "GPT-6 Astra accepts graded reasoning effort and cannot disable reasoning. Native tool calling requires Responses; Chat Completions can use Rein's text tool protocol.");
		if (/^(?:gpt-5\.[1245](?:-mini|-nano)?|gpt-5\.6-(?:sol|terra|luna))$/.test(dated)) return result(all, "supported", "Uses the OpenAI reasoning_effort control. Off sends none; default leaves the model's server default unchanged. Higher effort can use more tokens and time.");
		if (/^(?:gpt-5(?:-mini|-nano)?|o1|o3(?:-mini)?|o4-mini)$/.test(dated)) return result(graded, "supported", "This model supports low, medium, and high reasoning effort. It has no verified off setting; default preserves the provider's choice.");
		return result(["default"], "unsupported", "No verified reasoning-effort mapping for this OpenAI model on Chat Completions. Use default or select a supported reasoning model.");
	}
	if (provider === "xai" || host === "api.x.ai") {
		if (/^grok-4\.[56](?:-latest|-\d{4}-\d{2}-\d{2})?$/.test(id)) return result(graded, "supported", "Grok 4.5 and 4.6 accept graded reasoning_effort. Reasoning cannot be disabled.");
		return result(["default"], "unsupported", "No verified reasoning-effort control for this Grok model on Chat Completions. Default preserves server behavior.");
	}
	if (["ollama", "llamacpp", "vllm", "lmstudio", "custom", "openai-compatible"].includes(provider)) {
		if (/(?:^|[/:-])gpt[-_]?oss(?:[/:-]|$)/.test(id)) return result(graded, provider === "ollama" ? "supported" : "server-dependent", "GPT-OSS supports low, medium, and high effort; its reasoning cannot be fully disabled. The serving engine and template must forward reasoning_effort.");
		if (/deepseek[-_]?r1|(?:^|[-_/])thinking(?:[-_/]|$)/.test(id)) return result(["default"], "unsupported", "This model is identified as a dedicated reasoning model. Rein has no verified per-request effort or off control for its template.");
		if (provider === "llamacpp" || provider === "vllm") return result(all, "server-dependent", "Off requests disabled thinking. Other levels are passed to the chat template. The loaded model/template must support graded effort; some Qwen models only switch thinking on or off, so these levels do not guarantee different reasoning strength.");
		if (provider === "ollama") return result(all, "server-dependent", "Ollama receives reasoning_effort. Available levels depend on the model; some models only switch thinking on or off. Default keeps server behavior and unsupported requests remain visible as errors.");
		return result(all, "server-dependent", "Rein forwards reasoning_effort to this compatible endpoint. Support is unverified and a server may ignore the field; check its model/template settings. Default leaves server behavior unchanged.");
	}
	return result(["default"], "unsupported", "This provider has no verified Chat Completions reasoning-effort mapping in Rein. Use default to keep its existing behavior.");
}

export function reasoningRequestFields(model: Target, value: unknown): Record<string, unknown> {
	const effort = validateReasoningEffort(value);
	if (effort === "default") return {};
	const capabilities = reasoningCapabilities(model);
	if (!capabilities.supported.includes(effort)) throw new Error(`Reasoning effort ${effort} is not supported for ${model.provider}/${model.id}. ${capabilities.description}`);
	const wire = effort === "off" ? "none" : effort;
	// Older local servers need explicit template kwargs; unlike a prompt hint,
	// these are the documented template controls. They still require model support.
	return { reasoning_effort: wire, ...(["llamacpp", "vllm"].includes(model.provider.toLowerCase())
		? { chat_template_kwargs: { enable_thinking: effort !== "off", reasoning_effort: wire } } : {}) };
}

/** Explicit user controls cannot be shadowed by extension fields or silently downgraded. */
export function applyReasoningRequest(body: Record<string, unknown>, model: Target, effort: unknown): void {
	const fields = reasoningRequestFields(model, effort);
	if (!Object.keys(fields).length) return;
	if (body.model !== undefined && body.model !== model.id) throw new Error("Explicit reasoningEffort conflicts with an extra model override; select the target model directly.");
	if (model.provider.toLowerCase() === "openai" && /^gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/.test(model.id) && Array.isArray(body.tools) && body.tools.length) throw new Error("GPT-6 Astra native tool calling requires Responses. Use Rein's text tool mode with Chat Completions or choose a model that supports native tools here.");
	const wire = fields.reasoning_effort;
	for (const key of ["reasoning", "think", "thinking", "reasoning_budget", "thinking_budget"]) {
		if (body[key] !== undefined) throw new Error(`Explicit reasoningEffort conflicts with extra ${key}; use one reasoning control.`);
	}
	if (body.reasoning_effort !== undefined && body.reasoning_effort !== wire) throw new Error("Explicit reasoningEffort conflicts with extra reasoning_effort.");
	const existing = body.chat_template_kwargs;
	if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) throw new Error("chat_template_kwargs must be an object when reasoningEffort is set.");
	const kwargs = existing as Record<string, unknown> | undefined;
	if ((kwargs?.enable_thinking !== undefined && kwargs.enable_thinking !== (wire !== "none")) || (kwargs?.reasoning_effort !== undefined && kwargs.reasoning_effort !== wire)) throw new Error("Explicit reasoningEffort conflicts with extra chat_template_kwargs.");
	Object.assign(body, fields);
	if (fields.chat_template_kwargs) body.chat_template_kwargs = { ...kwargs, ...(fields.chat_template_kwargs as Record<string, unknown>) };
}
