import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModel } from "../src/ai/models.ts";
import { stream } from "../src/ai/openai-completions.ts";
import { runSetup, testConnection } from "../src/harness/setup.ts";
import type { SetupDependencies } from "../src/harness/setup.ts";

const model = { id: "fixture", provider: "custom", baseUrl: "https://gateway.invalid/proxy/inference", contextWindow: 8192, maxTokens: 512 };
const completion = (message: unknown) => Response.json({ choices: [{ message, finish_reason: "stop" }] });
const sse = (deltas: unknown[]) => new Response(deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("") + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
const visibleText = (message: Awaited<ReturnType<ReturnType<typeof stream>["result"]>>) => message.content.filter(part => part.type === "text").map(part => part.text).join("");

async function isolated(run: (configPath: string) => Promise<void>) {
	const home = mkdtempSync(join(tmpdir(), "rein-chat-api-"));
	const keys = ["REIN_HOME", "REIN_API", "REIN_BASE_URL", "REIN_MODEL"];
	const previous = new Map(keys.map(key => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env.REIN_HOME = home;
	try { await run(join(home, "config.json")); }
	finally { for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; rmSync(home, { recursive: true, force: true }); }
}

function setupDependencies(logs: string[]): SetupDependencies {
	return {
		log: text => logs.push(text), keyFor: () => undefined,
		discover: async () => { throw new Error("Unexpected discovery"); },
		detect: async baseUrl => ({ baseUrl, provider: "custom", models: [model.id] }),
		connection: async () => ({ ok: true, detail: "mock connection" }),
		cliStatus: async () => { throw new Error("Unexpected CLI authentication check"); },
	};
}

test("JSON and SSE content-part arrays and refusals preserve usable visible output", async t => {
	const cases = [
		{ response: () => completion({ content: [{ type: "text", text: "hello " }, null, { type: "image_url", image_url: {} }, { type: "text", text: "world" }] }), text: "hello world" },
		{ response: () => sse([{ content: [{ type: "text", text: "hello " }] }, { content: [{ type: "text", text: "world" }] }]), text: "hello world" },
		{ response: () => completion({ content: null, refusal: "Request declined." }), text: "Request declined." },
		{ response: () => completion({ content: " ", refusal: "Request declined." }), text: "Request declined." },
		{ response: () => completion({ content: [{ type: "refusal", refusal: "Request declined." }] }), text: "Request declined." },
		{ response: () => sse([{ refusal: "Request " }, { refusal: "declined." }]), text: "Request declined." },
	];
	const fetchMock = t.mock.method(globalThis, "fetch", async () => cases[0].response());
	for (const item of cases) {
		fetchMock.mock.mockImplementation(async () => item.response());
		const response = await stream(model, { messages: [] }).result();
		assert.equal(response.stopReason, "stop", JSON.stringify(response));
		assert.equal(visibleText(response).trim(), item.text);
	}
});

test("setup validates JSON and SSE output, rejecting empty or unsupported content parts", async t => {
	const cases = [
		{ response: () => completion({ content: [{ type: "text", text: "ok" }] }), ok: true },
		{ response: () => completion({ content: null, refusal: "Request declined." }), ok: true },
		{ response: () => sse([{ content: [{ type: "text", text: "ok" }] }]), ok: true },
		{ response: () => completion({ content: [] }), ok: false },
		{ response: () => completion({ content: [{ type: "unsupported", text: "not assistant text" }] }), ok: false },
		{ response: () => completion({ content: "   " }), ok: false },
	];
	const fetchMock = t.mock.method(globalThis, "fetch", async () => cases[0].response());
	for (const item of cases) {
		fetchMock.mock.mockImplementation(async () => item.response());
		assert.equal((await testConnection(model.baseUrl, model.id)).ok, item.ok);
	}
});

test("JSON and SSE usage preserves reported input/output when total_tokens is omitted", async t => {
	const chunk = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
	const responses = [() => Response.json(chunk), () => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })];
	const fetchMock = t.mock.method(globalThis, "fetch", async () => responses[0]());
	for (const response of responses) {
		fetchMock.mock.mockImplementation(async () => response());
		const message = await stream(model, { messages: [] }).result();
		assert.deepEqual(message.usage, { input: 10, output: 5, totalTokens: 15 });
	}
});

test("explicit Chat Completions keeps root and custom API prefixes unchanged", async t => isolated(async path => {
	const requests: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => { requests.push(url); return completion({ content: "ok" }); });
	for (const baseUrl of ["https://gateway.invalid/", "https://gateway.invalid/proxy/inference"]) {
		writeFileSync(path, JSON.stringify({ provider: "custom", api: "chat-completions", baseUrl, model: model.id }));
		const resolved = await resolveModel({ api: "chat-completions" });
		assert.equal(resolved.baseUrl, baseUrl);
		assert.equal((await stream(resolved, { messages: [] }).result()).stopReason, "stop");
		assert.equal((await testConnection(baseUrl, model.id)).ok, true);
		assert.deepEqual(requests.splice(0), Array(2).fill(`${baseUrl.replace(/\/$/, "")}/chat/completions`));
		const logs: string[] = [];
		assert.equal(await runSetup({ yes: true, api: "chat-completions" }, setupDependencies(logs)), 0, logs.join("\n"));
		assert.equal(JSON.parse(readFileSync(path, "utf8")).baseUrl, baseUrl);
		assert.ok(logs.some(log => log.includes(`POST ${baseUrl.replace(/\/$/, "")}/chat/completions\n`)));
	}
}));

