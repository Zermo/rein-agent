import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyReasoningRequest, reasoningCapabilities, reasoningRequestFields, validateReasoningEffort } from "../src/ai/reasoning.ts";
import { stream } from "../src/ai/openai-completions.ts";
import type { Model } from "../src/ai/types.ts";
import { createRunner } from "../src/harness/runner.ts";

const model = (provider = "custom", id = "local-fixture"): Model => ({ provider, id, baseUrl: "https://fixture.invalid/v1", contextWindow: 32768, maxTokens: 1024 });
const context = { systemPrompt: "Keep the existing prompt.", messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
const reply = () => Response.json({ choices: [{ message: { content: "Hello." }, finish_reason: "stop" }] });

test("reasoning preference validation keeps default distinct from off and rejects untrusted values", () => {
	assert.equal(validateReasoningEffort(undefined), "default");
	for (const value of ["default", "off", "low", "medium", "high"]) assert.equal(validateReasoningEffort(value), value);
	for (const value of [null, "none", "max", "HIGH", true, 0, {}, ["low"]]) assert.throws(() => validateReasoningEffort(value), /reasoningEffort must/);
});

test("cloud capabilities expose only verified controls and never label mandatory reasoning as off", () => {
	assert.deepEqual(reasoningRequestFields(model("openai", "gpt-5.2"), "off"), { reasoning_effort: "none" });
	assert.equal(reasoningCapabilities(model("openai", "gpt-5.1-2025-11-13")).mode, "supported");
	for (const id of ["gpt-5", "gpt-5-mini", "o3", "o4-mini", "gpt-6-astra"]) {
		assert.equal(reasoningCapabilities(model("openai", id)).supported.includes("off"), false, id);
		assert.throws(() => reasoningRequestFields(model("openai", id), "off"), /not supported/);
	}
	for (const id of ["gpt-4.1", "gpt-5-chat-latest", "gpt-5.1-codex", "unknown", "gpt-50"]) assert.deepEqual(reasoningCapabilities(model("openai", id)).supported, ["default"], id);
	assert.deepEqual(reasoningRequestFields(model("xai", "grok-4.6-latest"), "medium"), { reasoning_effort: "medium" });
	assert.throws(() => reasoningRequestFields(model("xai", "grok-4.6"), "off"), /cannot be disabled/);
	assert.throws(() => reasoningRequestFields(model("xai", "grok-4"), "high"), /not supported/);
	for (const provider of ["codex", "copilot", "grok", "anthropic"]) assert.deepEqual(reasoningCapabilities(model(provider)).supported, ["default"]);
	assert.deepEqual(reasoningCapabilities({ ...model(), baseUrl: "cli://codex" }).supported, ["default"]);
});

test("local capabilities distinguish requested template controls from proven model support", () => {
	for (const provider of ["llamacpp", "vllm", "ollama", "lmstudio", "custom", "openai-compatible"]) {
		const capability = reasoningCapabilities(model(provider, "Qwen3-8B"));
		assert.equal(capability.mode, "server-dependent");
		assert.ok(capability.supported.includes("default"));
		assert.match(capability.description, /template|model/);
		assert.throws(() => reasoningRequestFields(model(provider, "publisher/gpt-oss-20b"), "off"), /cannot be fully disabled/);
		assert.deepEqual(reasoningCapabilities(model(provider, "publisher/DeepSeek-R1")).supported, ["default"]);
	}
});

test("default is a no-op for extension fields and template configuration", () => {
	const body = { reasoning_effort: "provider-custom", temperature: 0.4, chat_template_kwargs: { own: 1 } };
	const before = structuredClone(body);
	applyReasoningRequest(body, model("llamacpp"), "default");
	assert.deepEqual(body, before);
});

test("explicit effort preserves unrelated template options and rejects conflicting controls", () => {
	const original = { own: "kept", enable_thinking: false };
	const body: Record<string, unknown> = { chat_template_kwargs: original };
	applyReasoningRequest(body, model("llamacpp"), "off");
	assert.deepEqual(body, { reasoning_effort: "none", chat_template_kwargs: { own: "kept", enable_thinking: false, reasoning_effort: "none" } });
	assert.deepEqual(original, { own: "kept", enable_thinking: false });
	for (const extra of [{ model: "another-model" }, { reasoning_effort: "low" }, { reasoning: { effort: "low" } }, { think: false }, { thinking: { type: "disabled" } }, { thinking_budget: 0 }, { chat_template_kwargs: { enable_thinking: false } }, { chat_template_kwargs: { reasoning_effort: "low" } }, { chat_template_kwargs: "invalid" }]) {
		assert.throws(() => applyReasoningRequest({ ...extra }, model(), "high"), /conflict|must be an object/);
	}
});

test("stream serializes explicit settings without rewriting the cached message prefix", async t => {
	const requests: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { requests.push(JSON.parse(init.body as string)); return reply(); });
	for (const reasoningEffort of ["default", "off", "low", "medium", "high"] as const) {
		assert.equal((await stream(model(), context, { reasoningEffort }).result()).stopReason, "stop");
	}
	assert.equal(Object.hasOwn(requests[0], "reasoning_effort"), false);
	assert.deepEqual(requests.slice(1).map(request => request.reasoning_effort), ["none", "low", "medium", "high"]);
	for (const request of requests) assert.deepEqual(request.messages, requests[0].messages);
});

