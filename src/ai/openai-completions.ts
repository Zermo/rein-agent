/**
 * openai-completions — the default adapter.
 *
 * One adapter covers every OpenAI-compatible server: Ollama, LM Studio, vLLM,
 * llama.cpp, LiteLLM, text-generation-websocket, ... This is the translation
 * layer for local AI, and it deliberately handles the rough edges small local
 * models bring:
 *
 *  - malformed tool-call JSON (salvage parser, see util/json-salvage.ts)
 *  - missing finish_reason (some servers omit it; infer stop vs toolUse)
 *  - missing usage in streams (estimate from content when absent)
 *  - `stream_options` rejected by older servers (only send when likely OK)
 *  - models with no tool support at all: text tool-call mode, where the model
 *    writes <tool name="...">{"arg": "..."}</tool> blocks in plain text
 */

import { AssistantMessageEventStream } from "./event-stream.ts";
import { sseDataLines } from "./sse.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	StreamOptions,
	Tool,
	ToolCall,
	Usage,
} from "./types.ts";
import { parseArgsSalvaged } from "../util/json-salvage.ts";
import { withSshTunnel } from "./ssh.ts";
import { postChatCompletion } from "./chat-request.ts";

type OpenAIMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | null;
	tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
};

interface StreamingToolCall {
	id: string;
	name: string;
	args: string;
}

function toOpenAIMessage(message: Message, toolsMode: "native" | "text"): OpenAIMessage | OpenAIMessage[] {
	switch (message.role) {
		case "user":
			return { role: "user", content: message.content };
		case "assistant": {
			const text = message.content
				.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join("");
			const calls = message.content.filter((c) => c.type === "toolCall") as ToolCall[];
			const out: OpenAIMessage = { role: "assistant", content: text.length > 0 ? text : null };
			if (calls.length > 0 && toolsMode === "text") {
				out.content = [text, ...calls.map((c) => `<tool name="${c.name}">\n${JSON.stringify(c.arguments ?? {})}\n</tool>`)].filter(Boolean).join("\n\n");
			} else if (calls.length > 0) {
				out.tool_calls = calls.map((c) => ({
					id: c.id,
					type: "function" as const,
					function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
				}));
			}
			return out;
		}
		case "toolResult":
			if (toolsMode === "text") return {
				role: "user",
				content: `Result of tool ${message.toolName} (${message.toolCallId}):\n${message.content.map((c) => c.text).join("\n")}`,
			};
			return {
				role: "tool",
				tool_call_id: message.toolCallId,
				content: message.content.map((c) => c.text).join("\n"),
			};
	}
}

export const TEXT_TOOL_INSTRUCTIONS = `
To use a tool, write a tool block exactly like this (one block per tool, valid JSON inside):

<tool name="bash">
{"command": "ls -la"}
</tool>

Rules for tool blocks:
- The JSON inside must be a single complete JSON object.
- Put each tool block on its own lines. No markdown fences around them.
- After writing tool blocks, wait for the results before continuing.
`;

const TOOL_BLOCK_RE = /<tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool>/g;

/** Parse <tool> blocks out of text (text tool-call mode). */
export function parseTextToolCalls(text: string): { toolCalls: ToolCall[]; cleanText: string } {
	const toolCalls: ToolCall[] = [];
	const cleanText = text.replace(TOOL_BLOCK_RE, (block, name: string, rawArgs: string) => {
		const args = parseArgsSalvaged(rawArgs.trim());
		// The salvage parser returns {} for failure and valid empty objects.
		// Accept the latter for tools with no required parameters (e.g. rollover).
		if (Object.keys(args).length === 0 && !/^\s*\{\s*\}\s*$/.test(rawArgs)) return block;
		toolCalls.push({ type: "toolCall", id: `call_${Date.now()}_${toolCalls.length}`, name, arguments: args });
		return "";
	});
	return { toolCalls, cleanText: toolCalls.length > 0 ? cleanText.replace(/\n{3,}/g, "\n\n").trim() : text };
}

/**
 * Stream a chat completion from an OpenAI-compatible server.
 * Never throws: failures are encoded as an `error` event on the returned stream.
 */
