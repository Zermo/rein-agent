import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRunner } from "../runner.ts";
import type { RunnerOptions } from "../runner.ts";
import { stream, TEXT_TOOL_INSTRUCTIONS } from "../../ai/openai-completions.ts";
import { streamCli } from "../../ai/cli-provider.ts";
import { loadConfig } from "../../ai/models.ts";
import { looksLikeBrokenNativeTools } from "../../ai/compat.ts";
import type { Context, Message, Tool } from "../../ai/types.ts";
import { inspectionTools } from "../autonomy/inspect.ts";
import { runMeatEngine, type MeatResult } from "./runtime.ts";

const exec = promisify(execFile);
export interface ReviewOptions extends RunnerOptions {
	diff?: string; refs?: string[]; staged?: boolean; workingTree?: boolean;
	signal?: AbortSignal; onProgress?: (text: string) => void;
}

export async function reviewDiff(cwd: string, options: Pick<ReviewOptions, "refs" | "staged" | "workingTree" | "signal"> = {}): Promise<string> {
	const refs = options.refs ?? [];
	if (refs.length > 2 || [refs.length > 0, !!options.staged, !!options.workingTree].filter(Boolean).length > 1) throw new Error("Choose up to two commit refs, --staged, or --working-tree.");
	const shas: string[] = [];
	for (const ref of refs) {
		if (!ref || ref.startsWith("-") || ref.includes("\0")) throw new Error("Use valid commit refs for Meat review.");
		shas.push((await exec("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd, signal: options.signal, timeout: 5000 })).stdout.trim());
	}
	const safe = ["--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
	const args = options.staged ? ["diff", ...safe, "--cached", "--"] : options.workingTree ? ["diff", ...safe, "HEAD", "--"]
		: shas.length === 2 ? ["diff", ...safe, ...shas, "--"] : ["show", "--format=", ...safe, shas[0] ?? "HEAD", "--"];
	try { return (await exec("git", args, { cwd, signal: options.signal, maxBuffer: 4 * 1024 * 1024, timeout: 10000 })).stdout; }
	catch (error) { if ((error as any).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("Diff exceeds Meat's 4 MB limit. Select a smaller commit range."); throw error; }
}

function messagesFromMeat(messages: any[]): Message[] {
	const out: Message[] = [];
	for (const message of messages) {
		const blocks = message.Content ?? [];
		if (message.Role === "assistant") {
			const content = blocks.flatMap((block: any) => block.Type === "text" ? [{ type: "text", text: block.Text }] : block.Type === "tool_use" ? [{ type: "toolCall", id: block.ID, name: block.ToolName, arguments: block.ToolInput }] : []);
			out.push({ role: "assistant", content, provider: "meat", model: "meat", usage: { input: 0, output: 0, totalTokens: 0 }, stopReason: content.some((p: any) => p.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now() });
		} else {
			for (const block of blocks) {
				if (block.Type === "text") out.push({ role: "user", content: block.Text, timestamp: Date.now() });
				if (block.Type === "tool_result") out.push({ role: "toolResult", toolCallId: block.ToolUseID, toolName: "meat", content: [{ type: "text", text: block.ToolResult }], isError: block.ToolError, timestamp: Date.now() });
			}
		}
	}
	return out;
}

export async function runMeatReview(options: ReviewOptions): Promise<MeatResult> {
	const diff = options.diff ?? await reviewDiff(options.cwd, options);
	if (!diff.trim()) return { smart_diff: "", summary: "No changes.", input_tokens: 0, output_tokens: 0 };
	const runner = await createRunner({ ...options, tools: [], autoContext: false, systemPrompt: "", activityId: undefined });
	const { model, apiKey } = runner;
	const config = loadConfig();
	let toolsMode = runner.toolsMode, requests = 0;
	const forcedMode = options.toolsMode ?? config.toolsMode;
	const readTools = inspectionTools(options.cwd);
	const controller = new AbortController();
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	try { return await runMeatEngine({ diff, cwd: options.cwd, maxTurns: Math.min(options.maxTurns ?? 8, 24),
		chunkBytes: Math.max(1024, Math.min(200000, (model.contextWindow - model.maxTokens - 10000) * 2)), signal: controller.signal, onProgress: options.onProgress,
		request: async (kind, payload) => {
			controller.signal.throwIfAborted();
			if (kind === "read") {
				const input = payload.input;
				if (payload.name === "read_file") {
					const result = await readTools.find(t => t.name === "read")!.execute("meat-read", input, controller.signal);
					return result.content;
				}
				// Meat's grep tool uses patterns. This scoped host deliberately
				// supplies literal search and reports that distinction to the model.
				const result = await readTools.find(t => t.name === "search")!.execute("meat-search", { query: input.pattern, path: input.path ?? "." }, controller.signal);
				return "Scoped literal search results (regular-expression syntax is not expanded):\n" + result.content;
			}
			if (++requests > 32) throw new Error("Meat reached its 32-request review budget. Select a smaller diff.");
			const tools: Tool[] = payload.tools.map((tool: any) => ({ name: tool.Name, description: tool.Name === "grep" ? "Search visible workspace files for literal text (case insensitive, no regex). Optional path must be a directory. Hidden/private paths, links, dependencies and large files are excluded; results are bounded." : tool.Name === "read_file" ? tool.Description + " Rein excludes hidden/private paths, links and files over 200000 bytes; responses are capped at 15000 characters." : tool.Description, parameters: tool.InputSchema }));
			const context: Context = { systemPrompt: payload.system + (toolsMode === "text" ? TEXT_TOOL_INSTRUCTIONS : ""), messages: messagesFromMeat(payload.messages), tools };
			if (Math.ceil(JSON.stringify(context).length / 3) + model.maxTokens + 256 > model.contextWindow) throw new Error("Meat's review context exceeds this model's configured context window. Select a smaller diff or increase the verified context-window setting.");
			const response = model.baseUrl.startsWith("cli://") ? streamCli(model, context, { signal: controller.signal, maxTokens: model.maxTokens })
				: stream(model, context, { apiKey, signal: controller.signal, maxTokens: model.maxTokens, toolsMode, temperature: options.temperature ?? config.temperature });
			const result = await response.result();
			if (result.stopReason !== "stop" && result.stopReason !== "toolUse") throw new Error(result.errorMessage ?? `Meat response ended with ${result.stopReason}.`);
			const calls = result.content.filter(part => part.type === "toolCall");
			if (toolsMode === "native" && forcedMode !== "native" && calls.length && looksLikeBrokenNativeTools(calls, tools)) toolsMode = "text";
			return { InputTokens: result.usage.input, OutputTokens: result.usage.output, Content: result.content.flatMap(part => part.type === "text" ? [{ Type: "text", Text: part.text }]
				: part.type === "toolCall" ? [{ Type: "tool_use", ID: part.id, ToolName: part.name, ToolInput: part.arguments }] : []) };
		},
	}); } finally { controller.abort(); options.signal?.removeEventListener("abort", abort); }
}
