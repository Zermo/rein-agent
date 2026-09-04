/**
 * rein/agent — the agentic loop.
 *
 * The loop owns the conversation state and drives:
 *   stream assistant → execute tool calls (parallel by default) → repeat
 *
 * with the same control points pi proved useful:
 *   - steering messages: injected after the current tool batch (user interrupts)
 *   - follow-up messages: processed when the agent would otherwise stop
 *   - before/afterToolCall hooks, shouldStopAfterTurn
 *   - truncation safety: a response that hit the output limit may carry
 *     half-written tool arguments, so those calls are failed, not executed
 *   - tools can request early termination (result.terminate)
 */
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	StreamFn,
	StreamOptions,
	Tool,
	ToolResultMessage,
} from "../ai/types.ts";
import { validateArgs } from "../util/schema.ts";

export type AgentMessage = Message;

export interface AgentTool {
	name: string;
	description: string;
	parameters: Tool["parameters"];
	execute: (
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: string) => void,
	) => Promise<AgentToolResult>;
	/** Per-tool override: "sequential" tools force the whole batch to run one at a time. */
	executionMode?: "parallel" | "sequential";
}

export interface AgentToolResult {
	/** Text returned to the model. */
	content: string;
	isError?: boolean;
	/** Structured data for the UI (e.g. {exitCode, truncated}). */
	details?: unknown;
	/** When every tool result in a batch sets this, the loop stops after the batch. */
	terminate?: boolean;
	/** Request a fresh context after the complete tool batch succeeds. */
	newContext?: { handoff?: string };
}

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; event: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; partial: string }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult; isError: boolean };

export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools: AgentTool[];
}

export interface BeforeToolCallInfo {
	assistantMessage: AssistantMessage;
	toolCall: { id: string; name: string; arguments: Record<string, unknown> };
	args: Record<string, unknown>;
	context: AgentContext;
}

export interface AfterToolCallInfo extends BeforeToolCallInfo {
	result: AgentToolResult;
	isError: boolean;
}

export interface AgentLoopConfig {
	model: Model;
	streamFn: StreamFn;
	streamOptions?: StreamOptions;
	/** Convert AgentMessage[] → provider Message[] at the LLM boundary. Default: identity. */
	convertToLlm?: (messages: AgentMessage[]) => Message[];
	/** Transform context before the LLM call (compaction lives here). */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	/** May be async (e.g. an approval prompt that waits on a phone). */
	beforeToolCall?: (info: BeforeToolCallInfo) => { block?: boolean; reason?: string } | undefined | Promise<{ block?: boolean; reason?: string } | undefined>;
	afterToolCall?: (info: AfterToolCallInfo) => Partial<AgentToolResult> | undefined;
	/** Called after every tool result is recorded; rollover is allowed only for one successful request. */
	afterToolBatch?: (info: { message: AssistantMessage; toolResults: ToolResultMessage[]; context: AgentContext; newContext?: { handoff?: string } }) => void | Promise<void>;
	/** Return true to retry a failed model turn after repairing its context. Retries count toward maxTurns. */
	recoverFromError?: (info: { message: AssistantMessage; context: AgentContext }) => boolean | Promise<boolean>;
	shouldStopAfterTurn?: (info: { message: AssistantMessage; context: AgentContext }) => boolean;
	getSteeringMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
	getFollowUpMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
	toolExecution?: "parallel" | "sequential";
	/** Hard safety cap on assistant turns per run. Default: 60. */
	maxTurns?: number;
}

type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages; // AgentMessage is Message here; custom apps can extend
}

/**
 * Run the agent loop for a new prompt.
 * Returns the new messages (prompt + everything the loop produced).
 * Emits the full event protocol to `emit`. Never throws for model/tool
 * failures — they are encoded in events and the returned messages.
 */
