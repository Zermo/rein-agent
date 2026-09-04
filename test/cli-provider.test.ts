import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cliArguments, cliAuthDirectory, cliEnvironment, streamCli } from "../src/ai/cli-provider.ts";
import { checkCliAuth, loginCli } from "../src/harness/auth.ts";
import type { Model } from "../src/ai/types.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rein-cli-test-")); const executable = join(root, "fake cli"); const log = join(root, "calls.jsonl");
	writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const row = {args,cwd:process.cwd(),codexHome:process.env.CODEX_HOME,copilotHome:process.env.COPILOT_HOME,apiKey:process.env.OPENAI_API_KEY};
fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify(row)+'\\n');
if(args[0]==='--version') { console.log('test CLI 1.0'); process.exit(0); }
if(args[0]==='login') { process.exit(process.env.FAKE_FAIL_LOGIN ? 1 : 0); }
if(process.env.FAKE_MODE==='hang') { setInterval(()=>{},1000); }
else if(process.env.FAKE_MODE==='native') { console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}})); setInterval(()=>{},1000); }
else if(process.env.FAKE_MODE==='big') { process.stdout.write('x'.repeat(20000)); }
else if(process.env.FAKE_MODE==='fail') { console.log('<tool name="bash">{"command":"bad"}</tool>'); console.error('not logged in'); process.exit(2); }
else if(args[0]==='exec') {
 let input=''; process.stdin.on('data',s=>input+=s); process.stdin.on('end',()=>{
  fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({input})+'\\n');
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'I will inspect it.\\n<tool name="read">{\"path\":\"README.md\"}</tool>'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:8}}));
 });
} else {
 const agent=fs.readFileSync('.github/agents/rein-bridge.agent.md','utf8');
 if(!agent.includes('tools: []')) process.exit(3);
 let input=''; process.stdin.on('data',s=>input+=s); process.stdin.on('end',()=>{fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({input})+'\\n'); console.log('Copilot answer');});
}
`, { mode: 0o700 });
	const options = { executable, env: { REIN_HOME: root, FAKE_LOG: log, OPENAI_API_KEY: "must-not-be-inherited" } };
	return { root, executable, log, options, rows: () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const model = (provider: "codex" | "copilot"): Model => ({ id: "default", provider, baseUrl: `cli://${provider}`, contextWindow: 64000, maxTokens: 4096 });
const context = { systemPrompt: "Rein system", messages: [{ role: "user" as const, content: 'check $(touch /not-executed) "quoted"', timestamp: 1 }], tools: [{ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }] };

