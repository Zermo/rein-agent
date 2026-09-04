/**
 * Tool-capability compatibility layer.
 *
 * Requirement: ANY chosen model or provider gets working tool calls, even
 * when the model has no native function calling. Three layers:
 *
 *  1. Capability table — model-name patterns with known native support.
 *     Known-good → native. Known-weak → text protocol from the start.
 *     Unknown → native, with runtime fallback armed.
 *  2. Runtime auto-fallback — when a native toolUse turn comes back with
 *     every call's arguments empty or unparseable (the classic small-model
 *     failure), the harness flips the model to text mode for the rest of the
 *     session, injects one corrective nudge, and records the decision.
 *  3. Learned modes — decisions persist in ~/.rein/capabilities.json, so the
 *     next session starts in the mode that already works.
 *
 * The text protocol itself lives in ai/openai-completions.ts (toolsMode).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool } from "./types.ts";

export type ToolMode = "native" | "text" | "auto";

export interface CapabilityDecision {
	mode: Exclude<ToolMode, "auto">;
	/** Why: "table" (name pattern), "learned" (persisted), "runtime" (observed), "forced" (flag). */
	source: "table" | "learned" | "runtime" | "forced" | "default";
}

/** Models with reliable native tool calling. */
const NATIVE_OK = [
	/qwen[23]/i,
	/llama3\.[123]/i,
	/deepseek/i,
	/gpt-[345]/i,
	/gpt-oss/i,
	/mistral/i,
	/mixtral/i,
	/codestral/i,
	/gemma[23]/i,
	/phi[-_]?4/i,
	/granite/i,
	/llama[-_]?4/i,
	/olmo/i,
	/command-r/i,
	/command[-_]?a/i,
	/starcoder2/i,
	/codegemma/i,
	/glm[-_]?4/i,
	/minicpm[-_]?3/i,
];

/** Models that generally lack (reliable) native tool calling. */
const NATIVE_NO = [
	/tinyllama/i,
	/tiny[-_]?dolphin/i,
	/qwen0\.[0-9]+b/i,
	/qwen[12][-_.]?[0-9]+b/i,
	/gemma-?[12]b?/i,
	/phi[-_]?2/i,
	/phi[-_]?3-mini/i,
	/llama3\.2[-_]?1b/i,
	/llama[-_]?1b/i,
	/smollm/i,
	/mistral[-_]?7b[-_]?instruct[-_]?v0\.1/i,
	/falcon[-_]?7b/i,
	/redpajama/i,
	/openchat[-_]?3\.5/i,
	/starcoder[-_]?1b/i,
];

const reinHome = () => process.env.REIN_HOME || join(homedir(), ".rein");
const storePath = () => join(reinHome(), "capabilities.json");

function readStore(): Record<string, CapabilityDecision> {
	try {
		if (existsSync(storePath())) return JSON.parse(readFileSync(storePath(), "utf8"));
	} catch {
		// corrupted store: start fresh
	}
	return {};
}

export function keyFor(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/** Decide the tool mode for a model. `forced` wins (CLI --tools). */
export function decideToolMode(provider: string, modelId: string, forced: ToolMode = "auto"): CapabilityDecision {
	const key = keyFor(provider, modelId);
	const store = readStore();

	if (forced !== "auto") {
		const mode: CapabilityDecision = { mode: forced, source: "forced" };
		try {
			mkdirSync(reinHome(), { recursive: true });
			store[key] = mode;
			writeFileSync(storePath(), JSON.stringify(store, null, 2));
		} catch {
			// best effort
		}
		return mode;
	}

	// Learned runtime decisions are the freshest knowledge — trust them first.
	const learned = store[key];
	if (learned?.source === "runtime" || learned?.source === "forced") return learned;

	for (const re of NATIVE_NO) if (re.test(modelId)) return { mode: "text", source: "table" };
	for (const re of NATIVE_OK) if (re.test(modelId)) return { mode: "native", source: "table" };

	// Unknown model: assume native (most servers advertise tools), fallback armed.
	if (learned) return learned;
	return { mode: "native", source: "default" };
}

/** Persist a decision (used by the runtime fallback and --tools). */
export function recordDecision(provider: string, modelId: string, mode: "native" | "text", source: CapabilityDecision["source"]): void {
	try {
		mkdirSync(reinHome(), { recursive: true });
		const store = readStore();
		store[keyFor(provider, modelId)] = { mode, source };
		writeFileSync(storePath(), JSON.stringify(store, null, 2));
	} catch {
		// best effort
	}
}

/** Empty arguments only indicate failure for a tool that requires arguments. */
export function looksLikeBrokenNativeTools(
	toolCalls: { name: string; arguments: Record<string, unknown> }[],
	tools?: Tool[],
): boolean {
	if (toolCalls.length === 0) return false;
	if (toolCalls.some((tc) => !tc.name)) return true;
	return toolCalls.every((tc) => {
		if (Object.keys(tc.arguments ?? {}).length > 0) return false;
		const tool = tools?.find((t) => t.name === tc.name);
		// Without a schema, {} may be a valid no-argument tool call.
		return (tool?.parameters.required?.length ?? 0) > 0;
	});
}

/** One nudge, phrased for a model that just fumbled native tool calls. */
export const FALLBACK_NUDGE =
	'Your last tool call did not come through with usable arguments. From now on, use the tool block format exactly like this:\n\n<tool name="bash">\n{"command": "ls -la"}\n</tool>\n\nWrite the complete JSON object inside the block, then stop and wait for the result.';
