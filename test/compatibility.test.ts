import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeBrokenNativeTools } from "../src/ai/compat.ts";
import { apiKeyFor, pickDefaultModelId, resolveModel } from "../src/ai/models.ts";
import { parseTextToolCalls, stream } from "../src/ai/openai-completions.ts";
import { sseDataLines } from "../src/ai/sse.ts";
import type { Model, Tool } from "../src/ai/types.ts";

const model: Model = { id: "fixture", provider: "fixture", baseUrl: "http://fixture.invalid/v1", contextWindow: 32768, maxTokens: 100 };
const noArgs: Tool = { name: "rollover", description: "Start a new window", parameters: { type: "object", properties: {} } };
const required: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
}

test("empty arguments only trigger fallback when every tool requires them", () => {
	assert.equal(looksLikeBrokenNativeTools([{ name: "rollover", arguments: {} }], [noArgs]), false);
	assert.equal(looksLikeBrokenNativeTools([{ name: "read", arguments: {} }], [required]), true);
	assert.equal(looksLikeBrokenNativeTools([{ name: "read", arguments: {} }, { name: "rollover", arguments: {} }], [required, noArgs]), false);
	assert.equal(looksLikeBrokenNativeTools([{ name: "unknown", arguments: {} }]), false);
	assert.equal(looksLikeBrokenNativeTools([{ name: "", arguments: {} }], [noArgs]), true);
});

test("text tools accept {} and preserve malformed blocks alongside valid calls", () => {
	const malformed = '<tool name="read">not JSON</tool>';
	const result = parseTextToolCalls(`<tool name="rollover">{}</tool>\n${malformed}`);
	assert.deepEqual(result.toolCalls.map(({ name, arguments: args }) => ({ name, args })), [{ name: "rollover", args: {} }]);
	assert.equal(result.cleanText, malformed);
	assert.equal(parseTextToolCalls('<tool name="rollover">{}</tool>').toolCalls.length, 1);
});

test("default model selection handles parameter sizes without crashing", () => {
	assert.equal(pickDefaultModelId(["custom-7b", "custom-30b", "custom-500m"]), "custom-30b");
	assert.equal(pickDefaultModelId([]), undefined);
});

test("explicit provider beats an ambient endpoint and uppercase key lookup works", async () => {
	const priorBase = process.env.REIN_BASE_URL;
	const priorKey = process.env.OPENAI_API_KEY;
	try {
		process.env.REIN_BASE_URL = "http://fixture.invalid/v1";
		process.env.OPENAI_API_KEY = "fixture-key";
		const resolved = await resolveModel({ provider: "OPENAI", model: "explicit-model" });
		assert.equal(resolved.baseUrl, "https://api.openai.com/v1");
		assert.equal(resolved.provider, "openai");
		assert.equal(apiKeyFor("OPENAI"), "fixture-key");
		assert.equal((await resolveModel({ baseUrl: "https://api.openai.com/v1", model: "explicit-model" })).provider, "openai");
	} finally {
		if (priorBase === undefined) delete process.env.REIN_BASE_URL; else process.env.REIN_BASE_URL = priorBase;
		if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
	}
});

test("selected endpoint discovers its own model and never probes unrelated servers", async (t) => {
	const urls: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		urls.push(url);
		return Response.json({ data: [{ id: "custom-7b" }, { id: "custom-30b" }] });
	});
	const resolved = await resolveModel({ baseUrl: model.baseUrl, model: "" });
	assert.equal(resolved.baseUrl, model.baseUrl);
	assert.equal(resolved.id, "custom-30b");
	assert.deepEqual(urls, [`${model.baseUrl}/models`]);
});

test("unavailable selected endpoint fails without redirecting to local discovery", async (t) => {
	const urls: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => { urls.push(url); return Response.json({ data: [] }); });
	await assert.rejects(resolveModel({ baseUrl: model.baseUrl, model: "" }), /No models found at http:\/\/fixture.invalid\/v1/);
	assert.deepEqual(urls, [`${model.baseUrl}/models`]);
});

test("plain JSON keeps parallel tool calls separate without streaming indexes", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { tool_calls: [
		{ id: "a", function: { name: "rollover", arguments: "{}" } },
		{ id: "b", function: { name: "read", arguments: '{"path":"README.md"}' } },
	] }, finish_reason: "tool_calls" }] }));
	const result = await stream(model, { messages: [], tools: [noArgs, required] }).result();
	assert.equal(result.stopReason, "toolUse");
	assert.deepEqual(result.content.filter((c) => c.type === "toolCall").map(({ id, name, arguments: args }) => ({ id, name, args })), [
		{ id: "a", name: "rollover", args: {} }, { id: "b", name: "read", args: { path: "README.md" } },
	]);
});