export async function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	// systemPrompt is a live getter on the caller's context object, so a
	// mid-loop change (e.g. the tool-protocol fallback) is visible next turn.
	const ctx: AgentContext = {
		get systemPrompt() {
			return context.systemPrompt;
		},
		messages: [...context.messages, ...prompts],
		tools: context.tools,
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	const maxTurns = config.maxTurns ?? 60;
	let pending: AgentMessage[] = [];
	for (let turns = 0; turns < maxTurns && !signal?.aborted; turns++) {
		if (turns > 0) await emit({ type: "turn_start" });
		pending.push(...((await config.getSteeringMessages?.()) ?? []));
		if (signal?.aborted) break;
		for (const message of pending) {
			await emit({ type: "message_start", message });
			await emit({ type: "message_end", message });
			ctx.messages.push(message);
			newMessages.push(message);
		}
		pending = [];

		let message: AssistantMessage;
		let assistantStarted = false;
		try {
			message = await streamAssistantResponse(ctx, config, signal, (event) => {
				if (event.type === "message_start") assistantStarted = true;
				return emit(event);
			});
		} catch (error) {
			message = {
				role: "assistant", content: [], provider: config.model.provider, model: config.model.id,
				usage: { input: 0, output: 0, totalTokens: 0 }, timestamp: Date.now(),
				stopReason: signal?.aborted ? "aborted" : "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			};
			if (!assistantStarted) await emit({ type: "message_start", message });
			await emit({ type: "message_end", message });
		}
		ctx.messages.push(message);
		newMessages.push(message);

		const toolCalls = message.content.filter((c) => c.type === "toolCall");
		const failed = message.stopReason === "error" || message.stopReason === "aborted";
		let batch: ExecutedBatch = { messages: [], terminate: false };
		if (toolCalls.length > 0) {
			batch = failed
				? await failTruncatedToolCalls(toolCalls, ctx, emit, "the model response failed or was aborted")
				: message.stopReason === "length"
					? await failTruncatedToolCalls(toolCalls, ctx, emit)
					: await executeToolCalls(ctx, message, toolCalls, config, signal, emit);
			ctx.messages.push(...batch.messages);
			newMessages.push(...batch.messages);
			await config.afterToolBatch?.({
				message, toolResults: batch.messages, context: ctx,
				newContext: !signal?.aborted ? batch.newContext : undefined,
			});
		}
		await emit({ type: "turn_end", message, toolResults: batch.messages });
		if (signal?.aborted || turns + 1 >= maxTurns || message.stopReason === "aborted") break;
		if (failed) {
			if (await config.recoverFromError?.({ message, context: ctx })) continue;
			break;
		}
		if (config.shouldStopAfterTurn?.({ message, context: ctx })) break;
		pending = (await config.getSteeringMessages?.()) ?? [];
		if (pending.length > 0 || (toolCalls.length > 0 && !batch.terminate)) continue;
		pending = (await config.getFollowUpMessages?.()) ?? [];
		if (pending.length === 0) break;
	}

	await emit({ type: "agent_end", messages: newMessages });
	return newMessages;
}

async function streamAssistantResponse(
	ctx: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<AssistantMessage> {
	let messages = ctx.messages;
	if (config.transformContext) messages = (await config.transformContext(messages, signal)) ?? messages;

	const llmMessages = (config.convertToLlm ?? defaultConvertToLlm)(messages);
	const llmContext: Context = {
		systemPrompt: ctx.systemPrompt,
		messages: llmMessages,
		tools: ctx.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
	};

	const response = await config.streamFn(config.model, llmContext, {
		...config.streamOptions,
		signal,
	});

	for await (const event of response) {
		switch (event.type) {
			case "start":
				await emit({ type: "message_start", message: { ...event.partial } });
				break;
			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_end":
				await emit({ type: "message_update", message: { ...event.partial }, event });
				break;
			case "done":
			case "error": {
				const final = await response.result();
				await emit({ type: "message_end", message: final });
				return final;
			}
		}
	}
	const final = await response.result();
	await emit({ type: "message_end", message: final });
	return final;
}

type ExecutedBatch = { messages: ToolResultMessage[]; terminate: boolean; newContext?: { handoff?: string } };

async function failTruncatedToolCalls(
	toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
	ctx: AgentContext,
	emit: AgentEventSink,
	reason = "the response hit the output token limit, so its arguments may be truncated",
): Promise<ExecutedBatch> {
	const messages: ToolResultMessage[] = [];
	for (const tc of toolCalls) {
		await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
		const result: AgentToolResult = {
			content: `Tool call "${tc.name}" was not executed: ${reason}. Re-issue it with complete arguments.`,
			isError: true,
		};
		await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError: true });
		const msg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: tc.id,
			toolName: tc.name,
			content: [{ type: "text", text: result.content }],
			isError: true,
			timestamp: Date.now(),
		};
		await emit({ type: "message_start", message: msg });
		await emit({ type: "message_end", message: msg });
		messages.push(msg);
	}
	return { messages, terminate: false };
}

