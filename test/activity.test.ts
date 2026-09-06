import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { spawn } from "node:child_process";
import { ActivityJournal, activityFile, newActivityId, readActivity } from "../src/harness/activity/store.ts";
import { renderActivity } from "../src/harness/activity/terminal.ts";
import { startCanvas } from "../src/harness/activity/server.ts";
import { createRunner } from "../src/harness/runner.ts";
import { readState, updateState } from "../src/harness/autonomy/state.ts";

async function isolated(fn: (cwd: string) => Promise<void>) {
	const cwd = mkdtempSync(join(tmpdir(), "rein-activity-")), saved = process.env.REIN_HOME;
	process.env.REIN_HOME = cwd;
	try { await fn(cwd); } finally { if (saved === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = saved; rmSync(cwd, { recursive: true, force: true }); }
}

test("live activity records real writes and visible responses without changing model context or including thinking text", async t => isolated(async cwd => {
	const id = newActivityId(); let calls = 0;
	t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string); assert.doesNotMatch(JSON.stringify(body), /REIN \/ ACTIVITY/);
		return Response.json({ choices: [{ message: ++calls === 1 ? { reasoning_content: "PRIVATE_THINKING_SENTINEL", tool_calls: [{ id: "write-fixture", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "output.txt", content: "completed\n" }) } }] } : { content: "The output was written." }, finish_reason: calls === 1 ? "tool_calls" : "stop" }] });
	});
	const runner = await createRunner({ cwd, activityId: id, baseUrlOverride: "http://fixture.invalid/v1", modelOverride: "activity-fixture", toolsMode: "native" });
	const system = runner.systemPrompt;
	await runner.run({ role: "user", content: "Write the output", timestamp: Date.now() });
	const snapshot = readActivity(id)!;
	assert.equal(snapshot.state, "idle"); assert.equal(snapshot.nodes.length, 4); assert.equal(runner.systemPrompt, system);
	const tool = snapshot.nodes.find(node => node.kind === "tool")!;
	assert.equal(tool.title, "write"); assert.equal(tool.path, "output.txt"); assert.equal(tool.status, "done"); assert.equal(tool.parent, snapshot.nodes[1].id);
	assert.equal(readFileSync(join(cwd, "output.txt"), "utf8"), "completed\n");
	assert.doesNotMatch(readFileSync(activityFile(id), "utf8"), /PRIVATE_THINKING_SENTINEL/);
	assert.equal(statSync(activityFile(id)).mode & 0o777, 0o600);
	assert.match(renderActivity(snapshot), /Response/);
	const inline = renderActivity(snapshot, tool.id, 90, 24, "/activity <step> for detail · /help for commands");
	assert.match(inline, /TOOL write/); assert.match(inline, /OPERATOR User request/);
	assert.match(inline, /Input:/); assert.match(inline, /output.txt/);
	assert.match(inline, /\/activity <step>/); assert.doesNotMatch(inline, /canvas|browser|↑↓ select/);
}));

test("activity bounds history and terminal output, and marks interrupted nodes cancelled", async () => isolated(async cwd => {
	const journal = new ActivityJournal(newActivityId(), cwd);
	for (let i = 0; i < 300; i++) journal.event({ type: "message_end", message: { role: "user", content: "\x1b[2J" + "漢".repeat(10000), timestamp: Date.now() } });
	journal.event({ type: "agent_start" });
	journal.event({ type: "tool_execution_start", toolCallId: "running", toolName: "bash", args: { command: "sleep 60" } });
	journal.end(true);
	const snapshot = readActivity(journal.snapshot.id)!;
	assert.ok(snapshot.nodes.length <= 256); assert.ok(snapshot.omitted > 0); assert.ok(statSync(activityFile(snapshot.id)).size < 4 * 1024 * 1024);
	assert.equal(snapshot.state, "cancelled"); assert.equal(snapshot.nodes.at(-1)?.status, "cancelled");
	assert.doesNotMatch(renderActivity(snapshot, snapshot.nodes[0].id), /\x1b/);
	assert.throws(() => new ActivityJournal(snapshot.id, cwd), /EEXIST/);
	assert.throws(() => activityFile("../../secret"), /activity ID/);
}));

