import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { testConnection } from "../src/harness/setup.ts";
import { stream } from "../src/ai/openai-completions.ts";

async function withApi(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (baseUrl: string) => Promise<void>) {
	const server = createServer(handler);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`); }
	finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

const completion = (message: unknown) => ({ choices: [{ message, finish_reason: "length" }] });
const event = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;
const delta = (message: unknown) => ({ choices: [{ delta: message }] });

test("connection probe budgets a short reasoning pass before the visible answer", async () => {
	let received: { url?: string; authorization?: string; body?: any } = {};
	await withApi((request, response) => {
		let body = "";
		request.on("data", chunk => { body += chunk; });
		request.on("end", () => {
			received = { url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) };
			// The reproduced model-host response needed 26 tokens to reach its two-letter answer.
			const content = received.body.max_tokens >= 26 ? "ok" : "";
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(completion({ role: "assistant", content, reasoning_content: "fixture reasoning" })));
		});
	}, async baseUrl => {
		const result = await testConnection(baseUrl, "reasoning-model", "fixture-api-key");
		assert.equal(result.ok, true, result.detail);
		assert.match(result.detail, /^valid chat completion in \d+ms$/);
		assert.equal(received.url, "/v1/chat/completions");
		assert.equal(received.authorization, "Bearer fixture-api-key");
		assert.equal(received.body.model, "reasoning-model");
		assert.ok(received.body.max_tokens >= 26 && received.body.max_tokens <= 256, "Keep the probe useful and bounded");
	});
});

test("JSON and SSE reasoning-only responses pass setup with an explicit final-answer caveat", async () => {
	for (const format of ["json", "sse"]) {
		for (const field of ["reasoning_content", "reasoning", "thinking"]) {
			await withApi((_request, response) => {
				const message = { role: "assistant", content: "", [field]: "private fixture reasoning" };
				response.writeHead(200, { "content-type": format === "json" ? "application/json" : "text/event-stream" });
				response.end(format === "json" ? JSON.stringify(completion(message))
					: event(delta(message)) + event({ choices: [{ delta: {}, finish_reason: "length" }] }) + "data: [DONE]\n\n");
			}, async baseUrl => {
				const result = await testConnection(baseUrl, "reasoning-model");
				assert.equal(result.ok, true, `${format} ${field}: ${result.detail}`);
				assert.match(result.detail, /probe returned reasoning rather than a final answer/);
				assert.doesNotMatch(result.detail, /private fixture reasoning/);
			});
		}
	}
});

test("reasoning followed by visible SSE content reports a normal completion", async () => {
	await withApi((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(event(delta({ reasoning_content: "fixture reasoning" })) + event(delta({ content: "ok" })) + "data: [DONE]\n\n");
	}, async baseUrl => {
		const result = await testConnection(baseUrl, "reasoning-model");
		assert.equal(result.ok, true, result.detail);
		assert.match(result.detail, /^valid chat completion in \d+ms$/);
	});
});

test("reasoning support does not accept malformed, empty, or non-completion responses", async () => {
	const invalid = [
		{}, { status: "healthy", reasoning_content: "not a completion" },
		{ choices: { 0: { message: { reasoning_content: "wrong choices shape" } } } },
		completion(null), completion({}), completion({ content: "", reasoning_content: " \n\t" }),
		completion({ reasoning: [] }), completion({ thinking: { text: "wrong type" } }),
		completion({ reasoning_content: 123 }), completion({ content: [], reasoning_content: null }),
	];
	for (const format of ["json", "sse"]) {
		for (const payload of invalid) {
			await withApi((_request, response) => {
				response.writeHead(200, { "content-type": format === "json" ? "application/json" : "text/event-stream" });
				response.end(format === "json" ? JSON.stringify(payload) : event(payload) + "data: [DONE]\n\n");
			}, async baseUrl => {
				const result = await testConnection(baseUrl, "reasoning-model");
				assert.equal(result.ok, false, `${format} ${JSON.stringify(payload)}`);
				assert.match(result.detail, /no valid chat completion/);
			});
		}
	}
});

test("malformed JSON and streams containing only keepalives remain failed probes", async () => {
	for (const fixture of [
		{ type: "application/json", body: '{"choices":[' },
		{ type: "text/event-stream", body: ': keepalive\n\ndata: not-json\n\ndata: [DONE]\n\n' },
	]) {
		await withApi((_request, response) => { response.writeHead(200, { "content-type": fixture.type }); response.end(fixture.body); }, async baseUrl => {
			assert.equal((await testConnection(baseUrl, "reasoning-model")).ok, false);
		});
	}
});

test("HTTP and trailing SSE errors still fail and redact credentials after reasoning arrives", async () => {
	const key = "private-key-" + "x".repeat(400);
	const cases = [
		{ status: 401, type: "application/json", body: JSON.stringify({ error: { message: `Rejected ${key}` } }) },
		{ status: 500, type: "application/json", body: JSON.stringify({ ...completion({ reasoning: "partial output" }), error: { message: `Failed ${key}` } }) },
		{ status: 200, type: "application/json", body: JSON.stringify({ ...completion({ reasoning: "partial output" }), error: { message: `Failed ${key}` } }) },
		{ status: 200, type: "text/event-stream", body: event(delta({ reasoning_content: "partial output" })) + event({ error: { message: `Failed ${key}` } }) + "data: [DONE]\n\n" },
	];
	for (const fixture of cases) {
		await withApi((_request, response) => { response.writeHead(fixture.status, { "content-type": fixture.type }); response.end(fixture.body); }, async baseUrl => {
			const result = await testConnection(baseUrl, "reasoning-model", key);
			assert.equal(result.ok, false, result.detail);
			assert.match(result.detail, /\[redacted\]/);
			assert.doesNotMatch(result.detail, /private-key-|xxxx/);
		});
	}
});

test("provider terminal failures reject JSON and SSE probes after reasoning or visible partial output", async () => {
	const key = "private-terminal-fixture-key";
	for (const finishReason of ["content_filter", "aborted"]) {
		for (const output of [{ reasoning_content: `partial reasoning ${key}` }, { content: `partial answer ${key}` }]) {
			for (const format of ["json", "sse", "sse-terminal"]) {
				await withApi((_request, response) => {
					response.writeHead(200, { "content-type": format === "json" ? "application/json" : "text/event-stream" });
					response.end(format === "json" ? JSON.stringify({ choices: [{ message: { role: "assistant", ...output }, finish_reason: finishReason }] })
						: (format === "sse-terminal" ? event(delta(output)) + event({ choices: [{ delta: {}, finish_reason: finishReason }] })
							: event({ choices: [{ delta: output, finish_reason: finishReason }] })) + "data: [DONE]\n\n");
				}, async baseUrl => {
					const result = await testConnection(baseUrl, "reasoning-model", key);
					assert.equal(result.ok, false, `${format} ${finishReason}: ${result.detail}`);
					assert.ok(result.detail.includes(`(${finishReason})`), result.detail);
					assert.equal(result.detail.includes(key), false);
					assert.doesNotMatch(result.detail, /valid chat completion|partial reasoning|partial answer/);
				});
			}
		}
	}
});

test("a stalled reasoning stream remains bounded by the connection timeout", async t => {
	const timeout = AbortSignal.timeout.bind(AbortSignal);
	t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
		assert.equal(milliseconds, 20_000);
		return timeout(100);
	});
	await withApi((_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(event(delta({ reasoning_content: "partial output" })));
	}, async baseUrl => {
		const result = await testConnection(baseUrl, "reasoning-model");
		assert.equal(result.ok, false, result.detail);
		assert.match(result.detail, /abort|timeout/i);
	});
});

test("runtime reasoning aliases match setup and preserve whitespace in streaming deltas", async () => {
	for (const format of ["json", "sse"]) {
		await withApi((_request, response) => {
			response.writeHead(200, { "content-type": format === "json" ? "application/json" : "text/event-stream" });
			response.end(format === "json" ? JSON.stringify(completion({ reasoning_content: "", reasoning: "fixture reasoning" }))
				: event(delta({ thinking: "fixture" })) + event(delta({ reasoning: " " })) + event(delta({ reasoning_content: "", reasoning: "reasoning" }))
					+ event({ choices: [{ delta: {}, finish_reason: "length" }] }) + "data: [DONE]\n\n");
		}, async baseUrl => {
			const model = { id: "reasoning-model", provider: "custom", baseUrl, contextWindow: 8192, maxTokens: 512 };
			const result = await stream(model, { messages: [] }).result();
			assert.equal(result.stopReason, "length", result.errorMessage);
			assert.equal(result.content.filter(part => part.type === "thinking").map(part => part.thinking).join(""), "fixture reasoning");
			const probe = await testConnection(baseUrl, model.id);
			assert.equal(probe.ok, true, probe.detail);
			assert.match(probe.detail, /probe returned reasoning/);
		});
	}
});
