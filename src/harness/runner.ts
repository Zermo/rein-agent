/**
 * The harness runner: model + tools + agent loop + the tool-capability
 * compatibility layer, wired together. Shared by REPL, print, improve, and
 * experiment-loop modes.
 */
import { agentLoop } from "../agent/agent-loop.ts";
import type { AgentContext, AgentMessage, AgentTool, AgentEvent } from "../agent/agent-loop.ts";
import { stream as openaiStream, TEXT_TOOL_INSTRUCTIONS } from "../ai/openai-completions.ts";
import { streamCli } from "../ai/cli-provider.ts";
import { decideToolMode, looksLikeBrokenNativeTools, recordDecision } from "../ai/compat.ts";
import type { ToolMode } from "../ai/compat.ts";
import { apiKeyFor, loadConfig, resolveModel } from "../ai/models.ts";
import type { AssistantMessage, Model } from "../ai/types.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { toolsForCwd } from "./tools/index.ts";
import * as nodeterm from "./nodeterm.ts";
import { Posthorse, POSTHORSE_GUIDANCE } from "./posthorse.ts";
import { contextTools } from "./tools/context.ts";

export interface RunnerOptions {
	cwd: string;
	contextWindow?: number;
	reserveTokens?: number;
	autoContext?: boolean;
	sessionId?: string;
	modelOverride?: string;
	baseUrlOverride?: string;
	providerOverride?: string;
	sshHostOverride?: string;
	toolsMode?: ToolMode;
	maxTurns?: number;
	temperature?: number;
	/** Replace the default system prompt (improve/loop modes). */
	systemPrompt?: string;
	/** Replace the default toolset. */
	tools?: AgentTool[];
	/** Tool names that require approval before execution (e.g. ["bash", "write"]). */
	askTools?: string[];
	/** Host policy checked before every tool, independently of interactive approvals. */
	toolGuard?: (name: string, args: Record<string, unknown>) => string | undefined | Promise<string | undefined>;
	/** What happens when an approval times out with no canvas/phone answer, outside nodeterm.
	 *  Default: deny. The REPL passes a stdin y/n prompt. */
	askFallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
}

export interface Runner {
	model: Model;
	apiKey?: string;
	toolsMode: "native" | "text";
	toolsModeSource: string;
	systemPrompt: string;
	tools: AgentTool[];
	/** Live set — /ask in the REPL mutates it at runtime. */
	askTools: string[];
	/** Approval fallback (timeout, or outside nodeterm). REPL sets this to a stdin prompt. */
	askFallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
	context: AgentContext;
	readonly sessionId?: string;
	setSession(id: string): void;
	contextStatus(): string;
	newContext(handoff?: string): void;
	/** Queue a message to be injected after the current tool batch. */
	steer(message: AgentMessage): void;
	/** One prompt through the loop; returns all new messages. */
	run(prompt: AgentMessage, opts?: { signal?: AbortSignal; onEvent?: (event: AgentEvent) => void | Promise<void> }): Promise<AgentMessage[]>;
}