test("activity retains an explicit paused state until the next run", async () => isolated(async cwd => {
	const id = newActivityId(), journal = new ActivityJournal(id, cwd);
	const message: any = { role: "assistant", content: [], stopReason: "budget", budget: { kind: "turns", limit: 300, used: 300 }, model: "fixture", provider: "fixture", usage: { input: 0, output: 0, totalTokens: 0 }, timestamp: Date.now() };
	journal.event({ type: "agent_start" }); journal.event({ type: "message_start", message }); journal.event({ type: "message_end", message }); journal.event({ type: "agent_pause", reason: "turn-budget", limit: 300, used: 300 }); journal.event({ type: "agent_end", messages: [message] }); journal.end();
	const snapshot = readActivity(id)!;
	assert.equal(snapshot.state, "paused"); assert.equal(snapshot.nodes.at(-1)?.status, "paused");
	assert.match(renderActivity(snapshot), /paused/); assert.match(snapshot.nodes.at(-1)!.detail, /Reply "continue"/);
	journal.event({ type: "agent_start" }); journal.flush(); assert.equal(readActivity(id)!.state, "working"); journal.end(true);
}));

test("canvas serves only this activity with a local capability token and same-origin checks", async () => isolated(async cwd => {
	const journal = new ActivityJournal(newActivityId(), cwd);
	journal.event({ type: "message_end", message: { role: "user", content: "<script>malicious()</script>", timestamp: Date.now() } }); journal.flush();
	const canvas = await startCanvas(journal.snapshot.id), url = new URL(canvas.url);
	try {
		const page = await fetch(url.origin); assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/); assert.doesNotMatch(await page.text(), /malicious\(\)/);
		assert.equal((await fetch(url.origin + "/events")).status, 401);
		assert.equal((await fetch(url.origin + "/events", { headers: { Authorization: "Bearer " + url.hash.slice(1), Origin: "https://untrusted.invalid" } })).status, 403);
		const foreignHost = await new Promise<number | undefined>((resolve, reject) => { get(url.origin + "/events", { headers: { Host: "untrusted.invalid", Authorization: "Bearer " + url.hash.slice(1) } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject); });
		assert.equal(foreignHost, 403);
		const response = await fetch(url.origin + "/events", { headers: { Authorization: "Bearer " + url.hash.slice(1) } }); assert.equal(response.status, 200); assert.equal((await response.json()).nodes[0].detail, "<script>malicious()</script>");
		assert.equal((await fetch(url.origin + "/events", { method: "POST" })).status, 405);
		writeFileSync(activityFile(journal.snapshot.id), "not json");
		assert.equal((await fetch(url.origin + "/events", { headers: { Authorization: "Bearer " + url.hash.slice(1) } })).status, 500);
	} finally { await canvas.close(); }
}));

test("a successful recovery turn clears the activity error state", async () => isolated(async cwd => {
	const journal = new ActivityJournal(newActivityId(), cwd);
	const response = (error = false): any => ({ role: "assistant", content: [{ type: "text", text: error ? "" : "Recovered" }], stopReason: error ? "error" : "stop", errorMessage: error ? "Context overflow" : undefined, usage: { input: 0, output: 0, totalTokens: 0 }, timestamp: Date.now() });
	journal.event({ type: "agent_start" });
	for (const message of [response(true), response()]) { journal.event({ type: "turn_start" }); journal.event({ type: "message_start", message }); journal.event({ type: "message_end", message }); }
	journal.event({ type: "agent_end", messages: [] }); journal.end();
	assert.equal(readActivity(journal.snapshot.id)?.state, "idle");
	assert.deepEqual(readActivity(journal.snapshot.id)?.nodes.map(node => node.status), ["error", "done"]);
}));