test("nested model connections inherit effort while an explicit default preserves server behavior", async t => {
	const requests: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { requests.push(JSON.parse(init.body as string)); return reply(); });
	const inherited = { ...model("vllm"), reasoningEffort: "high" as const };
	await stream(inherited, context).result();
	await stream(inherited, context, { reasoningEffort: "default" }).result();
	assert.deepEqual(requests[0].chat_template_kwargs, { enable_thinking: true, reasoning_effort: "high" });
	assert.equal(requests[0].reasoning_effort, "high");
	assert.equal(Object.hasOwn(requests[1], "reasoning_effort"), false);
});

test("unsupported or malformed effort fails before sending any provider request", async t => {
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => { requests++; return reply(); });
	const unsupported = await stream(model("openai", "gpt-4.1"), context, { reasoningEffort: "high" }).result();
	assert.equal(unsupported.stopReason, "error"); assert.match(unsupported.errorMessage!, /not supported/);
	const malformed = await stream(model(), context, { reasoningEffort: null as any }).result();
	assert.equal(malformed.stopReason, "error"); assert.match(malformed.errorMessage!, /reasoningEffort must/);
	assert.equal(requests, 0);
});

test("unsupported effort is rejected against the logical cloud origin before SSH starts", async () => {
	const target = { ...model("custom", "gpt-6-astra"), baseUrl: "https://api.openai.com/v1", sshHost: "synthetic-host" };
	const response = await stream(target, context, { reasoningEffort: "off" }).result();
	assert.equal(response.stopReason, "error"); assert.match(response.errorMessage!, /not supported/);
});

test("reasoning rejection remains a visible failure instead of silently dropping the setting", async t => {
	const requests: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		requests.push(JSON.parse(init.body as string));
		return Response.json({ error: { param: "reasoning_effort", message: "Unsupported parameter: reasoning_effort" } }, { status: 400 });
	});
	const result = await stream(model(), context, { reasoningEffort: "high" }).result();
	assert.equal(requests.length, 1); assert.equal(requests[0].reasoning_effort, "high");
	assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /reasoning_effort/);
});

test("token and sampling compatibility retries preserve requested effort", async t => {
	const requests: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		requests.push(JSON.parse(init.body as string));
		if (requests.length === 1) return Response.json({ error: { param: "max_tokens", message: "Unsupported parameter max_tokens; use max_completion_tokens" } }, { status: 400 });
		if (requests.length === 2) return Response.json({ error: { param: "temperature", message: "Unsupported parameter temperature" } }, { status: 400 });
		return reply();
	});
	const result = await stream(model("openai", "gpt-5.2"), context, { reasoningEffort: "high", temperature: 0.3 }).result();
	assert.equal(result.stopReason, "stop"); assert.equal(requests.length, 3);
	for (const request of requests) assert.equal(request.reasoning_effort, "high");
	assert.equal(requests[2].max_completion_tokens, 1024); assert.equal(Object.hasOwn(requests[2], "temperature"), false);
});