export function stream(
	model: Model,
	context: Context,
	options: StreamOptions & { toolsMode?: "native" | "text" } = {},
): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	if (model.sshHost) {
		void (async () => {
			try {
				let final: AssistantMessageEvent | undefined;
				await withSshTunnel(model.baseUrl, model.sshHost, async baseUrl => {
					for await (const event of stream({ ...model, baseUrl, sshHost: undefined }, context, options)) {
						if (event.type === "done" || event.type === "error") final = event;
						else out.push(event);
					}
				}, { signal: options.signal, timeoutMs: options.timeoutMs });
				if (final) out.push(final);
			} catch (error) {
				const aborted = options.signal?.aborted || (error as Error).name === "AbortError";
				out.push({ type: "error", reason: aborted ? "aborted" : "error", error: {
					role: "assistant", content: [], provider: model.provider, model: model.id,
					usage: { input: 0, output: 0, totalTokens: 0 }, stopReason: aborted ? "aborted" : "error",
					errorMessage: (error as Error).message, timestamp: Date.now(),
				} });
			}
		})();
		return out;
	}

	void (async () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, totalTokens: 0 },
			stopReason: "pending",
			timestamp: Date.now(),
		};
		const emit = (event: AssistantMessageEvent) => out.push(event);

		try {
			const toolsMode = options.toolsMode ?? "native";
			const hasTools = (context.tools?.length ?? 0) > 0;

			const messages: OpenAIMessage[] = [];
			const systemParts: string[] = [];
			if (context.systemPrompt) systemParts.push(context.systemPrompt);
			if (toolsMode === "text" && hasTools) {
				systemParts.push(TEXT_TOOL_INSTRUCTIONS);
				systemParts.push("Available tools:\n" + context.tools!.map((t) => `${t.name}: ${t.description}\nParameters: ${JSON.stringify(t.parameters)}`).join("\n\n"));
			}
			if (systemParts.length > 0) messages.push({ role: "system", content: systemParts.join("\n\n") });
			for (const m of context.messages) {
				const converted = toOpenAIMessage(m, toolsMode);
				if (Array.isArray(converted)) messages.push(...converted);
				else messages.push(converted);
			}

			const body: Record<string, unknown> = {
				model: model.id,
				messages,
				stream: true,
			};
			if (typeof options.temperature === "number") body.temperature = options.temperature;
			if (typeof options.topP === "number") body.top_p = options.topP;
			if (typeof options.maxTokens === "number") body.max_tokens = options.maxTokens;
			else body.max_tokens = model.maxTokens || 4096;
			if (options.includeUsage !== false) body.stream_options = { include_usage: true };
			if (options.extra) Object.assign(body, options.extra);
			if (toolsMode === "native" && hasTools) {
				body.tools = (context.tools ?? []).map((t: Tool) => ({
					type: "function",
					function: { name: t.name, description: t.description, parameters: t.parameters },
				}));
			}

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				...options.headers,
			};
			if (options.apiKey) headers["Authorization"] = `Bearer ${options.apiKey}`;

			const response = await postChatCompletion(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, body, {
				headers, signal: options.signal, redirect: "error",
			});

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				message.stopReason = "error";
				const detail = options.apiKey ? text.split(options.apiKey).join("[redacted]") : text;
				message.errorMessage = `HTTP ${response.status} from ${model.baseUrl}: ${detail.slice(0, 800)}`;
				emit({ type: "error", reason: "error", error: message });
				return;
			}

			emit({ type: "start", partial: message });

			// Some servers (or their proxies) answer a stream:true request with a
			// single non-stream JSON object — legal under the OpenAI contract.
			// Normalize that shape (choice.message → choice.delta) so the one loop
			// below handles both; real SSE servers keep true token-by-token streaming.
			const ct = (response.headers.get("content-type") ?? "").toLowerCase();
			let dataLines: AsyncIterable<string>;
			if (ct.includes("json")) {
				const doc: any = JSON.parse(await response.text());
				if (doc?.choices?.[0]?.message) doc.choices[0].delta = doc.choices[0].message;
				dataLines = [JSON.stringify(doc)];
			} else {
				dataLines = sseDataLines(response.body);
			}

			// Streaming state
			let textBlock: { type: "text"; text: string } | null = null;
			let thinkingBlock: { type: "thinking"; thinking: string } | null = null;
			let contentIndex = -1;
			const nextIndex = () => ++contentIndex;
			const textToolCalls = new Map<number, StreamingToolCall>();
			let finishReason: string | null = null;

			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					message.content.push(textBlock);
					emit({ type: "text_start", contentIndex: nextIndex(), partial: message });
				}
				return textBlock;
			};
			const ensureThinkingBlock = () => {
				if (!thinkingBlock) {
					thinkingBlock = { type: "thinking", thinking: "" };
					message.content.push(thinkingBlock);
					emit({ type: "thinking_start", contentIndex: nextIndex(), partial: message });
				}
				return thinkingBlock;
			};

			for await (const data of dataLines) {
				let chunk: any;
				try {
					chunk = JSON.parse(data);
				} catch {
					continue; // some servers emit non-JSON keepalives
				}

				if (chunk.error) throw new Error(typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? JSON.stringify(chunk.error));

				if (chunk.usage) {
					const u: Usage = {
						input: chunk.usage.prompt_tokens ?? 0,
						output: chunk.usage.completion_tokens ?? 0,
						totalTokens: chunk.usage.total_tokens ?? 0,
					};
					if (typeof chunk.usage.completion_tokens_details?.reasoning_tokens === "number") {
						u.reasoning = chunk.usage.completion_tokens_details.reasoning_tokens;
					}
					message.usage = u;
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;
				if (choice.finish_reason) finishReason = choice.finish_reason;

				const delta = choice.delta ?? choice.message ?? {};
				if (typeof delta.content === "string" && delta.content.length > 0) {
					const block = ensureTextBlock();
					block.text += delta.content;
					emit({ type: "text_delta", contentIndex: message.content.indexOf(block), delta: delta.content, partial: message });
				}
				const reasoning =
					typeof delta.reasoning_content === "string"
						? delta.reasoning_content
						: typeof delta.reasoning === "string"
							? delta.reasoning
							: typeof delta.thinking === "string"
								? delta.thinking
								: "";
				if (reasoning) {
					const block = ensureThinkingBlock();
					block.thinking += reasoning;
					emit({ type: "thinking_delta", contentIndex: message.content.indexOf(block), delta: reasoning, partial: message });
				}
				if (Array.isArray(delta.tool_calls)) {
					for (const [position, tc] of delta.tool_calls.entries()) {
						const idx = typeof tc.index === "number" ? tc.index : position;
						let st = textToolCalls.get(idx);
						if (!st) {
							st = { id: "", name: "", args: "" };
							textToolCalls.set(idx, st);
						}
						if (tc.id) st.id = tc.id;
						if (tc.function?.name) st.name += tc.function.name;
						if (typeof tc.function?.arguments === "string") st.args += tc.function.arguments;
					}
				}
			}

			// Finalize blocks
			if (textBlock) emit({ type: "text_end", contentIndex: message.content.indexOf(textBlock), content: textBlock.text, partial: message });
			if (thinkingBlock) emit({ type: "thinking_end", contentIndex: message.content.indexOf(thinkingBlock), content: thinkingBlock.thinking, partial: message });

			// Tool calls: native stream or text blocks
			const toolCalls: ToolCall[] = [];
			if (toolsMode === "text" && textBlock) {
				const { toolCalls: parsed, cleanText } = parseTextToolCalls(textBlock.text);
				if (parsed.length > 0) {
					textBlock.text = cleanText;
					for (const tc of parsed) toolCalls.push(tc);
				}
			} else {
				const sorted = [...textToolCalls.entries()].sort((a, b) => a[0] - b[0]);
				for (const [, st] of sorted) {
					toolCalls.push({
						type: "toolCall",
						id: st.id || `call_${Math.random().toString(36).slice(2, 10)}`,
						name: st.name,
						arguments: parseArgsSalvaged(st.args),
					});
				}
			}
			for (const tc of toolCalls) {
				message.content.push(tc);
				emit({ type: "toolcall_end", contentIndex: message.content.indexOf(tc), toolCall: tc, partial: message });
			}

			// Estimate usage if the server didn't report it
			if (message.usage.totalTokens === 0) {
				const chars = message.content.reduce((n, c) => n + ("text" in c ? c.text.length : "thinking" in c ? c.thinking.length : 0), 0);
				message.usage = { input: 0, output: Math.ceil(chars / 4), totalTokens: Math.ceil(chars / 4) };
			}

			// Stop reason: prefer the server's, else infer (some local servers omit finish_reason)
			if (finishReason === "tool_calls" || finishReason === "tool_use" || toolCalls.length > 0) {
				message.stopReason = "toolUse";
			} else if (finishReason === "length") {
				message.stopReason = "length";
			} else if (finishReason === "stop" || finishReason === null || finishReason === "content_filter") {
				message.stopReason = "stop";
			} else {
				message.stopReason = finishReason === "aborted" ? "aborted" : "stop";
			}
			if (message.stopReason === "aborted") {
				emit({ type: "error", reason: "aborted", error: message });
			} else {
				emit({ type: "done", reason: message.stopReason, message });
			}
		} catch (err) {
			const aborted = options.signal?.aborted || (err as Error)?.name === "AbortError";
			message.stopReason = aborted ? "aborted" : "error";
			message.errorMessage = (err as Error)?.message ?? String(err);
			emit({ type: "error", reason: aborted ? "aborted" : "error", error: message });
		}
	})();

	return out;
}

/** Non-streaming one-shot convenience (used for compaction summaries). */
export async function complete(model: Model, systemPrompt: string, userPrompt: string, options?: StreamOptions): Promise<string> {
	const context: Context = { systemPrompt, messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] };
	const s = stream(model, context, { ...options, includeUsage: true });
	const message = await s.result();
	if (message.stopReason === "error") throw new Error(message.errorMessage ?? "completion failed");
	return message.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("");
}