test("the REPL inspects recorded steps in place without starting a provider request", { timeout: 5000 }, async () => isolated(async cwd => {
	const journal = new ActivityJournal(newActivityId(), cwd);
	journal.event({ type: "message_end", message: { role: "user", content: "Summarize my task list", timestamp: Date.now() } });
	journal.event({ type: "tool_execution_start", toolCallId: "read-list", toolName: "read", args: { path: "tasks.txt" } });
	journal.event({ type: "tool_execution_end", toolCallId: "read-list", toolName: "read", result: { content: "Three tasks remain" }, isError: false }); journal.end();
	const source = `import { startRepl } from ${JSON.stringify(new URL("../src/harness/repl.ts", import.meta.url).href)};
const runner = { model: { provider: 'fixture', id: 'fixture' }, toolsMode: 'native', toolsModeSource: 'fixture', context: { messages: [] }, setSession() {}, run() { throw new Error('Unexpected provider call'); } };
await startRepl({ runner, activityId: ${JSON.stringify(journal.snapshot.id)} });`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd, env: { ...process.env, NODETERM_NODE_ID: "", NO_COLOR: "1" } });
	let output = "";
	child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
	const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
	try {
		const done = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
		child.stdin.end("/activity\n/activity 1\n/activity 999\n/quit\n");
		assert.equal(await done, 0, output);
		assert.match(output, /REIN \/ ACTIVITY/); assert.match(output, /TOOL read/); assert.match(output, /Three tasks remain/);
		assert.match(output, /Summarize my task list/); assert.match(output, /Unknown activity step/);
		assert.doesNotMatch(output, /Unexpected provider call|http:\/\/|Opening.*browser/);
	} finally { clearTimeout(timer); child.kill(); }
}));

test("the REPL reviews and controls proposals here, with strict commands and no nested work", { timeout: 5000 }, async () => isolated(async cwd => {
	await updateState(state => {
		state.workspaces = [cwd];
		state.proposals.push({ id: "proposal-fixture", title: "Weekly task review", kind: "routine", workspace: cwd, prompt: "Review the task list and suggest the next small step.", reason: "The operator requested a weekly review.", evidenceIds: ["history-fixture"], intervalMinutes: 10080, status: "pending", allowWrites: false, created: Date.now() });
	});
	const source = `import { startRepl } from ${JSON.stringify(new URL("../src/harness/repl.ts", import.meta.url).href)};
globalThis.fetch = () => { throw new Error('UNEXPECTED_PROVIDER_CALL'); };
const runner = { model: { provider: 'fixture', id: 'fixture' }, toolsMode: 'native', toolsModeSource: 'fixture', context: { messages: [] }, setSession() {}, run() { throw new Error('UNEXPECTED_PROVIDER_CALL'); } };
await startRepl({ runner });`;
	const script = join(cwd, "repl-control-fixture.mjs"); writeFileSync(script, source);
	const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, NODETERM_NODE_ID: "", NO_COLOR: "1", REIN_BASE_URL: "http://fixture.invalid/v1", REIN_MODEL: "fixture" } });
	let output = "";
	child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
	const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
	try {
		const done = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
		child.stdin.end(["/autonomy", "/autonomy show proposal-fixture", "/autonomy approve proposal-fixture", "/autonomy approve proposal-fixture --allow-writes", "/autonomy approve proposal-fixture --allow-writes --extra", "/autonomy scan", "/autonomy run proposal-fixture", "/autonomy tui", "/autonomy dismiss proposal-fixture", "/autonomy pause", "/autonomy resume", "/quit"].join("\n") + "\n");
		assert.equal(await done, 0, output);
		assert.match(output, /\/autonomy show <id> to review here/);
		assert.match(output, /Review the task list and suggest the next small step/);
		assert.match(output, /Enabled for read-only workspace inspection/); assert.match(output, /Enabled with normal Rein tools/);
		assert.equal((output.match(/Usage: \/autonomy/g) ?? []).length, 4);
		assert.match(output, /Proposal dismissed/); assert.match(output, /Autonomy paused/); assert.match(output, /Autonomy resumed/);
		assert.doesNotMatch(output, /UNEXPECTED_PROVIDER_CALL|another terminal|select button|Enter: activate|\[Approve read-only\]/);
		const state = readState(); assert.equal(state.paused, false); assert.equal(state.proposals[0].status, "dismissed"); assert.equal(state.proposals[0].allowWrites, false); assert.equal(state.runs.length, 0);
	} finally { clearTimeout(timer); child.kill(); }
}));

