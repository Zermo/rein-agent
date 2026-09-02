/**
 * Mock OpenAI-compatible server for deterministic pipeline tests.
 *
 * Models it serves (chosen by the request's `model` field):
 *   mock-native    proper native tool calls, then a final answer
 *   mock-broken    first turn: tool_calls with EMPTY args (can't do tools);
 *                  after the harness falls back (system prompt gains the
 *                  <tool> instructions) it emits <tool> text blocks
 *   mock-text      always emits <tool> text blocks (weak-model simulation)
 *
 * Run standalone: node --experimental-strip-types test/mock-server.ts [port]
 */
import { createServer, Server, IncomingMessage, ServerResponse } from "node:http";

function sseStart(res: ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
}

function sseData(res: ServerResponse, obj: unknown): void {
	res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseEnd(res: ServerResponse): void {
	res.write("data: [DONE]\n\n");
	res.end();
}

function streamText(res: ServerResponse, model: string, text: string, finishReason = "stop"): void {
	sseStart(res);
	// emit in 2 chunks to exercise incremental assembly
	const mid = Math.ceil(text.length / 2);
	sseData(res, { id: "cmpl-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant" } }] });
	if (mid > 0) sseData(res, { id: "cmpl-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: text.slice(0, mid) } }] });
	if (mid < text.length) sseData(res, { id: "cmpl-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: text.slice(mid) } }] });
	sseData(res, { id: "cmpl-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
	sseData(res, { id: "cmpl-1", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
	sseEnd(res);
}

function streamToolCall(res: ServerResponse, model: string, name: string, argsJson: string, callId: string): void {
	sseStart(res);
	sseData(res, { id: "cmpl-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant" } }] });
	sseData(res, {
		id: "cmpl-1",
		object: "chat.completion.chunk",
		model,
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{ index: 0, id: callId, type: "function", function: { name, arguments: argsJson.slice(0, 8) } },
					],
				},
			},
		],
	});
	sseData(res, {
		id: "cmpl-1",
		object: "chat.completion.chunk",
		model,
		choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(8) } }] } }],
	});
	sseData(res, { id: "cmpl-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
	sseData(res, { id: "cmpl-1", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });
	sseEnd(res);
}

function lastUserOrSystemText(body: any): string {
	const msgs = body?.messages ?? [];
	let text = "";
	for (const m of msgs) text += `${m.role}:${typeof m.content === "string" ? m.content : ""}\n`;
	return text;
}

export function createMockServer(): Server {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "mock-native" }, { id: "mock-broken" }, { id: "mock-text" }] }));
			return;
		}

		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			let raw = "";
			req.on("data", (c) => (raw += c));
			req.on("end", () => {
				let body: any;
				try {
					body = JSON.parse(raw);
				} catch {
					res.writeHead(400);
					res.end("bad json");
					return;
				}
				const model = body.model ?? "mock-native";
				const text = lastUserOrSystemText(body);
				const toolResults = (body.messages ?? []).filter((m: any) => m.role === "tool");
				const hasToolResults = toolResults.length > 0;
				const inTextMode = text.includes("<tool name=");

				if (model === "mock-native") {
					if (!hasToolResults) {
						streamToolCall(res, model, "bash", JSON.stringify({ command: "echo hi-from-native" }), "call_1");
					} else {
						streamText(res, model, `Ran the command. Result was: ${body.messages.find((m: any) => m.role === "tool")?.content ?? "?"}`);
					}
					return;
				}

				if (model === "mock-broken") {
					if (!hasToolResults) {
						// can't do native tools: empty args / unnamed call
						streamToolCall(res, model, "", "{}", "call_b1");
						return;
					}
					if (inTextMode && toolResults.length === 1) {
						// fallback engaged: retry using the text protocol (trailing comma exercises salvage)
						streamText(res, model, 'I\'ll check that.\n<tool name="bash">\n{"command": "echo hi-from-text",}\n</tool>');
						return;
					}
					streamText(res, model, `Done. Last tool said: ${toolResults[toolResults.length - 1]?.content ?? "?"}`);
					return;
				}

				if (model === "mock-text") {
					if (!hasToolResults) {
						streamText(res, model, 'Let me run it.\n<tool name="bash">\n{"command": "echo text-mode-works"}\n</tool>');
					} else {
						streamText(res, model, `Got it: ${body.messages.find((m: any) => m.role === "tool")?.content ?? "?"}`);
					}
					return;
				}

				streamText(res, model, "hello");
			});
			return;
		}

		res.writeHead(404);
		res.end("not found");
	});
}

if (process.argv[1] && process.argv[1].endsWith("mock-server.ts")) {
	const port = parseInt(process.argv[2] ?? "8123");
	const server = createMockServer();
	server.listen(port, () => {
		console.log(`mock OpenAI server on http://localhost:${port}/v1 (models: mock-native, mock-broken, mock-text)`);
	});
}
