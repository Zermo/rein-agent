import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { ensureObscura, installObscura, OBSCURA_VERSION, resolveObscura } from "../src/harness/obscura/install.ts";
import type { ObscuraInstallDependencies } from "../src/harness/obscura/install.ts";

const binaries = [{ name: "obscura", bytes: Buffer.from("#!/bin/sh\nprintf 'obscura 0.2.2\\n'\n") }, { name: "obscura-worker", bytes: Buffer.from("#!/bin/sh\nexit 0\n") }];
type Member = { name: string; bytes: Buffer; type?: string };
function tar(members: Member[] = binaries): Buffer {
	const parts: Buffer[] = [];
	for (const member of members) {
		const header = Buffer.alloc(512);
		header.write(member.name, 0, 100); header.write("0000700\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
		header.write(member.bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
		header.fill(32, 148, 156); header.write(member.type ?? "0", 156); header.write("ustar\0", 257); header.write("00", 263);
		const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
		parts.push(header, member.bytes, Buffer.alloc((512 - member.bytes.length % 512) % 512));
	}
	return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
function crc32(bytes: Buffer): number {
	let value = 0xffffffff;
	for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; }
	return (value ^ 0xffffffff) >>> 0;
}
function zip(members: Member[] = binaries.map(file => ({ ...file, name: file.name + ".exe" }))): Buffer {
	const files: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
	for (const member of members) {
		const name = Buffer.from(member.name), compressed = deflateRawSync(member.bytes), checksum = crc32(member.bytes);
		const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(member.bytes.length, 22); local.writeUInt16LE(name.length, 26);
		const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(member.bytes.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE((0o100700 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
		files.push(local, name, compressed); directory.push(entry, name); offset += local.length + name.length + compressed.length;
	}
	const index = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...files, index, end]);
}

async function isolated(run: (home: string) => Promise<void>): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "rein-obscura-install-")), previous = { REIN_HOME: process.env.REIN_HOME, PATH: process.env.PATH };
	process.env.REIN_HOME = home; process.env.PATH = "";
	try { await run(home); }
	finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; rmSync(home, { recursive: true, force: true }); }
}
const currentArchive = () => process.platform === "win32" ? zip() : tar();
const currentName = (name: string) => name + (process.platform === "win32" ? ".exe" : "");
function fixture(home: string, bytes = currentArchive(), platform: string = process.platform, arch: string = process.arch): ObscuraInstallDependencies {
	const format = platform === "win32" ? "zip" : "tar.gz";
	return {
		home, platform, arch, fetch: async () => new Response(bytes),
		manifest: { repository: "https://github.com/h4ckf0r0day/obscura", version: OBSCURA_VERSION, tag: "v0.2.2", commit: "a1e09de68c7617b8079fbb1661b0548c501971c1", variant: "no-render", assets: { [`${platform}-${arch}`]: { filename: `obscura-fixture-no-render.${format}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), format, members: platform === "win32" ? ["obscura.exe", "obscura-worker.exe"] : ["obscura", "obscura-worker"] } } },
	};
}
const versionDirectory = (home: string) => join(home, "native", "obscura", OBSCURA_VERSION);
function noTemporaryInstalls(home: string): void { if (existsSync(versionDirectory(home))) assert.deepEqual(readdirSync(versionDirectory(home)).filter(name => name.startsWith(".install-")), []); }

test("installs the pinned pair privately, reuses it offline, and preserves other versions", async () => isolated(async home => {
	const older = join(home, "native", "obscura", "0.1.0", "keep"); mkdirSync(dirname(older), { recursive: true }); writeFileSync(older, "untouched");
	const archive = currentArchive(), dependencies = fixture(home, archive), messages: string[] = [], requests: string[] = [];
	dependencies.fetch = async (url, options) => { requests.push(String(url)); assert.ok(options?.signal); return new Response(archive, { headers: { "content-length": String(archive.length) } }); };
	const binary = await installObscura({ onProgress: text => messages.push(text) }, dependencies);
	assert.equal(binary, join(versionDirectory(home), `${process.platform}-${process.arch}`, currentName("obscura")));
	for (const file of binaries) assert.deepEqual(readFileSync(join(dirname(binary), currentName(file.name))), file.bytes);
	assert.equal(readFileSync(older, "utf8"), "untouched"); assert.equal(requests.length, 1); assert.match(requests[0], /^https:\/\/github\.com\/h4ckf0r0day\/obscura\/releases\/download\/v0\.2\.2\//);
	assert.ok(messages.some(text => text.includes("SHA-256 verified"))); noTemporaryInstalls(home);
	if (process.platform !== "win32") { assert.equal(statSync(dirname(binary)).mode & 0o777, 0o700); assert.equal(statSync(binary).mode & 0o777, 0o700); assert.equal(statSync(join(dirname(binary), "install.json")).mode & 0o777, 0o600); }
	dependencies.fetch = async () => { throw new Error("Should not download an installed runtime"); };
	assert.equal(await installObscura({}, dependencies), binary); assert.equal(resolveObscura(), binary); assert.equal(await ensureObscura(), binary);
}));

test("absolute overrides never fall back; PATH discovery skips relative entries", async () => isolated(async home => {
	const bin = join(home, "bin"); mkdirSync(bin); const name = process.platform === "win32" ? "obscura.exe" : "obscura";
	const executable = join(bin, name); writeFileSync(executable, binaries[0].bytes, { mode: 0o700 }); process.env.PATH = `.${process.platform === "win32" ? ";" : ":"}${bin}`;
	assert.equal(resolveObscura(), executable); assert.equal(resolveObscura(executable), executable); assert.equal(await ensureObscura({ bin: executable }), executable);
	assert.throws(() => resolveObscura("obscura"), /absolute path/); assert.throws(() => resolveObscura(""), /absolute path/);
	assert.throws(() => resolveObscura(join(home, "missing")), /missing or not executable/);
	await assert.rejects(ensureObscura({ bin: join(home, "missing") }), /missing or not executable/);
	assert.equal(existsSync(versionDirectory(home)), false);
}));

test("a managed install replaces stale PATH selection while explicit overrides still win", async () => isolated(async home => {
	const pathDirectory = join(home, "stale-bin"); mkdirSync(pathDirectory);
	const stale = join(pathDirectory, currentName("obscura")); writeFileSync(stale, "stale binary fixture", { mode: 0o700 }); process.env.PATH = pathDirectory;
	assert.equal(resolveObscura(), stale);
	const managed = await installObscura({}, fixture(home));
	assert.equal(resolveObscura(), managed); assert.equal(await ensureObscura(), managed);
	assert.equal(resolveObscura(stale), stale); assert.equal(await ensureObscura({ bin: stale }), stale);
	assert.equal(readFileSync(stale, "utf8"), "stale binary fixture");
}));

test("concurrent installs publish one complete runtime and clean only their temporary directories", async () => isolated(async home => {
	mkdirSync(versionDirectory(home), { recursive: true }); const foreign = join(versionDirectory(home), ".install-unrelated"); mkdirSync(foreign); writeFileSync(join(foreign, "keep"), "keep");
	const results = await Promise.all([installObscura({}, fixture(home)), installObscura({}, fixture(home))]);
	assert.equal(results[0], results[1]); assert.equal(readFileSync(join(foreign, "keep"), "utf8"), "keep");
	assert.deepEqual(readdirSync(versionDirectory(home)).filter(name => name.startsWith(".install-")), [".install-unrelated"]);
	for (const file of binaries) assert.deepEqual(readFileSync(join(dirname(results[0]), currentName(file.name))), file.bytes);
}));

test("rejects HTTP, declared-size, streamed-size and digest failures without publishing", async t => {
	const archive = currentArchive();
	for (const [name, response, pattern] of [
		["http", () => new Response("not found", { status: 404 }), /HTTP 404/],
		["declared-size", () => new Response(archive, { headers: { "content-length": "999999" } }), /size does not match/],
		["streamed-size", () => new Response(Buffer.concat([archive, Buffer.from("extra")])), /download size limit/],
		["digest", () => new Response(Buffer.alloc(archive.length)), /SHA-256 verification/],
	] as const) await t.test(name, () => isolated(async home => {
		await assert.rejects(installObscura({}, { ...fixture(home, archive), fetch: async () => response() }), pattern);
		assert.equal(resolveObscura(), undefined); noTemporaryInstalls(home);
	}));
});

test("aborts a stalled download, honors its deadline, and cancels its response stream", async t => {
	for (const timeout of [false, true]) await t.test(timeout ? "deadline" : "user cancellation", () => isolated(async home => {
		const controller = new AbortController(); let cancelled = 0;
		const fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array([1])); }, cancel() { cancelled++; } }));
		const timer = timeout ? undefined : setTimeout(() => controller.abort(new Error("fixture cancellation")), 30);
		try { await assert.rejects(installObscura({ signal: controller.signal }, { ...fixture(home), fetch: fetcher, timeoutMs: timeout ? 30 : 1000 }), timeout ? /budget/ : /fixture cancellation/); }
		finally { clearTimeout(timer); }
		assert.equal(cancelled, 1); assert.equal(resolveObscura(), undefined); noTemporaryInstalls(home);
	}));
	await t.test("already cancelled", () => isolated(async home => {
		const controller = new AbortController(); controller.abort(new Error("already cancelled")); let downloads = 0;
		await assert.rejects(installObscura({ signal: controller.signal }, { ...fixture(home), fetch: async () => { downloads++; return new Response(tar()); } }), /already cancelled/);
		assert.equal(downloads, 0); assert.equal(existsSync(versionDirectory(home)), false);
	}));
});

test("tar extraction rejects unexpected paths, links, duplicates, missing files and expansion limits", async t => {
	const cases: [string, Buffer, number | undefined][] = [
		["traversal", tar([{ ...binaries[0], name: "../../outside" }, binaries[1]]), undefined],
		["symlink", tar([{ ...binaries[0], type: "2" }, binaries[1]]), undefined],
		["duplicate", tar([binaries[0], binaries[0], binaries[1]]), undefined],
		["missing-worker", tar([binaries[0]]), undefined],
		["oversized-output", tar(), 1024],
	];
	for (const [name, archive, limit] of cases) await t.test(name, () => isolated(async home => {
		await assert.rejects(installObscura({}, { ...fixture(home, archive, "linux", "x64"), maxExtractedBytes: limit }), /archive|extraction/);
		assert.equal(resolveObscura(), undefined); assert.equal(existsSync(join(home, "outside")), false); noTemporaryInstalls(home);
	}));
});

test("cancellation from download progress never starts a rejected fetch or leaves an unhandled rejection", async () => isolated(async home => {
	const controller = new AbortController(); let downloads = 0;
	const fetcher: typeof fetch = async (_url, options) => {
		downloads++;
		if (options?.signal?.aborted) throw new Error("fetch rejected a pre-aborted signal");
		return new Response(currentArchive());
	};
	await assert.rejects(installObscura({ signal: controller.signal, onProgress: message => { if (message.startsWith("Downloading")) controller.abort(new Error("cancel at download start")); } }, { ...fixture(home), fetch: fetcher }), /cancel at download start/);
	await new Promise(resolveResult => setImmediate(resolveResult));
	assert.equal(downloads, 0); assert.equal(resolveObscura(), undefined); noTemporaryInstalls(home);
}));

test("cancellation after download does not publish or leave executable fragments", async () => isolated(async home => {
	const controller = new AbortController();
	await assert.rejects(installObscura({ signal: controller.signal, onProgress: message => { if (message.includes("verified")) controller.abort(new Error("cancel before extraction")); } }, fixture(home)), /cancel before extraction/);
	assert.equal(resolveObscura(), undefined); noTemporaryInstalls(home);
}));

test("Windows ZIP installs exactly the pair and rejects unsafe or truncated archives", async t => {
	await t.test("valid", () => isolated(async home => {
		const binary = await installObscura({}, fixture(home, zip(), "win32", "x64"));
		assert.equal(binary, join(versionDirectory(home), "win32-x64", "obscura.exe"));
		for (const file of binaries) assert.deepEqual(readFileSync(join(dirname(binary), file.name + ".exe")), file.bytes);
		noTemporaryInstalls(home);
	}));
	for (const [name, archive] of [["unexpected-name", zip([{ ...binaries[0], name: "../escape.exe" }, { ...binaries[1], name: "obscura-worker.exe" }])], ["truncated", zip().subarray(0, -10)]] as const) await t.test(name, () => isolated(async home => {
		await assert.rejects(installObscura({}, fixture(home, archive, "win32", "x64")), /ZIP/); noTemporaryInstalls(home);
	}));
});

test("unsupported platforms and incomplete installs give actionable errors without overwriting data", async () => isolated(async home => {
	await assert.rejects(installObscura({}, { ...fixture(home), platform: "freebsd" }), /OBSCURA_BIN.*absolute/);
	const incomplete = join(versionDirectory(home), `${process.platform}-${process.arch}`); mkdirSync(incomplete, { recursive: true }); writeFileSync(join(incomplete, "keep"), "user data");
	await assert.rejects(installObscura({}, fixture(home)), /incomplete.*Move that directory aside/s);
	assert.equal(readFileSync(join(incomplete, "keep"), "utf8"), "user data"); assert.equal(resolveObscura(), undefined); noTemporaryInstalls(home);
}));
