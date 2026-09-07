import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelConnection, runModelServer, servingPlan } from "../src/models/runtime.ts";
import type { HardwareProfile } from "../src/hardware/profile.ts";
import type { InstalledModel } from "../src/models/artifacts.ts";

const id = "a".repeat(64), GiB = 1024 ** 3;
const machine: HardwareProfile = { os: "linux", arch: "x64", cpu: { name: "Fixture", cores: 8, physicalCores: 8, features: [] }, ram: { totalBytes: 32 * GiB, availableBytes: 24 * GiB }, gpus: [], unifiedMemory: false };
const installed = (home: string): InstalledModel => ({ artifact: { schemaVersion: 1, id, repo: "fixture/model", revision: "b".repeat(40), file: "tiny.gguf", sha256: "c".repeat(64), sizeBytes: 128, url: "https://huggingface.co/fixture/model" }, path: join(home, "model.gguf"), installedAt: "2026-09-07T00:00:00Z" });
async function port(): Promise<number> { const server = createServer(); await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const n = (server.address() as any).port; await new Promise<void>(r => server.close(() => r())); return n; }
const fixtureSource = `
import {createServer} from 'node:http';
const args=process.argv.slice(2), flag=name=>args[args.indexOf(name)+1];
const mode=process.env.FIXTURE_MODE, key=process.env.LLAMA_API_KEY;
console.log('credential: '+key);
const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.headers.authorization!=='Bearer '+key){res.statusCode=401;res.end('{}');return;}
  if(req.url==='/health'){if(mode==='loading')res.statusCode=503;res.end(JSON.stringify({status:'ok'}));return;}
  if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:mode==='bad-model'?'other':flag('--alias')}]}));return;}
  let text='';for await(const chunk of req)text+=chunk;
  const body=JSON.parse(text);if(body.model!==flag('--alias')){res.statusCode=400;res.end('{}');return;}
  res.end(JSON.stringify({choices:[{message:mode==='reasoning'?{reasoning_content:'fixture reasoning'}:{content:mode==='bad-chat'?'':'hello'},finish_reason:'stop'}]}));
});
server.listen(Number(flag('--port')),'127.0.0.1');
process.on('SIGTERM',()=>{if(mode!=='stubborn')server.close(()=>process.exit(0));});
`;
async function fixture(t: any, mode = "good") {
	const home = await mkdtemp(join(tmpdir(), "rein-model-runtime-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const script = join(home, "server.mjs"); await writeFile(script, fixtureSource);
	const log: string[] = []; let pid: number | undefined;
	return { home, log, get pid() { return pid; }, deps: { verify: async () => installed(home), hardware: async () => machine, spawn: ((_command: string, args: string[], options: any) => {
		assert.equal(options.shell, false); assert.equal(options.env.REIN_API_KEY, undefined); assert.equal(options.env.HF_TOKEN, undefined);
		const child = spawn(process.execPath, [script, ...args], { ...options, env: { ...options.env, FIXTURE_MODE: mode } }); pid = child.pid; return child;
	}) as typeof spawn } };
}
test("serving plans keep one sequence, loopback, explicit offload and literal argv", () => {
	const plan = servingPlan(installed("/fixture/with spaces"), { runtime: "/fixture/llama server", context: 8192 });
	assert.ok(plan.args.includes("127.0.0.1")); assert.ok(plan.args.includes("--no-webui"));
	assert.equal(plan.args[plan.args.indexOf("--parallel") + 1], "1");
	assert.equal(plan.gpuLayers, 0); assert.ok(plan.args.includes("/fixture/with spaces/model.gguf"));
	assert.equal(JSON.stringify(plan).includes("apiKey"), false);
	for (const options of [{ port: 80 }, { context: 0 }, { gpuLayers: -1 }, { runtime: "./relative/llama" }]) assert.throws(() => servingPlan(installed("/fixture"), options));
});
test("owned server readiness creates a private connection; cancellation drains the process and removes ready state", { timeout: 10000 }, async t => {
	const f = await fixture(t), controller = new AbortController(), serverPort = await port();
	let notify!: () => void; const ready = new Promise<void>(r => notify = r);
	const running = runModelServer(id, { home: f.home, port: serverPort, context: 8192, signal: controller.signal, onReady: () => notify(), log: line => f.log.push(line) }, f.deps);
	try {
		await ready;
		const connection = await readModelConnection(id, { home: f.home });
		assert.equal(connection.baseUrl, `http://127.0.0.1:${serverPort}/v1`); assert.equal(connection.context, 8192);
		assert.match(connection.apiKey, /^[a-f0-9]{64}$/); assert.ok(!f.log.join(" ").includes(connection.apiKey));
		await assert.rejects(readModelConnection(id, { home: f.home, port: serverPort === 65535 ? serverPort - 1 : serverPort + 1 }), /does not match/);
		let spawns = 0;
		await assert.rejects(runModelServer(id, { home: f.home, port: await port() }, { ...f.deps, spawn: (() => { spawns++; throw new Error("must not spawn"); }) as typeof spawn }), /serving owner/);
		assert.equal(spawns, 0);
	} finally { controller.abort(); await running; }
	await assert.rejects(readModelConnection(id, { home: f.home }), /not ready/);
	assert.throws(() => process.kill(f.pid!, 0), { code: "ESRCH" });
	assert.deepEqual((await readdir(join(f.home, "models", "connections"))).filter(n => !n.endsWith(".key")), []);
});
test("readiness accepts bounded reasoning replies and kills a stubborn owned child", { timeout: 10000 }, async t => {
	for (const mode of ["reasoning", "stubborn"]) {
		const f = await fixture(t, mode), controller = new AbortController();
		await runModelServer(id, { home: f.home, port: await port(), signal: controller.signal, onReady: () => controller.abort() }, f.deps);
		assert.throws(() => process.kill(f.pid!, 0), { code: "ESRCH" });
	}
});
test("bad model identity, empty completions and loading timeouts never publish readiness", { timeout: 10000 }, async t => {
	for (const mode of ["bad-model", "bad-chat", "loading"]) {
		const f = await fixture(t, mode); let ready = false;
		await assert.rejects(runModelServer(id, { home: f.home, port: await port(), readyTimeoutMs: mode === "loading" ? 150 : 2000, onReady: () => { ready = true; } }, f.deps));
		assert.equal(ready, false); assert.throws(() => process.kill(f.pid!, 0), { code: "ESRCH" });
		await assert.rejects(readModelConnection(id, { home: f.home }), /not ready/);
	}
});
test("port collisions and unverified memory fail before creating a serving process", async t => {
	const f = await fixture(t), listener = createServer();
	await new Promise<void>(r => listener.listen(0, "127.0.0.1", r)); let spawns = 0;
	const deps = { ...f.deps, spawn: (() => { spawns++; throw new Error("must not spawn"); }) as typeof spawn };
	try { await assert.rejects(runModelServer(id, { home: f.home, port: (listener.address() as any).port }, deps), /already in use/); }
	finally { await new Promise<void>(r => listener.close(() => r())); }
	for (const availableBytes of [NaN, 100]) await assert.rejects(runModelServer(id, { home: f.home }, { ...deps, hardware: async () => ({ ...machine, ram: { ...machine.ram, availableBytes } }) }), /memory|Memory/);
	assert.equal(spawns, 0);
});
test("missing executable reports failure and releases its lease", { timeout: 5000 }, async t => {
	const f = await fixture(t);
	await assert.rejects(runModelServer(id, { home: f.home, port: await port(), runtime: join(f.home, "absent") }, { verify: f.deps.verify, hardware: f.deps.hardware }), /Cannot start model runtime/);
	assert.deepEqual((await readdir(join(f.home, "models", "connections"))).filter(n => !n.endsWith(".key")), []);
});
test("partial offload and ambiguous GPU memory cannot satisfy a whole-model preflight", { timeout: 5000 }, async t => {
	const f = await fixture(t), model = installed(f.home);
	model.artifact = { ...model.artifact, repo: "fixture/Qwen3-4B-GGUF", sizeBytes: 3 * GiB };
	const gpu = { name: "Fixture GPU", vramTotalBytes: 16 * GiB, vramFreeBytes: 12 * GiB };
	const hardware = { ...machine, ram: { totalBytes: 8 * GiB, availableBytes: 2 * GiB }, gpus: [gpu] };
	const deps = { ...f.deps, verify: async () => model, hardware: async () => hardware };
	for (const gpuLayers of [0, 1, 36]) await assert.rejects(runModelServer(id, { home: f.home, gpuLayers }, deps), /Memory preflight/);
	for (const gpus of [[gpu, gpu], [{ ...gpu, vramFreeBytes: NaN }]]) await assert.rejects(runModelServer(id, { home: f.home, gpuLayers: 999 }, { ...deps, hardware: async () => ({ ...hardware, gpus }) }), /Memory preflight/);
	assert.equal(f.pid, undefined);
	if (["CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "GGML_VK_VISIBLE_DEVICES"].some(name => process.env[name] !== undefined)) {
		await assert.rejects(runModelServer(id, { home: f.home, gpuLayers: 999 }, deps), /Memory preflight/);
		return;
	}
	const controller = new AbortController();
	await runModelServer(id, { home: f.home, port: await port(), gpuLayers: 999, signal: controller.signal, onReady: () => controller.abort() }, deps);
	assert.throws(() => process.kill(f.pid!, 0), { code: "ESRCH" });
});