async function executeToolCalls(
	ctx: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedBatch> {
	const hasSequential = toolCalls.some((tc) => ctx.tools.find((t) => t.name === tc.name)?.executionMode === "sequential");
	if (config.toolExecution === "sequential" || hasSequential) {
		return executeSequential(ctx, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeParallel(ctx, assistantMessage, toolCalls, config, signal, emit);
}

interface FinalizedCall {
	toolCallId: string;
	toolName: string;
	result: AgentToolResult;
	isError: boolean;
}

async function runOne(
	tc: { id: string; name: string; arguments: Record<string, unknown> },
	ctx: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<FinalizedCall> {
	await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });

	const tool = ctx.tools.find((t) => t.name === tc.name);
	if (!tool) {
		const result: AgentToolResult = { content: `Tool "${tc.name}" not found. Available: ${ctx.tools.map((t) => t.name).join(", ")}`, isError: true };
		await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError: true });
		return { toolCallId: tc.id, toolName: tc.name, result, isError: true };
	}

	let args = tc.arguments ?? {};
	try {
		args = validateArgs(tool.parameters, args) as Record<string, unknown>;
	} catch (err) {
		const result: AgentToolResult = { content: `Invalid arguments for "${tc.name}": ${(err as Error).message}`, isError: true };
		await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError: true });
		return { toolCallId: tc.id, toolName: tc.name, result, isError: true };
	}

	let result: AgentToolResult;
	try {
		if (signal?.aborted) throw new Error("Operation aborted");
		const before = await config.beforeToolCall?.({ assistantMessage, toolCall: tc, args, context: ctx });
		if (before?.block) {
			const result: AgentToolResult = { content: before.reason ?? "Tool execution was blocked", isError: true };
			await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError: true });
			return { toolCallId: tc.id, toolName: tc.name, result, isError: true };
		}
		if (signal?.aborted) {
			const result: AgentToolResult = { content: "Operation aborted", isError: true };
			await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError: true });
			return { toolCallId: tc.id, toolName: tc.name, result, isError: true };
		}

		try {
			result = await tool.execute(
				tc.id,
				args,
				signal,
				(partial) => {
					void emit({ type: "tool_execution_update", toolCallId: tc.id, toolName: tc.name, partial });
				},
			);
		} catch (err) {
			result = { content: err instanceof Error ? err.message : String(err), isError: true };
		}
		const after = config.afterToolCall?.({ assistantMessage, toolCall: tc, args, result, isError: result.isError === true, context: ctx });
		if (after) result = { ...result, ...after };
	} catch (err) {
		result = { content: err instanceof Error ? err.message : String(err), isError: true };
	}
	const isError = result.isError === true;

	await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError });
	return { toolCallId: tc.id, toolName: tc.name, result, isError };
}

async function executeSequential(
	ctx: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedBatch> {
	const finalized: FinalizedCall[] = [];
	for (const tc of toolCalls) {
		finalized.push(await runOne(tc, ctx, assistantMessage, config, signal, emit));
	}
	const messages = await toToolResultMessages(finalized, emit);
	return finalizeBatch(messages, finalized, signal);
}

async function executeParallel(
	ctx: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedBatch> {
	// Every declared call receives a result, including calls skipped by an abort.
	const finalized = await Promise.all(toolCalls.map((tc) => runOne(tc, ctx, assistantMessage, config, signal, emit)));
	const messages = await toToolResultMessages(finalized, emit);
	return finalizeBatch(messages, finalized, signal);
}

async function toToolResultMessages(finalized: FinalizedCall[], emit: AgentEventSink): Promise<ToolResultMessage[]> {
	const messages: ToolResultMessage[] = [];
	for (const call of finalized) {
		const msg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			content: [{ type: "text", text: call.result.content }],
			isError: call.isError,
			timestamp: Date.now(),
		};
		await emit({ type: "message_start", message: msg });
		await emit({ type: "message_end", message: msg });
		messages.push(msg);
	}
	return messages;
}

function allTerminate(finalized: FinalizedCall[]): boolean {
	return finalized.length > 0 && finalized.every((f) => f.result.terminate === true);
}

function finalizeBatch(messages: ToolResultMessage[], finalized: FinalizedCall[], signal?: AbortSignal): ExecutedBatch {
	const requests = finalized.filter((call) => call.result.newContext !== undefined);
	return {
		messages,
		terminate: allTerminate(finalized),
		newContext: !signal?.aborted && finalized.every((call) => !call.isError) && requests.length === 1
			? requests[0].result.newContext : undefined,
	};
}
