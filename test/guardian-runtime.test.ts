import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { headlessRuntimePlan, installHeadlessRuntime, runRuntimeArchiveCommand, verifyHeadlessRuntime } from "../src/harness/autonomy/guardian-runtime.ts";
import type { HardwareProfile } from "../src/hardware/profile.ts";

const hardware = (os = process.platform as string, arch = "x64"): HardwareProfile => ({ os, arch, cpu: { name: "fixture", cores: 4, physicalCores: 2, features: [] }, ram: { totalBytes: 16 * 2 ** 30, availableBytes: 12 * 2 ** 30 }, gpus: [], unifiedMemory: false });
function fixture(t: { after: (fn: () => void) => void }) {
	const home = mkdtempSync(join(tmpdir(), "rein-runtime-test-")), before = process.env.REIN_HOME;
	process.env.REIN_HOME = home;
	t.after(() => { if (before === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = before; rmSync(home, { recursive: true, force: true }); });
	return home;
}
type Member = { path: string; data?: string; type?: string; link?: string; mode?: number };
/** Tiny USTAR fixtures exercise the actual system tar without any runtime download. */
function archive(members: Member[]): Buffer {
	const chunks: Buffer[] = [];
	for (const member of members) {
		const header = Buffer.alloc(512), data = Buffer.from(member.data ?? "");
		const text = (offset: number, length: number, value: string) => header.write(value, offset, length, "utf8");
		const octal = (offset: number, length: number, value: number) => text(offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
		text(0, 100, member.path); octal(100, 8, member.mode ?? 0o644); octal(108, 8, 1000); octal(116, 8, 1000); octal(124, 12, data.length); octal(136, 12, 0);
		text(148, 8, "        "); text(156, 1, member.type ?? "0"); text(157, 100, member.link ?? ""); text(257, 6, "ustar\0"); text(263, 2, "00");
		text(148, 8, [...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ");
		chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
	}
	chunks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(chunks));
}
const executable: Member = { path: "ollama", data: "#!/bin/sh\nexit 0\n", mode: 0o755 };
function dependencies(body: Buffer) {
	const artifact = { ...headlessRuntimePlan(hardware("darwin"))!, downloadBytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
	return { artifact, download: async function* () { yield body.subarray(0, 11); yield body.subarray(11); } };
}
function deps(body: Buffer) { const options = dependencies(body); return { artifact: options.artifact, download: async () => options.download() }; }
function clean(home: string) { assert.equal(readdirSync(join(home, "autonomy")).some(name => name.startsWith(".guardian-runtime-")), false); }

test("runtime plans pin official headless assets and unsupported systems have no install plan", () => {
	const mac = headlessRuntimePlan(hardware("darwin", "arm64"))!;
	assert.equal(mac.version, "0.33.3"); assert.equal(mac.downloadBytes, 159236337); assert.equal(mac.executableRelative, "ollama");
	assert.match(mac.url, /^https:\/\/github.com\/ollama\/ollama\/releases\/download\/v0\.33\.3\/ollama-darwin\.tgz$/);
	assert.equal(headlessRuntimePlan(hardware("linux"))!.downloadBytes, 1433825108);
	assert.equal(headlessRuntimePlan(hardware("linux", "arm64"))!.downloadBytes, 1554076220);
	assert.match(headlessRuntimePlan(hardware("linux"))!.prerequisites.join(" "), /zstd/);
	assert.equal(headlessRuntimePlan(hardware("win32")), undefined); assert.equal(headlessRuntimePlan(hardware("linux", "riscv64")), undefined);
	for (const plan of [mac, headlessRuntimePlan(hardware("linux"))!, headlessRuntimePlan(hardware("linux", "arm64"))!]) assert.match(plan.sha256, /^[a-f0-9]{64}$/);
});
test("valid headless archive publishes a private runtime with internal links and verified cache reuse", async t => {
	const home = fixture(t);
	const body = archive([executable, { path: "lib/", type: "5", mode: 0o755 }, { path: "lib/runtime.so", data: "library", mode: 0o755 }, { path: "lib/current.so", type: "2", link: "runtime.so" }, { path: "lib/shared.so", type: "1", link: "lib/runtime.so" }]);
	const options = deps(body), path = await installHeadlessRuntime(hardware(), {}, options);
	assert.equal(path, join(home, "autonomy", "guardian-runtime", "ollama")); assert.equal(readFileSync(path, "utf8"), executable.data);
	assert.equal(statSync(path).mode & 0o777, 0o700); assert.equal(statSync(join(home, "autonomy", "guardian-runtime")).mode & 0o777, 0o700);
	const again = await installHeadlessRuntime(hardware(), {}, { ...options, download: async () => { throw new Error("cache must not download"); }, command: async () => { throw new Error("cache must not extract"); } });
	assert.equal(again, path); clean(home);
	// Changing even a supporting library invalidates reuse and preserves its bytes.
	const library = join(home, "autonomy", "guardian-runtime", "lib", "runtime.so"); writeFileSync(library, "changed");
	await assert.rejects(installHeadlessRuntime(hardware(), {}, options), /preserved.*integrity mismatch/);
	assert.equal(readFileSync(library, "utf8"), "changed"); clean(home);
});
test("Linux zstd archive layout and extraction flags work with the installed tar", async t => {
	const home = fixture(t);
	let body: Buffer;
	try { body = execFileSync("zstd", ["-q", "-c"], { input: gunzipSync(archive([{ path: "bin/", type: "5", mode: 0o755 }, { ...executable, path: "bin/ollama" }])), maxBuffer: 1024 ** 2 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("zstd is not installed; installation correctly requires it on Linux"); return; } throw error; }
	const artifact = { ...headlessRuntimePlan(hardware("linux"))!, downloadBytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
	const calls: string[][] = [];
	const path = await installHeadlessRuntime(hardware("linux"), {}, { artifact, download: async () => (async function* () { yield body; })(), command: async (command, args, options) => { calls.push([command, ...args]); return runRuntimeArchiveCommand(command, args, options); } });
	assert.equal(path, join(home, "autonomy", "guardian-runtime", "bin", "ollama"));
	assert.ok(calls.some(call => call[0] === "zstd" && call[1] === "--version"));
	assert.ok(calls.some(call => call[1] === "--zstd" && call[2] === "-xkf")); clean(home);
});
test("wrong digest, short or oversized downloads never invoke extraction", async t => {
	const home = fixture(t), body = archive([executable]);
	for (const kind of ["digest", "short", "long"]) {
		const options = deps(body), calls: string[][] = [];
		if (kind === "digest") options.artifact.sha256 = "0".repeat(64);
		if (kind === "short") options.artifact.downloadBytes++;
		if (kind === "long") options.artifact.downloadBytes--;
		await assert.rejects(installHeadlessRuntime(hardware(), {}, { ...options, command: async (_command, args) => { calls.push(args); return "fixture tar"; } }), /pinned (SHA256\/size|size)/);
		assert.deepEqual(calls, [["--version"]]); assert.equal(existsSync(join(home, "autonomy", "guardian-runtime")), false); clean(home);
	}
});
test("archive path traversal, reserved names and duplicate writes fail before extraction", async t => {
	const home = fixture(t);
	for (const members of [
		[executable, { path: "../escape", data: "bad" }], [executable, { path: "/absolute-escape", data: "bad" }],
		[executable, executable], [executable, { path: ".rein-runtime.json", data: "bad" }],
		[executable, { path: "bad\\name", data: "bad" }], [executable, { path: "bad\nname", data: "bad" }],
	]) {
		const body = archive(members), calls: string[][] = [];
		await assert.rejects(installHeadlessRuntime(hardware(), {}, { ...deps(body), command: async (command, args, opts) => { calls.push(args); return runRuntimeArchiveCommand(command, args, opts); } }));
		assert.equal(calls.some(args => args.includes("-xkf")), false); clean(home);
	}
	assert.equal(existsSync(join(home, "escape")), false);
});
test("outside symlinks, link pivots, devices and wrong executables cannot become usable runtimes", async t => {
	const home = fixture(t), outside = join(home, "outside"); mkdirSync(outside); writeFileSync(join(outside, "kept"), "keep");
	for (const members of [
		[executable, { path: "escape", type: "2", link: outside }],
		[executable, { path: "pivot", type: "2", link: outside }, { path: "pivot/kept", data: "overwrite" }],
		[executable, { path: "outside-hardlink", type: "1", link: join(outside, "kept") }],
		[executable, { path: "pipe", type: "6" }],
		[{ path: "other", data: "wrong", mode: 0o755 }],
		[{ path: "ollama", data: "not executable" }],
	]) {
		await assert.rejects(installHeadlessRuntime(hardware(), {}, deps(archive(members))));
		assert.equal(readFileSync(join(outside, "kept"), "utf8"), "keep"); assert.equal(existsSync(join(home, "autonomy", "guardian-runtime")), false); clean(home);
	}
});
test("an unowned or symlink runtime cache is preserved before any download", async t => {
	const home = fixture(t), runtime = join(home, "autonomy", "guardian-runtime"); mkdirSync(runtime, { recursive: true }); writeFileSync(join(runtime, "kept"), "unowned");
	const options = { ...deps(archive([executable])), download: async () => { throw new Error("must not download"); } };
	await assert.rejects(installHeadlessRuntime(hardware(), {}, options), /preserved/); assert.equal(readFileSync(join(runtime, "kept"), "utf8"), "unowned");
	await assert.rejects(verifyHeadlessRuntime(hardware()), /preserved/);
	rmSync(runtime, { recursive: true }); const outside = join(home, "outside"); mkdirSync(outside); symlinkSync(outside, runtime);
	await assert.rejects(installHeadlessRuntime(hardware(), {}, options), /preserved/); assert.deepEqual(readdirSync(outside), []);
});
test("missing extraction prerequisites fail before network and canceled downloads clean staging", async t => {
	const home = fixture(t), body = archive([executable]); let network = 0;
	await assert.rejects(installHeadlessRuntime(hardware(), {}, { ...deps(body), command: async () => { throw new Error("missing tar fixture"); }, download: async () => { network++; throw new Error(); } }), /needs.*tar/);
	assert.equal(network, 0);
	const controller = new AbortController();
	await assert.rejects(installHeadlessRuntime(hardware(), { signal: controller.signal }, { ...deps(body), download: async () => (async function* () { yield body.subarray(0, 4); controller.abort(); yield body.subarray(4); })() }));
	assert.equal(existsSync(join(home, "autonomy", "guardian-runtime")), false); clean(home);
});
test("tar subprocess cancellation kills descendants before staging can be removed", async t => {
	const home = fixture(t), marker = join(home, "late-write"), script = join(home, "group.mjs"), ready = join(home, "ready"), controller = new AbortController();
	writeFileSync(script, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; process.on('SIGTERM',()=>{}); spawn(process.execPath,['-e',${JSON.stringify(`process.on('SIGTERM',()=>{}); setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'leaked'),1800); setInterval(()=>{},1000);`)}],{stdio:'ignore'}); writeFileSync(${JSON.stringify(ready)},'ready'); setInterval(()=>{},1000);`);
	const command = runRuntimeArchiveCommand(process.execPath, [script], { signal: controller.signal, timeoutMs: 10_000 });
	for (let attempt = 0; !existsSync(ready) && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
	assert.ok(existsSync(ready)); controller.abort(); await assert.rejects(command, /cancelled/);
	await new Promise(resolve => setTimeout(resolve, 1000)); assert.equal(existsSync(marker), false);
});