test("cancellation is preserved before requests and across compatibility retries", async t => {
	const controller = new AbortController(); let count = 0;
	t.mock.method(globalThis, "fetch", async () => { count++; controller.abort(); return Response.json({ error: { param: "stream_options", message: "Unsupported parameter stream_options" } }, { status: 400 }); });
	const result = await stream(model(), context, { reasoningEffort: "low", signal: controller.signal }).result();
	assert.equal(result.stopReason, "aborted"); assert.equal(count, 1);
	const next = await stream(model(), context, { reasoningEffort: "medium", signal: controller.signal }).result();
	assert.equal(next.stopReason, "aborted"); assert.equal(count, 1);
});

test("GPT-6 explicit effort never hides the native-tool protocol incompatibility", async t => {
	let count = 0;
	t.mock.method(globalThis, "fetch", async () => { count++; return reply(); });
	const tools = [{ name: "inspect", description: "Inspect a fixture", parameters: { type: "object" } }];
	const result = await stream(model("openai", "gpt-6-astra"), { ...context, tools }, { reasoningEffort: "low", toolsMode: "native" }).result();
	assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /requires Responses/); assert.equal(count, 0);
	assert.equal((await stream(model("openai", "gpt-6-astra"), { ...context, tools }, { reasoningEffort: "low", toolsMode: "text" }).result()).stopReason, "stop");
	assert.equal(count, 1);
});

async function isolated(fn: (directory: string) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), "rein-reasoning-")), before = process.env.REIN_HOME;
	process.env.REIN_HOME = directory;
	try { await fn(directory); }
	finally { if (before === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = before; rmSync(directory, { recursive: true, force: true }); }
}
test("runner applies saved effort, explicit overrides, and preserves configuration and budgets", async t => isolated(async directory => {
	const config = JSON.stringify({ provider: "custom", baseUrl: "https://fixture.invalid/v1", model: "fixture", reasoningEffort: "medium", maxTurns: 120, maxIterations: 40, operatorProfile: { density: "normal" } });
	writeFileSync(join(directory, "config.json"), config);
	const requests: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { requests.push(JSON.parse(init.body as string)); return reply(); });
	const opts = { cwd: directory, tools: [], systemPrompt: "Fixed system prompt." };
	const saved = await createRunner(opts);
	assert.equal(saved.reasoningEffort, "medium"); assert.equal(saved.model.reasoningEffort, "medium"); assert.equal(saved.maxTurns, 120);
	assert.equal(saved.reasoningControl.mode, "server-dependent");
	await saved.run(context.messages[0]);
	const override = await createRunner({ ...opts, reasoningEffort: "off" });
	await override.run(context.messages[0]);
	const unchanged = await createRunner({ ...opts, reasoningEffort: "default" });
	await unchanged.run(context.messages[0]);
	assert.deepEqual(requests.map(request => request.reasoning_effort), ["medium", "none", undefined]);
	assert.equal(readFileSync(join(directory, "config.json"), "utf8"), config);
}));

test("runner rejects unsupported saved or explicit effort before creating agent work", async () => isolated(async directory => {
	writeFileSync(join(directory, "config.json"), JSON.stringify({ provider: "codex", auth: { type: "cli", provider: "codex" }, reasoningEffort: "high" }));
	await assert.rejects(createRunner({ cwd: directory, tools: [] }), /not supported/);
	const runner = await createRunner({ cwd: directory, tools: [], reasoningEffort: "default" });
	assert.equal(runner.reasoningEffort, "default");
	await assert.rejects(createRunner({ cwd: directory, tools: [], reasoningEffort: "none" as any }), /reasoningEffort must/);
}));