for (const mode of ["streaming", "approval"] as const) test(`autonomy pause is immediate during ${mode} without canceling foreground work`, { timeout: 6000 }, async () => isolated(async cwd => {
	await updateState(state => { state.paused = false; state.workspaces = [cwd]; });
	const release = join(cwd, "release-provider");
	const source = `import { startRepl } from ${JSON.stringify(new URL("../src/harness/repl.ts", import.meta.url).href)};
import { existsSync } from 'node:fs';
Object.defineProperty(process.stdin, 'isTTY', {value:true}); Object.defineProperty(process.stdout, 'isTTY', {value:true});
process.stdin.setRawMode = () => {}; process.stdout.columns = 120;
const message = {role:'assistant',content:[{type:'text',text:'Foreground completed'}],stopReason:'stop',provider:'fixture',model:'fixture',usage:{input:0,output:1,totalTokens:1},timestamp:0};
const runner = { model:{provider:'fixture',id:'fixture'},toolsMode:'native',toolsModeSource:'fixture',tools:[],askTools:[],context:{messages:[]},setSession(){},steer(){throw new Error('PAUSE_BECAME_STEERING');},
async run(_prompt,{onEvent,signal}) {
 onEvent({type:'message_start',message}); process.stderr.write('FOREGROUND_WAITING\\n');
 if (${mode === "approval"}) { if (!await runner.askFallback('write',{})) throw new Error('PAUSE_CONSUMED_APPROVAL'); }
 else while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10));
 if (signal.aborted) throw new Error('FOREGROUND_WAS_CANCELED');
 onEvent({type:'message_update',message,event:{type:'text_delta',delta:'Foreground completed'}}); onEvent({type:'message_end',message});
 process.stderr.write('FOREGROUND_FINISHED\\n');
} };
await startRepl({runner});`;
	const script = join(cwd, "repl-pause-fixture.mjs"); writeFileSync(script, source);
	const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, NODETERM_NODE_ID: "", NO_COLOR: "1", TERM: "xterm" } });
	let output = "";
	child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
	const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
	const until = async (condition: () => boolean) => { const deadline = Date.now() + 2500; while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(condition(), output); };
	try {
		const done = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
		child.stdin.write("work\n");
		await until(() => output.includes(mode === "approval" ? "[y/N]" : "FOREGROUND_WAITING"));
		child.stdin.write("/autonomy pause\n");
		await until(() => readState().paused);
		assert.doesNotMatch(output, /FOREGROUND_FINISHED|PAUSE_BECAME_STEERING|PAUSE_CONSUMED_APPROVAL|FOREGROUND_WAS_CANCELED/);
		if (mode === "approval") { await until(() => output.includes("Tool approval still waiting")); child.stdin.write("yes\n"); }
		else writeFileSync(release, "continue");
		await until(() => output.includes("FOREGROUND_FINISHED"));
		child.stdin.end("/quit\n"); assert.equal(await done, 0, output);
		assert.match(output, /Autonomy paused/); assert.match(output, /Foreground completed/);
		assert.doesNotMatch(output, /PAUSE_BECAME_STEERING|PAUSE_CONSUMED_APPROVAL|FOREGROUND_WAS_CANCELED/);
	} finally { clearTimeout(timer); child.kill(); }
}));
