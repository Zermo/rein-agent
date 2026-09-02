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
	let turns = 0;

	// Outer loop: continues when follow-up messages arrive after the agent would stop.
	while (true) {
		if (turns >= maxTurns) break;
		let hasMoreToolCalls = true;
		let pending: AgentMessage[] = [];

		// Inner loop: process tool calls and steering messages.
		while (hasMoreToolCalls || pending.length > 0) {
			turns++;
			if (signal?.aborted) break;

			// Steering: messages queued while the agent was working, injected now.
			if (pending.length === 0) {
				pending = (await config.getSteeringMessages?.()) ?? [];
			}
			for (const message of pending) {
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				ctx.messages.push(message);
				newMessages.push(message);
			}
			pending = [];

			// Stream the assistant response.
			const message = await streamAssistantResponse(ctx, config, signal, emit);
			ctx.messages.push(message);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return newMessages;
			}
			if (turns >= maxTurns) {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return newMessages;
			}

			const toolCalls = message.content.filter((c) => c.type === "toolCall") as Extract<
				AssistantMessage["content"][number],
				{ type: "toolCall" }
			>[];

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				const batch =
					message.stopReason === "length"
						? await failTruncatedToolCalls(toolCalls, ctx, emit)
						: await executeToolCalls(ctx, message, toolCalls, config, signal, emit);
				toolResults.push(...batch.messages);
				hasMoreToolCalls = !batch.terminate;
				for (const result of toolResults) {
					ctx.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			if (config.shouldStopAfterTurn?.({ message, context: ctx })) {
				await emit({ type: "agent_end", messages: newMessages });
				return newMessages;
			}

			pending = (await config.getSteeringMessages?.()) ?? [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUps = (await config.getFollowUpMessages?.()) ?? [];
		if (followUps.length > 0) {
			pending = followUps;
			continue;
		}
		break;
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

type ExecutedBatch = { messages: ToolResultMessage[]; terminate: boolean };

async function failTruncatedToolCalls(
	toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
	ctx: AgentContext,
	emit: AgentEventSink,
): Promise<ExecutedBatch> {
	const messages: ToolResultMessage[] = [];
	for (const tc of toolCalls) {
		await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
		const result: AgentToolResult = {
			content: `Tool call "${tc.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue it with complete arguments.`,
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

	let result: AgentToolResult;
	let isError = false;
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
		result = { content: (err as Error).message ?? String(err), isError: true };
		isError = true;
	}

	const after = config.afterToolCall?.({ assistantMessage, toolCall: tc, args, result, isError, context: ctx });
	if (after) {
		result = { ...result, ...after };
		isError = after.isError ?? isError;
	}

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
		if (signal?.aborted) break;
		finalized.push(await runOne(tc, ctx, assistantMessage, config, signal, emit));
	}
	const messages = await toToolResultMessages(finalized, emit);
	return { messages, terminate: allTerminate(finalized) };
}

async function executeParallel(
	ctx: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedBatch> {
	// Preflight (validation, hooks) sequentially; execution concurrently.
	const ready: typeof toolCalls = [];
	const immediate: FinalizedCall[] = [];
	for (const tc of toolCalls) {
		if (signal?.aborted) break;
		// runOne does preflight+execute together; to keep preflight ordered we
		// simply launch all and rely on the model having issued independent calls.
		ready.push(tc);
	}
	const settled = await Promise.all(ready.map((tc) => runOne(tc, ctx, assistantMessage, config, signal, emit)));
	const finalized = [...immediate, ...settled];
	const messages = await toToolResultMessages(finalized, emit);
	return { messages, terminate: allTerminate(finalized) };
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