test("text mode sends schemas and text history accepted by servers without native tools", async (t) => {
	let body: any;
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		body = JSON.parse(init.body as string);
		return Response.json({ choices: [{ message: { content: '<tool name="rollover">{}</tool>' }, finish_reason: "stop" }] });
	});
	const result = await stream(model, { tools: [noArgs], messages: [
		{ role: "assistant", content: [{ type: "toolCall", id: "prior", name: "rollover", arguments: {} }], provider: model.provider, model: model.id, usage: { input: 0, output: 0, totalTokens: 0 }, stopReason: "toolUse", timestamp: 0 },
		{ role: "toolResult", toolCallId: "prior", toolName: "rollover", content: [{ type: "text", text: "window ready" }], isError: false, timestamp: 0 },
	] }, { toolsMode: "text" }).result();
	assert.equal(body.tools, undefined);
	assert.equal(body.messages.some((m: any) => m.role === "tool" || m.tool_calls), false);
	assert.match(body.messages[0].content, /rollover: Start a new window/);
	assert.match(body.messages[1].content, /<tool name="rollover">/);
	assert.match(body.messages[2].content, /window ready/);
	assert.equal(result.stopReason, "toolUse");
});

test("SSE handles split frames, CRLF, multiline data, and the final unterminated frame", async () => {
	const chunks = ['data: {"a":\r', '\ndata: 1}\r\n\r\ndata: {"b":2}'];
	const events: string[] = [];
	for await (const event of sseDataLines(byteStream(chunks))) events.push(event);
	assert.deepEqual(events.map((e) => JSON.parse(e)), [{ a: 1 }, { b: 2 }]);
});

test("stream preserves split native tool argument deltas", async (t) => {
	const frames = [
		{ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: '{"path":' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: "tool_calls" }] },
	];
	t.mock.method(globalThis, "fetch", async () => new Response(byteStream(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`)), { headers: { "content-type": "text/event-stream" } }));
	const result = await stream(model, { messages: [] }).result();
	assert.deepEqual(result.content[0], { type: "toolCall", id: "a", name: "read", arguments: { path: "README.md" } });
});

test("stream error payloads are reported as errors, not empty successful replies", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response(byteStream(['data: {"error":{"message":"model unavailable"}}\n\n']), { headers: { "content-type": "text/event-stream" } }));
	const result = await stream(model, { messages: [] }).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /model unavailable/);
});

test("cancellation during body streaming is reported as aborted", async (t) => {
	const controller = new AbortController();
	t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull(streamController) {
		controller.abort();
		streamController.error(new DOMException("Aborted", "AbortError"));
	} }), { headers: { "content-type": "text/event-stream" } }));
	const result = await stream(model, { messages: [] }, { signal: controller.signal }).result();
	assert.equal(result.stopReason, "aborted");
});

test("older servers rejecting stream_options are retried once without that extension", async (t) => {
	const requests: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		requests.push(JSON.parse(init.body as string));
		if (requests.length === 1) return Response.json({ error: { message: "Unknown field stream_options" } }, { status: 400 });
		return Response.json({ choices: [{ message: { content: "compatible" }, finish_reason: "stop" }] });
	});
	const result = await stream(model, { messages: [] }).result();
	assert.equal(result.stopReason, "stop");
	assert.equal(requests.length, 2);
	assert.deepEqual(requests[0].stream_options, { include_usage: true });
	assert.equal(requests[1].stream_options, undefined);
});

test("unrelated rejected requests are not retried", async (t) => {
	let count = 0;
	t.mock.method(globalThis, "fetch", async () => { count++; return Response.json({ error: { message: "Invalid model" } }, { status: 400 }); });
	assert.equal((await stream(model, { messages: [] }).result()).stopReason, "error");
	assert.equal(count, 1);
});

test("an explicit local model is resolved on its server rather than replaced by the first server's default", async (t) => {
	t.mock.method(globalThis, "fetch", async (url: string) => Response.json({ data: [{ id: url.includes(":1234/") ? "requested-model" : "other-model" }] }));
	const resolved = await resolveModel({ baseUrl: "", model: "requested-model" });
	assert.equal(resolved.id, "requested-model");
	assert.equal(resolved.provider, "lmstudio");
});

test("an unavailable explicit local model produces a clear error instead of a substitution", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "other-model" }] }));
	await assert.rejects(resolveModel({ baseUrl: "", model: "requested-model" }), /requested-model.*was not found/);
});