test("protocol precedence validates environment and saved settings before HTTP work", async t => isolated(async path => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected HTTP request"); });
	writeFileSync(path, JSON.stringify({ ...model, model: model.id, api: "responses" }));
	await assert.rejects(resolveModel(), /Supported HTTP API/);
	for (const options of [{ status: true }, { yes: true }]) {
		const logs: string[] = [];
		assert.equal(await runSetup(options, { ...setupDependencies(logs), detect: async () => { throw new Error("Unexpected HTTP discovery"); }, connection: async () => { throw new Error("Unexpected HTTP test"); } }), 1);
		assert.match(logs.join("\n"), /Supported HTTP API/);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).api, "responses");
	}
	process.env.REIN_API = " chat-completions ";
	assert.equal((await resolveModel()).baseUrl, model.baseUrl);
	process.env.REIN_API = "responses";
	await assert.rejects(resolveModel(), /Supported HTTP API/);
	assert.equal((await resolveModel({ api: "chat-completions" })).baseUrl, model.baseUrl);
	const logs: string[] = [];
	assert.equal(await runSetup({ yes: true, api: "chat-completions" }, setupDependencies(logs)), 0, logs.join("\n"));
	assert.equal(JSON.parse(readFileSync(path, "utf8")).api, "chat-completions");
	delete process.env.REIN_API;
	await assert.rejects(resolveModel({ api: "" }), /Supported HTTP API/);
}));

test("explicit HTTP protocols cannot select CLI transports, including setup status", async () => isolated(async path => {
	writeFileSync(path, JSON.stringify({ provider: "codex", auth: { type: "cli", provider: "codex" }, baseUrl: "cli://codex", model: "default" }));
	for (const api of ["chat-completions", ""]) await assert.rejects(resolveModel({ api }), /HTTP API|HTTP API protocol/);
	for (const options of [{ status: true }, { yes: true, provider: "codex" }]) {
		const logs: string[] = [];
		assert.equal(await runSetup({ ...options, api: "chat-completions" }, setupDependencies(logs)), 1);
		assert.match(logs.join("\n"), /CLI subscriptions|Subscription CLI/);
		assert.doesNotMatch(logs.join("\n"), /Unexpected CLI authentication/);
	}
	process.env.REIN_API = "chat-completions";
	await assert.rejects(resolveModel(), /HTTP API protocol/);
	const logs: string[] = [];
	assert.equal(await runSetup({ status: true }, setupDependencies(logs)), 1);
	assert.match(logs.join("\n"), /CLI subscriptions|Subscription CLI/);
}));
