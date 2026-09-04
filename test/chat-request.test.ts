import assert from "node:assert/strict";
import test from "node:test";
import { postChatCompletion } from "../src/ai/chat-request.ts";
import { stream } from "../src/ai/openai-completions.ts";
import { testConnection } from "../src/harness/setup.ts";

const unsupported = (field: string, message = `Unsupported parameter: '${field}'`, status = 400) => new Response(JSON.stringify({ error: { param: field, code: "unsupported_parameter", message } }), { status });
const success = () => Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });

test("bounded field retries preserve body, token budget, headers, cancellation and redirect policy", async () => {
	const body = { model: "reasoner", messages: [{ role: "user", content: "hi" }], max_tokens: 128, stream_options: { include_usage: true }, temperature: 0.2, top_p: 0.7 };
	const responses = [unsupported("max_tokens", "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead."), unsupported("stream_options"), unsupported("temperature", "Unsupported value: temperature does not support 0.2; only the default value is supported"), unsupported("top_p", undefined, 422), success()];
	const requests: RequestInit[] = []; const signal = new AbortController().signal; const headers = { authorization: "Bearer fixture", "content-type": "application/json" };
	const response = await postChatCompletion("https://unused.invalid", body, { signal, headers, redirect: "follow" }, (async (_url, init) => { requests.push(init!); return responses.shift()!; }) as typeof fetch);
	assert.equal(response.status, 200); assert.equal(requests.length, 5);
	assert.deepEqual(JSON.parse(requests[4].body as string), { model: body.model, messages: body.messages, max_completion_tokens: 128 });
	assert.ok(requests.every(request => request.signal === signal && request.headers === headers && request.redirect === "error" && request.method === "POST"));
	assert.equal(body.max_tokens, 128); assert.equal(body.temperature, 0.2); assert.ok(body.stream_options);
});

test("explicit max_completion_tokens is retained when legacy max_tokens is rejected", async () => {
	const requests: Record<string, unknown>[] = [];
	await postChatCompletion("https://unused.invalid", { max_tokens: 1000, max_completion_tokens: 100 }, {}, (async (_url, init) => {
		requests.push(JSON.parse(init!.body as string)); return requests.length === 1 ? unsupported("max_tokens", "Unsupported max_tokens: use max_completion_tokens") : success();
	}) as typeof fetch);
	assert.deepEqual(requests[1], { max_completion_tokens: 100 });
});

test("auth, server, validation and incidental field mentions are never retried", async () => {
	for (const [status, detail] of [[401, "Unsupported temperature"], [500, "Unsupported stream_options"], [400, "temperature must be between 0 and 2"], [422, "Malformed messages; request included stream_options"], [400, "Unsupported max_tokens"], [400, "Unsupported tools. Original request also specified temperature."], [400, "Unsupported tools with temperature also provided"]] as const) {
		let count = 0;
		const response = await postChatCompletion("https://unused.invalid", { max_tokens: 20, stream_options: {}, temperature: 0.7 }, {}, (async () => { count++; return new Response(detail, { status }); }) as typeof fetch);
		assert.equal(count, 1, detail); assert.equal(await response.text(), detail);
	}
});

test("repeated rejection of already removed field stops without retry loop", async () => {
	let count = 0;
	const response = await postChatCompletion("https://unused.invalid", { temperature: 0.2 }, {}, (async () => { count++; return unsupported("temperature"); }) as typeof fetch);
	assert.equal(count, 2); assert.equal(response.status, 400);
});

test("abort after rejection prevents another request", async () => {
	const controller = new AbortController(); let count = 0;
	await assert.rejects(postChatCompletion("https://unused.invalid", { stream_options: {} }, { signal: controller.signal }, (async () => { count++; controller.abort(); return unsupported("stream_options"); }) as typeof fetch), { name: "AbortError" });
	assert.equal(count, 1);
});

test("setup probe and streaming adapter share reasoning-model token compatibility", async t => {
	const bodies: Record<string, any>[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string); bodies.push(body);
		return "max_tokens" in body ? unsupported("max_tokens", "Unsupported parameter max_tokens. Use max_completion_tokens instead.") : success();
	});
	assert.equal((await testConnection("https://unused.invalid/v1", "reasoner")).ok, true);
	const result = await stream({ id: "reasoner", provider: "openai", baseUrl: "https://unused.invalid/v1", contextWindow: 10000, maxTokens: 512 }, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }).result();
	assert.equal(result.stopReason, "stop"); assert.equal(bodies.length, 4); assert.equal(bodies[1].max_completion_tokens, 8); assert.equal(bodies[3].max_completion_tokens, 512);
});
