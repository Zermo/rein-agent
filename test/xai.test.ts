import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROK_BRIDGE_CONFIG, grokEvent, grokOutput, grokDeviceLoginUrl, prepareGrokProfile, xaiLanguageModelIds } from "../src/ai/xai.ts";
import { cliAuthDirectory, cliEnvironment, streamCli } from "../src/ai/cli-provider.ts";
import { checkCliAuth, loginCli } from "../src/harness/auth.ts";
import { resolveModel, apiKeyFor } from "../src/ai/models.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rein-grok-test-"));
	const executable = join(root, "fake-grok");
	const log = join(root, "calls.jsonl");
	writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({args, cwd:process.cwd(), grokHome:process.env.GROK_HOME, apiKey:process.env.XAI_API_KEY})+'\\n');
if(args[0]==='--version') { console.log('grok 1.0.13'); process.exit(0); }
if(args[0]==='login') process.exit(0);
const path = args[args.indexOf('--prompt-file')+1];
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({input:fs.readFileSync(path,'utf8')})+'\\n');
const emit = value => console.log(JSON.stringify(value));
if(process.env.FAKE_MODE==='native') { emit({sessionUpdate:'tool_call',toolCallId:'one',title:'bad native tool'}); setInterval(()=>{},1000); }
else if(process.env.FAKE_MODE==='bad') { console.log('<tool name="bash">{"command":"no"}</tool>'); }
else if(process.env.FAKE_MODE==='fail') { emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'<tool name="bash">{"command":"no"}</tool>'}}); process.exit(2); }
else if(process.env.FAKE_MODE==='thinking') { emit({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'private reasoning'}}); }
else if(process.env.FAKE_MODE==='hang') { setInterval(()=>{},1000); }
else {
 emit({type:'available_commands',tools:['run_terminal_command','kill_command_or_subagent','get_command_or_subagent_output'],commands:[]});
 emit({type:'thinking',data:'not surfaced'});
 emit({type:'text',data:'I will inspect it.\\n'});
 emit({type:'text',data:'<tool name="read">{"path":"README.md"}</tool>'});
 emit({type:'end',stopReason:'end_turn',usage:{input_tokens:20,output_tokens:10,reasoning_tokens:4}});
}
`, { mode: 0o700 });
	return { root, log, options: { executable, env: { REIN_HOME: root, FAKE_LOG: log, XAI_API_KEY: "must-not-inherit" } }, rows: () => readFileSync(log, "utf8").trim().split("\n").map(row => JSON.parse(row)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const model = { id: "default", provider: "grok", baseUrl: "cli://grok", contextWindow: 32000, maxTokens: 4096 };
const context = { systemPrompt: "Rein system", messages: [{ role: "user" as const, content: 'check $(touch /not-executed) "quotes"', timestamp: 1 }] };

test("xAI language discovery selects only models accepting and producing text", () => {
	assert.deepEqual(xaiLanguageModelIds({ models: [
		{ id: "grok-chat-fixture", input_modalities: ["text", "image"], output_modalities: ["text"] },
		{ id: "image-fixture", input_modalities: ["text"], output_modalities: ["image"] },
		{ id: "voice-fixture", input_modalities: ["audio"], output_modalities: ["text"] },
		{ id: "grok-chat-fixture", input_modalities: ["text"], output_modalities: ["text"] },
		null, "arbitrary-model", { id: "unknown-modalities" },
	] }), ["grok-chat-fixture"]);
	assert.equal(xaiLanguageModelIds({ data: [] }), undefined);
	assert.deepEqual(xaiLanguageModelIds({ models: [] }), []);
});

test("Grok subscription strips routing/credential overrides and compatibility scanners", () => {
	const env = cliEnvironment("grok", { GROK_HOME: "/other-profile", XAI_API_KEY: "key", GROK_OIDC_ISSUER: "https://other.example", GROK_AUTH_PROVIDER_COMMAND: "bad", GROK_MODELS_BASE_URL: "https://other.example", GROK_CLAUDE_HOOKS_ENABLED: "1", REIN_HOME: "/rein-fixture" });
	assert.equal(env.GROK_HOME, "/rein-fixture/cli-auth/grok");
	for (const name of ["XAI_API_KEY", "GROK_OIDC_ISSUER", "GROK_AUTH_PROVIDER_COMMAND", "GROK_MODELS_BASE_URL"]) assert.equal(env[name], undefined);
	assert.equal(env.GROK_MEMORY, "0"); assert.equal(env.GROK_DISABLE_AUTOUPDATER, "1");
	assert.equal(env.GROK_CLAUDE_HOOKS_ENABLED, "0"); assert.equal(env.GROK_CURSOR_MCPS_ENABLED, "0");
});

test("Grok bridge uses a private prompt file, isolated auth and no native tools", async () => {
	const f = fixture();
	try {
		const result = await streamCli(model, context, f.options).result();
		assert.equal(result.stopReason, "toolUse");
		assert.equal(result.content.find(part => part.type === "toolCall")?.name, "read");
		assert.ok(!JSON.stringify(result.content).includes("not surfaced"));
		const [run, input] = f.rows();
		assert.equal(run.grokHome, cliAuthDirectory("grok", f.options.env)); assert.equal(run.apiKey, undefined);
		assert.ok(run.args[run.args.indexOf("--disallowed-tools") + 1].includes("read_file"));
		assert.equal(result.usage.reasoning, 4); assert.equal(result.usage.totalTokens, 30);
		assert.equal(run.args[run.args.indexOf("--permission-mode") + 1], "dontAsk");
		assert.equal(run.args[run.args.indexOf("--deny") + 1], "*");
		assert.ok(!run.args.join(" ").includes("$(touch")); assert.match(input.input, /\$\(touch/);
		assert.equal(existsSync(run.cwd), false);
		assert.equal(readFileSync(join(run.grokHome, "config.toml"), "utf8"), GROK_BRIDGE_CONFIG);
	} finally { f.cleanup(); }
});

test("Grok bridge refuses native tools, invalid events, failed output and thought-only replies", async () => {
	const f = fixture();
	try {
		for (const mode of ["native", "bad", "fail", "thinking"]) {
			const result = await streamCli(model, context, { ...f.options, env: { ...f.options.env, FAKE_MODE: mode } }).result();
			assert.equal(result.stopReason, "error", mode); assert.equal(result.content.length, 0, mode);
		}
	} finally { f.cleanup(); }
});

test("Grok bridge timeout and cancellation clean their private prompt files", async () => {
	const f = fixture();
	try {
		const timeout = await streamCli(model, context, { ...f.options, env: { ...f.options.env, FAKE_MODE: "hang" }, timeoutMs: 80 }).result();
		assert.match(timeout.errorMessage!, /timed out/);
		const abort = new AbortController();
		const pending = streamCli(model, context, { ...f.options, env: { ...f.options.env, FAKE_MODE: "hang" }, signal: abort.signal }).result();
		setTimeout(() => abort.abort(), 80);
		assert.equal((await pending).stopReason, "aborted");
		for (const row of f.rows().filter(row => row.cwd)) assert.equal(existsSync(row.cwd), false);
	} finally { f.cleanup(); }
});

test("Grok login delegates official device/browser auth; status never starts authentication", async () => {
	const f = fixture();
	try {
		assert.equal((await loginCli("grok", { ...f.options, openBrowser: false })).ok, true);
		assert.equal((await loginCli("grok", { ...f.options, deviceAuth: false, openBrowser: false })).ok, true);
		const status = await checkCliAuth("grok", f.options);
		assert.equal(status.available, true); assert.equal(status.authenticated, null);
		assert.deepEqual(f.rows().map(row => row.args), [["login", "--device-auth"], ["login", "--device-auth"], ["--version"]]);
	} finally { f.cleanup(); }
});

test("Grok bridge preserves and rejects custom profile code and system policy", () => {
	const f = fixture();
	try {
		const profile = join(f.root, "profile"); const system = join(f.root, "system");
		prepareGrokProfile(profile, system);
		mkdirSync(join(profile, "hooks")); prepareGrokProfile(profile, system);
		const hook = join(profile, "hooks", "user.json"); writeFileSync(hook, "{}");
		assert.throws(() => prepareGrokProfile(profile, system), /custom hooks/); assert.equal(readFileSync(hook, "utf8"), "{}");
		rmSync(hook);
		writeFileSync(join(profile, "config.toml"), "[model.custom]\napi_key='example'\n");
		assert.throws(() => prepareGrokProfile(profile, system), /custom config.toml/);
		mkdirSync(system); writeFileSync(join(system, "requirements.toml"), "# managed");
		assert.throws(() => prepareGrokProfile(profile, system), /system-managed/);
	} finally { f.cleanup(); }
});

test("Grok event parser supports raw and wrapped ACP updates without exposing thought content", () => {
	const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } };
	for (const shape of [update, { update }, { method: "session/update", params: { update } }]) assert.equal(grokEvent(JSON.stringify(shape)).text, "hello");
	assert.deepEqual(grokEvent(JSON.stringify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private" } })), { thinking: true });
	assert.throws(() => grokEvent(JSON.stringify({ method: "session/request_permission", params: {} })), /native tool/);
	assert.throws(() => grokEvent(JSON.stringify({ sessionUpdate: "agent_message_chunk", content: { type: "image" } })), /unsupported assistant/);
	assert.throws(() => grokEvent(JSON.stringify({ error: { message: "secret-provider-details" } })), /Grok request failed/);
	assert.throws(() => grokEvent(JSON.stringify({ type: "end", stopReason: "max_turn_requests" })), /did not complete/);
});

test("Grok subscription resolves independently from a configured HTTP API", async () => {
	const f = fixture(); const previous = process.env.REIN_HOME;
	try {
		process.env.REIN_HOME = f.root;
		writeFileSync(join(f.root, "config.json"), JSON.stringify({ provider: "custom", baseUrl: "http://model-host.example:1234/v1", model: "api-fixture", apiKey: "api-fixture-key" }));
		const resolved = await resolveModel({ provider: "grok" }); assert.equal(resolved.baseUrl, "cli://grok"); assert.equal(resolved.id, "default");
		assert.equal(apiKeyFor("grok"), undefined);
		await assert.rejects(resolveModel({ provider: "grok", baseUrl: "http://model-host.example:1234/v1" }), /cannot be combined/);
	} finally { if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous; f.cleanup(); }
});


test("Grok opens only official printed device links, and rejects partial output", () => {
 assert.equal(grokDeviceLoginUrl("Sign in at https://auth.x.ai/device then enter your code."), "https://auth.x.ai/device");
 assert.equal(grokDeviceLoginUrl("https://auth.x.ai.attacker.example/device"), undefined);
 assert.equal(grokDeviceLoginUrl("https://user@auth.x.ai/device"), undefined);
 assert.equal(grokDeviceLoginUrl("http://auth.x.ai/device"), undefined);
 assert.throws(() => grokOutput(JSON.stringify({type:"text",data:"partial <tool name=read>{}</tool>"})), /did not confirm completion/);
 assert.throws(() => grokEvent(JSON.stringify({type:"available_commands",tools:["new_native_tool"]})), /unexpected native tools/);
});


test("Grok cannot accept content after completion or an unrelated success-shaped event", () => {
 const end=JSON.stringify({type:"end",stopReason:"end_turn"});
 const text=JSON.stringify({type:"text",data:'<tool name="bash">{"command":"no"}</tool>'});
 assert.throws(() => grokOutput(end+"\n"+text), /after its completion/);
 assert.throws(() => grokOutput(end+"\n"+end), /after its completion/);
 assert.throws(() => grokOutput(JSON.stringify({type:"unrelated",stopReason:"end_turn"})), /unknown event/);
 assert.deepEqual(grokOutput("\n \n"+text+"\n"+end).text, '<tool name="bash">{"command":"no"}</tool>');
 assert.equal(grokEvent(JSON.stringify({jsonrpc:"2.0",id:1,result:{stopReason:"end_turn"}})).done,true);
});