export async function createRunner(opts: RunnerOptions): Promise<Runner> {
	const model = await resolveModel({
		model: opts.modelOverride,
		baseUrl: opts.baseUrlOverride,
		provider: opts.providerOverride,
		sshHost: opts.sshHostOverride,
	});
	if (opts.contextWindow !== undefined) model.contextWindow = opts.contextWindow;
	const apiKey = apiKeyFor(model.provider, model.baseUrl, model.sshHost);
	const config = loadConfig();
	const reserveTokens = opts.reserveTokens ?? config.posthorse?.reserveTokens;
	// Small local windows need a smaller implicit output budget. Explicit
	// maxTokens remains authoritative and is validated by Posthorse below.
	if (config.maxTokens === undefined) {
		model.maxTokens = Math.min(model.maxTokens, Math.max(1, Math.floor(model.contextWindow / 4)));
		if (Number.isSafeInteger(reserveTokens) && reserveTokens! > 0) model.maxTokens = Math.min(model.maxTokens, reserveTokens!);
	}
	const forcedMode = opts.toolsMode ?? config.toolsMode ?? "auto";
	const cliProvider = model.baseUrl.startsWith("cli://");
	const decision = cliProvider ? { mode: "text" as const, source: "official CLI" } : decideToolMode(model.provider, model.id, forcedMode);

	const withContextTools = opts.tools === undefined;
	const autoContext = opts.autoContext ?? (withContextTools && config.posthorse?.enabled !== false);
	const contextGuidance = autoContext ? POSTHORSE_GUIDANCE : POSTHORSE_GUIDANCE.replace("Automatic rollover starts a fresh window without generating a summary.", "Automatic rollover is disabled. Use new_context to start a fresh window without generating a summary.");
	const basePrompt = (opts.systemPrompt ?? buildSystemPrompt(opts.cwd)) + (withContextTools ? contextGuidance : "");
	const tools = [...(opts.tools ?? toolsForCwd(opts.cwd))];
	let systemPrompt = decision.mode === "text" ? basePrompt + TEXT_TOOL_INSTRUCTIONS : basePrompt;

	const steering: AgentMessage[] = [];
	const posthorse = new Posthorse({ model, enabled: autoContext, reserveTokens, prompt: () => systemPrompt, tools: () => tools, cwd: opts.cwd });
	if (withContextTools) tools.push(...contextTools(posthorse, opts.cwd));
	const context: AgentContext = { systemPrompt, messages: posthorse.messages, tools };
	let running = false;
	const askTools = [...(opts.askTools ?? [])];

	/** Human summary of a tool call for approval prompts. */
	const summarizeArgs = (args: Record<string, unknown>): string => {
		const s = JSON.stringify(args);
		return s.length > 100 ? s.slice(0, 100) + "…" : s;
	};

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
		askTools,
		context,
		askFallback: opts.askFallback,
		get sessionId() { return posthorse.sessionId; },
		setSession(id) {
			if (running) throw new Error("Cannot switch sessions during an active run");
			posthorse.setSession(id);
			context.messages = posthorse.messages;
			steering.length = 0;
		},
		contextStatus() { return posthorse.status(); },
		newContext(handoff) {
			if (running) throw new Error("Cannot manually reset context during an active run");
			posthorse.rollover(handoff);
		},

		steer(message) {
			steering.push(message);
		},

		run: async (prompt, runOpts) => {
			if (running) throw new Error("Runner already active; use steer() for mid-run input");
			running = true;
			try { return await agentLoop(
				[prompt],
				runner.context,
				{
					model,
					transformContext: async (messages) => posthorse.prepare(messages),
					afterToolBatch: (info) => posthorse.afterBatch(info),
					recoverFromError: ({ message, context: loopContext }) => posthorse.recover(message, loopContext.messages),
					streamFn: (m, ctx, o) => cliProvider ? streamCli(m, ctx, o) : openaiStream(m, ctx, { ...o, apiKey, temperature: opts.temperature ?? config.temperature, maxTokens: model.maxTokens, toolsMode: runner.toolsMode }),
					maxTurns: opts.maxTurns ?? 60,
					getSteeringMessages: () => steering.splice(0, steering.length),
					beforeToolCall: async (info) => {
						const denied = await opts.toolGuard?.(info.toolCall.name, (info.args ?? {}) as Record<string, unknown>);
						if (denied) return { block: true, reason: denied };
						if (!askTools.includes(info.toolCall.name)) return undefined;
						const name = info.toolCall.name;
						const args = (info.args ?? {}) as Record<string, unknown>;
						if (nodeterm.active()) {
							nodeterm.setTitle(`rein · needs you: ${name}`);
							const verdict = await nodeterm.requestApproval(name, args);
							if (verdict === "allow") return undefined;
							if (verdict === "deny") return { block: true, reason: `Denied: ${name} ${summarizeArgs(args)} (canvas/phone said no)` };
							console.error(`\n[approval] ${name}: no answer in time — ${runner.askFallback ? "requesting local approval" : "denying execution"}\n`);
						}
						// Outside nodeterm (or on timeout there): the harness's own fallback
						const ok = (await runner.askFallback?.(name, args)) ?? false;
						return ok ? undefined : { block: true, reason: `Denied: ${name} ${summarizeArgs(args)}` };
					},
				},
				runOpts?.signal,
				async (event) => {
					if (event.type === "message_end") posthorse.record(event.message);
					// nodeterm status + title (no-ops outside a nodeterm node / non-TTY)
					switch (event.type) {
						case "agent_start":
						nodeterm.status.turnStart(String((prompt as { content?: unknown }).content ?? ""));
						nodeterm.setTitle("rein · working");
						break;
						case "tool_execution_start":
						nodeterm.status.toolStart(event.toolName, (event.args as Record<string, unknown>) ?? {});
						nodeterm.setTitle(`rein · ${event.toolName}`);
						break;
						case "tool_execution_end":
						nodeterm.status.toolEnd(event.toolName);
						// Make a completed tool's filesystem changes visible to a
						// concurrently resumed archived session before this run ends.
						posthorse.captureWorkspace();
						break;
						case "agent_end":
						nodeterm.status.done();
						nodeterm.setTitle("rein · idle");
						break;
					}
					if (event.type === "turn_end" && forcedMode === "auto") {
						await maybeFallBackToTextMode(runner, (event as { message: AssistantMessage }).message);
					}
					await runOpts?.onEvent?.(event);
				},
			); } finally { posthorse.captureWorkspace(); running = false; }
		},
	};

	if (opts.sessionId) runner.setSession(opts.sessionId);
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
	if (!looksLikeBrokenNativeTools(toolCalls, runner.tools)) return;

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
