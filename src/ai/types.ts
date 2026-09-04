/**
 * rein/ai — the translation layer.
 *
 * One message model and one streaming protocol for every provider.
 * Adapters (openai-completions today) translate between that and wire formats.
 *
 * Design notes (from pi-mono's packages/ai):
 * - Messages are plain data, provider-agnostic. Assistant messages are block
 *   arrays: text | thinking | toolCall. Tool results are their own message role.
 * - Streaming is an event protocol (start / *_start / *_delta / *_end / done /
 *   error) over an async iterable, plus a final-result promise. Errors are
 *   encoded in the stream, never thrown at the caller.
 */

import type { AssistantMessageEventStream } from "./event-stream.ts";

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type AssistantContent = TextContent | ThinkingContent | ToolCall;

export interface Usage {
	input: number;
	output: number;
	totalTokens: number;
	/** Tokens the server reported for reasoning, if any. Subset of output. */
	reasoning?: number;
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string;
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: TextContent[];
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** Minimal JSON Schema shape for tool parameters. */
export interface JsonSchema {
	type: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	minimum?: number;
	maximum?: number;
	description?: string;
}

export interface Tool {
	name: string;
	description: string;
	parameters: JsonSchema;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

export interface Model {
	id: string;
	provider: string;
	/** Root of the OpenAI-compatible API, e.g. http://localhost:11434/v1 */
	baseUrl: string;
	/** Optional SSH config alias used to reach this HTTP endpoint from the remote host. */
	sshHost?: string;
	contextWindow: number;
	maxTokens: number;
}

export interface StreamOptions {
	apiKey?: string;
	signal?: AbortSignal;
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	/** Extra body fields merged in as-is (e.g. top_k for llama.cpp). */
	extra?: Record<string, unknown>;
	headers?: Record<string, string>;
	/** Whether the server reports usage in streamed responses. Default: try. */
	includeUsage?: boolean;
	/** Per-request timeout in ms (connect + idle). Default: no timeout. */
	timeoutMs?: number;
}

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
	| { type: "error"; reason: "error" | "aborted"; error: AssistantMessage };

export type StreamFn = (
	model: Model,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
