/**
 * The harness runner: model + tools + agent loop + the tool-capability
 * compatibility layer, wired together. Shared by REPL, print, improve, and
 * experiment-loop modes.
 */
import { agentLoop } from "../agent/agent-loop.ts";
import type { AgentContext, AgentMessage, AgentTool } from "../agent/agent-loop.ts";
import { stream as openaiStream, TEXT_TOOL_INSTRUCTIONS } from "../ai/openai-completions.ts";
import { decideToolMode, looksLikeBrokenNativeTools, recordDecision } from "../ai/compat.ts";
import type { ToolMode } from "../ai/compat.ts";
import { apiKeyFor, loadConfig, resolveModel } from "../ai/models.ts";
import type { AssistantMessage, Model } from "../ai/types.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { TOOLS } from "./tools/index.ts";

export interface RunnerOptions {
	cwd: string;
	modelOverride?: string;
	baseUrlOverride?: string;
	providerOverride?: string;
	toolsMode?: ToolMode;
	maxTurns?: number;
	temperature?: number;
	/** Replace the default system prompt (improve/loop modes). */
	systemPrompt?: string;
	/** Replace the default toolset. */
	tools?: AgentTool[];
}

export interface Runner {
	model: Model;
	apiKey?: string;
	toolsMode: "native" | "text";
	toolsModeSource: string;
	systemPrompt: string;
	tools: AgentTool[];
	context: AgentContext;
	/** Queue a message to be injected after the current tool batch. */
	steer(message: AgentMessage): void;
	/** One prompt through the loop; returns all new messages. */
	run(prompt: AgentMessage, opts?: { signal?: AbortSignal }): Promise<AgentMessage[]>;
}

export async function createRunner(opts: RunnerOptions): Promise<Runner> {
	const model = await resolveModel({
		model: opts.modelOverride,
		baseUrl: opts.baseUrlOverride,
		provider: opts.providerOverride,
	});
	const apiKey = apiKeyFor(opts.providerOverride ?? (opts.baseUrlOverride ? undefined : model.provider));
	const config = loadConfig();
	const forcedMode = opts.toolsMode ?? config.toolsMode ?? "auto";
	const decision = decideToolMode(model.provider, model.id, forcedMode);

	const basePrompt = opts.systemPrompt ?? buildSystemPrompt(opts.cwd);
	const tools = opts.tools ?? TOOLS;
	let systemPrompt = decision.mode === "text" ? basePrompt + TEXT_TOOL_INSTRUCTIONS : basePrompt;

	const steering: AgentMessage[] = [];
	const context: AgentContext = { systemPrompt, messages: [], tools };

	const runner: Runner = {
		model,
		apiKey,
		toolsMode: decision.mode,
		toolsModeSource: decision.source,
		get systemPrompt() {
			return systemPrompt;
		},
		set systemPrompt(v: string) {
			systemPrompt = v;
			context.systemPrompt = v;
		},
		tools,
		context,

		steer(message) {
			steering.push(message);
		},

		run: (prompt, runOpts) =>
			agentLoop(
				[prompt],
				runner.context,
				{
					model,
					streamFn: (m, ctx, o) => openaiStream(m, ctx, { ...o, apiKey, temperature: opts.temperature ?? config.temperature, maxTokens: config.maxTokens, toolsMode: runner.toolsMode }),
					maxTurns: opts.maxTurns ?? 60,
					getSteeringMessages: () => steering.splice(0, steering.length),
				},
				runOpts?.signal,
				async (event) => {
					if (event.type !== "turn_end") return;
					await maybeFallBackToTextMode(runner, (event as { message: AssistantMessage }).message);
				},
			).then((newMessages) => {
				// Accumulate the conversation so the next prompt has memory.
				context.messages.push(...newMessages);
				return newMessages;
			}),
	};

	return runner;
}

/**
 * Runtime half of the compatibility layer: a toolUse turn whose calls all
 * came back with empty/unfilled arguments means the model can't do native
 * tool calling. Flip to the text protocol, remember the decision. The model
 * gets the corrective instructions in its (already failing) tool results plus
 * the updated system prompt on the next turn.
 */
async function maybeFallBackToTextMode(runner: Runner, message: AssistantMessage): Promise<void> {
	if (runner.toolsMode === "text") return;
	const toolCalls = message.content.filter((c) => c.type === "toolCall") as { name: string; arguments: Record<string, unknown> }[];
	if (message.stopReason !== "toolUse" || toolCalls.length === 0) return;
	if (!looksLikeBrokenNativeTools(toolCalls)) return;

	runner.toolsMode = "text";
	runner.toolsModeSource = "runtime";
	if (!runner.systemPrompt.includes("<tool name=")) {
		runner.systemPrompt = runner.systemPrompt + TEXT_TOOL_INSTRUCTIONS;
	}
	recordDecision(runner.model.provider, runner.model.id, "text", "runtime");
	console.error(
		`\n[compat] ${runner.model.id} didn't produce usable tool arguments — using the text tool protocol from here on. This choice is remembered for next time.\n`,
	);
}
