import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { sshArguments, withSshTunnel } from "../src/ai/ssh.ts";
import { stream } from "../src/ai/openai-completions.ts";
import { checkConfiguredProvider, usesLocalHardware } from "../src/harness/doctor.ts";

test("SSH forwarding arguments are loopback-only and cannot contain shell options", () => {
	const args = sshArguments("user@dgx", "http://127.0.0.1:18083/v1", 32345);
	assert.ok(args.includes("127.0.0.1:32345:127.0.0.1:18083"));
	assert.deepEqual(args.slice(-2), ["--", "user@dgx"]);
	assert.ok(args.includes("BatchMode=yes"));
	for (const invalid of ["-oProxyCommand=evil", "dgx;echo bad", "dgx\nproxy", "dgx other"]) assert.throws(() => sshArguments(invalid, "http://localhost:1", 32345));
	assert.throws(() => sshArguments("dgx", "https://localhost:1", 32345), /http/);
});

const proxyScript = `const net=require('node:net'); const target=process.argv[1]; const parts=target.split(':'); const server=net.createServer(socket=>{const upstream=net.connect(Number(parts[3]),parts[2]); upstream.on('error',()=>socket.destroy()); socket.on('error',()=>upstream.destroy()); socket.pipe(upstream).pipe(socket);}); server.listen(Number(parts[1]),parts[0]);`;

test("managed tunnel forwards requests, preserves path, and closes after success or callback error", { timeout: 10000 }, async () => {
	const server = createServer((_req, res) => res.end("tunnel works"));
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const target = `http://127.0.0.1:${(server.address() as any).port}/prefix/v1`;
	try {
		for (const fail of [false, true]) {
			let child: ReturnType<typeof spawn> | undefined;
			let forwarded = "";
			const run = withSshTunnel(target, "dgx", async url => {
				forwarded = url;
				assert.equal(new URL(url).pathname, "/prefix/v1");
				assert.equal(await (await fetch(`${url}/models`)).text(), "tunnel works");
				if (fail) throw new Error("callback failed");
				return "done";
			}, { spawnSsh: args => child = spawn(process.execPath, ["-e", proxyScript, args[args.indexOf("-L") + 1]], { stdio: ["ignore", "ignore", "pipe"] }) });
			if (fail) await assert.rejects(run, /callback failed/);
			else assert.equal(await run, "done");
			assert.ok(child?.exitCode !== null || child?.signalCode !== null);
			await assert.rejects(fetch(`${forwarded}/models`));
		}
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("missing SSH executable and canceled startup fail promptly", { timeout: 5000 }, async () => {
	await assert.rejects(withSshTunnel("http://127.0.0.1:18083/v1", "dgx", async () => assert.fail("must not run"), {
		spawnSsh: () => spawn("/does-not-exist/rein-test-ssh", [], { stdio: "pipe" }),
	}), /Cannot open SSH tunnel/);
	const controller = new AbortController();
	let child: ReturnType<typeof spawn> | undefined;
	const result = withSshTunnel("http://127.0.0.1:18083/v1", "dgx", async () => assert.fail("must not run"), {
		signal: controller.signal,
		spawnSsh: () => { child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "pipe" }); controller.abort(); return child; },
	});
	await assert.rejects(result, /aborted/i);
	assert.ok(child?.exitCode !== null || child?.signalCode !== null);
});

test("SSH setup failure is encoded as a terminal provider stream error", async () => {
	const result = await stream({ id: "fixture", provider: "custom", baseUrl: "http://127.0.0.1:18083/v1", sshHost: "-invalid", contextWindow: 32768, maxTokens: 32 }, { messages: [] }).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /SSH host/);
});

test("doctor only compares hardware on the machine actually serving the model", async () => {
	for (const baseUrl of ["http://10.250.158.81:18083/v1", "http://192.168.1.2:1234/v1", "http://100.64.1.2:8000/v1", "https://localhost.example/v1", "cli://codex"]) assert.equal(usesLocalHardware({ baseUrl }), false);
	assert.equal(usesLocalHardware({ baseUrl: "http://127.0.0.1:18083/v1", sshHost: "dgx" }), false);
	assert.equal(usesLocalHardware({ baseUrl: "http://localhost:1234/v1" }), true);
	assert.equal(usesLocalHardware({ baseUrl: "http://[::1]:1234/v1" }), true);
	const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "model-other" }] })); });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const check = await checkConfiguredProvider({ provider: "custom", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, model: "model" });
		assert.equal(check.status, "warn");
		assert.equal(check.autoFix, undefined);
		assert.doesNotMatch(check.fix!, /ollama/);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("doctor reports a stale API prefix even when another prefix lists the model", async () => {
	const server = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url !== "/models") { res.writeHead(404); res.end("{}"); return; }
		res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const check = await checkConfiguredProvider({ provider: "custom", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, model: "fixture" });
		assert.equal(check.status, "fail");
		assert.match(check.detail, /saved endpoint/);
		assert.equal(check.autoFix, undefined);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