test("Codex bridge uses isolated auth, stdin, bounded JSON events and Rein tools", async () => {
	const f = fixture();
	try {
		const message = await streamCli(model("codex"), context, f.options).result();
		assert.equal(message.stopReason, "toolUse"); assert.equal(message.usage.totalTokens, 20);
		assert.equal(message.content.find(part => part.type === "toolCall")?.name, "read");
		const [run, input] = f.rows();
		assert.equal(run.codexHome, join(f.root, "cli-auth", "codex")); assert.equal(run.apiKey, undefined);
		assert.ok(run.args.includes("--ignore-user-config")); assert.ok(run.args.includes("--ignore-rules")); assert.ok(run.args.includes("features.shell_tool=false")); assert.ok(run.args.includes("features.plugins=false"));
		assert.ok(!run.args.includes("--model")); assert.ok(!run.args.join(" ").includes("check $("));
		assert.match(input.input, /Rein system/); assert.match(input.input, /\$\(touch/);
		assert.notEqual(run.cwd, process.cwd());
	} finally { f.cleanup(); }
});

test("Copilot bridge uses tools-empty custom agent and explicit tool denials", async () => {
	const f = fixture();
	try {
		const message = await streamCli({ ...model("copilot"), id: "selected-model" }, context, f.options).result();
		assert.equal(message.stopReason, "stop"); assert.equal(message.content[0].type, "text");
		const run = f.rows()[0]; assert.ok(!run.args.includes("--prompt")); assert.match(f.rows()[1].input, /Rein system/); assert.ok(run.args.includes("--disable-builtin-mcps")); assert.ok(run.args.includes("--no-custom-instructions"));
		assert.ok(run.args.includes("selected-model")); assert.equal(run.copilotHome, join(f.root, "cli-auth", "copilot"));
	} finally { f.cleanup(); }
});

test("failed CLI output never becomes executable Rein tool calls", async () => {
	const f = fixture();
	try {
		const result = await streamCli(model("codex"), context, { ...f.options, env: { ...f.options.env, FAKE_MODE: "fail" } }).result();
		assert.equal(result.stopReason, "error"); assert.equal(result.content.length, 0); assert.match(result.errorMessage!, /rein login codex/);
	} finally { f.cleanup(); }
});

test("CLI transport cancellation, timeout and oversized output settle with errors", async () => {
	const f = fixture();
	try {
		const abort = new AbortController(); const pending = streamCli(model("codex"), context, { ...f.options, env: { ...f.options.env, FAKE_MODE: "hang" }, signal: abort.signal }).result();
		setTimeout(() => abort.abort(), 40); assert.equal((await pending).stopReason, "aborted");
		const timeout = await streamCli(model("codex"), context, { ...f.options, env: { ...f.options.env, FAKE_MODE: "hang" }, timeoutMs: 40 }).result(); assert.match(timeout.errorMessage!, /timed out/);
		const big = await streamCli(model("codex"), context, { ...f.options, env: { ...f.options.env, FAKE_MODE: "big" }, maxOutputBytes: 1000 }).result(); assert.match(big.errorMessage!, /size limit/);
	} finally { f.cleanup(); }
});

test("CLI missing binary errors include the official install and login commands", async () => {
	const f = fixture();
	try {
		const missing = { ...f.options, executable: join(f.root, "missing") };
		const message = await streamCli(model("codex"), context, missing).result(); assert.match(message.errorMessage!, /npm install -g @openai\/codex/);
		const login = await loginCli("codex", { ...missing, openBrowser: false }); assert.equal(login.ok, false); assert.match(login.detail, /rein login codex/);
	} finally { f.cleanup(); }
});

test("official device/browser login uses argv and isolated profiles without token access", async () => {
	const f = fixture();
	try {
		assert.equal((await loginCli("codex", { ...f.options, openBrowser: false })).ok, true);
		assert.equal((await loginCli("copilot", { ...f.options, openBrowser: false })).ok, true);
		assert.equal((await loginCli("copilot", { ...f.options, deviceAuth: false, openBrowser: false })).ok, true);
		assert.deepEqual(f.rows().map(row => row.args), [["login", "--device-auth"], ["login", "--device-code"], ["login", "--web-flow"]]);
	} finally { f.cleanup(); }
});

test("noninteractive auth checks never start login or a model request", async () => {
	const f = fixture();
	try {
		const codex = await checkCliAuth("codex", f.options); assert.equal(codex.authenticated, true);
		const copilot = await checkCliAuth("copilot", f.options); assert.equal(copilot.available, true); assert.equal(copilot.authenticated, null);
		assert.equal((await loginCli("copilot", { ...f.options, interactive: false, openBrowser: false })).ok, false);
		assert.deepEqual(f.rows().map(row => row.args), [["--version"], ["login", "status"], ["--version"]]);
	} finally { f.cleanup(); }
});

test("Copilot rejects oversized context and custom profile code", async () => {
	const f = fixture();
	try {
		const huge = await streamCli(model("copilot"), { messages: [{ role: "user", content: "x".repeat(8_000_001), timestamp: 1 }] }, f.options).result(); assert.match(huge.errorMessage!, /transport size limit/);
		const profile = cliAuthDirectory("copilot", f.options.env); mkdirSync(join(profile, "plugins"));
		const customized = await streamCli(model("copilot"), context, f.options).result(); assert.match(customized.errorMessage!, /custom plugins/);
	} finally { f.cleanup(); }
});


test("subscription environment strips Copilot BYOK endpoint overrides", () => {
	const env = cliEnvironment("copilot", { COPILOT_PROVIDER_BASE_URL: "https://other.example", COPILOT_PROVIDER_API_KEY: "secret", COPILOT_PROVIDER_TYPE: "openai", ANTHROPIC_API_KEY: "key", GH_ENTERPRISE_TOKEN: "enterprise", GH_CONFIG_DIR: "/not-user-gh" });
	assert.equal(env.COPILOT_PROVIDER_BASE_URL, undefined); assert.equal(env.COPILOT_PROVIDER_API_KEY, undefined); assert.equal(env.COPILOT_PROVIDER_TYPE, undefined); assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.GH_ENTERPRISE_TOKEN, undefined); assert.notEqual(env.GH_CONFIG_DIR, "/not-user-gh"); assert.ok(env.GH_CONFIG_DIR?.endsWith("cli-auth/copilot/gh"));
});


test("native Codex tool attempts cancel the bridge without Rein execution", async () => {
	const f = fixture();
	try {
		const message = await streamCli(model("codex"), context, { ...f.options, env: { ...f.options.env, FAKE_MODE: "native" } }).result();
		assert.equal(message.stopReason, "error"); assert.match(message.errorMessage!, /native tool/); assert.equal(message.content.length, 0);
	} finally { f.cleanup(); }
});
