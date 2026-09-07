import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, symlink, link, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installModelArtifact, listInstalledModels, removeInstalledModel, resolveModelArtifact, verifyInstalledModel } from "../src/models/artifacts.ts";
import type { ModelArtifact, ModelArtifactDependencies } from "../src/models/artifacts.ts";

const repo = "fixture/Tiny-GGUF", filename = "tiny-q4.gguf", revision = "a".repeat(40), token = "hf_fixtureSecret";
const model = Buffer.alloc(128, 0); model.write("GGUF"); model.writeUInt32LE(3, 4);
const hash = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
function metadata(body = model, overrides = {}) { return { sha: revision, siblings: [{ rfilename: filename, size: body.length, lfs: { size: body.length, sha256: hash(body) } }], ...overrides }; }
function response(body: BodyInit = model, init: ResponseInit = {}) { return new Response(body, { status: 200, ...init }); }
function mockFetch(fn: (url: string, options: RequestInit) => Response | Promise<Response>): typeof fetch { return ((url, options) => Promise.resolve(fn(String(url), options ?? {}))) as typeof fetch; }
const roomy = async () => 1024 ** 3;
async function artifact(body = model): Promise<ModelArtifact> { return resolveModelArtifact(repo, filename, {}, { fetch: mockFetch(() => Response.json(metadata(body))) }); }
async function fixture(t: { after(fn: () => Promise<void>): void }) { const home = await realpath(await mkdtemp(join(tmpdir(), "rein-model-"))); t.after(() => rm(home, { recursive: true, force: true })); return home; }
const paths = (home: string, id: string) => { const root = join(home, "models", "artifacts"), dir = join(root, id); return { root, dir, partial: join(dir, "download.part"), final: join(dir, "model.gguf"), manifest: join(dir, "manifest.json"), lock: join(root, `${id}.lock`) }; };
async function partial(home: string, id: string, bytes: Buffer) { const p = paths(home, id); await mkdir(p.dir, { recursive: true, mode: 0o700 }); await writeFile(p.partial, bytes); return p; }
const deps = (body: Buffer = model): ModelArtifactDependencies => ({ fetch: mockFetch(() => response(body, { headers: { "content-length": String(body.length) } })), freeDiskBytes: roomy });

test("Hub metadata resolves the immutable commit and LFS hash with no token in artifact", async () => {
	let called = "";
	const got = await resolveModelArtifact(repo, filename, { revision: "refs/pr/3", token }, { fetch: mockFetch((url, opts) => { called = url; assert.equal(new Headers(opts.headers).get("authorization"), `Bearer ${token}`); return Response.json(metadata()); }) });
	assert.match(called, /\/revision\/refs%2Fpr%2F3\?blobs=true$/); assert.equal(got.revision, revision); assert.equal(got.sha256, hash(model));
	assert.equal(got.url, `https://huggingface.co/${repo}/resolve/${revision}/${filename}`); assert.match(got.id, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(got).includes(token), false);
});
test("repo, file and revision validation happens before network", async () => {
	const network = { fetch: mockFetch(() => { throw new Error("network must not happen"); }) };
	for (const bad of ["../outside", "one", "a/b/c", "a/../c", "a/b?token=secret", "a/b--c"]) await assert.rejects(resolveModelArtifact(bad, filename, {}, network), /repository/);
	for (const bad of ["../x.gguf", "/x.gguf", "a//x.gguf", "a/./x.gguf", "a\\x.gguf", "model.py", "x.gguf?token=secret"]) await assert.rejects(resolveModelArtifact(repo, bad, {}, network), /explicit/);
	await assert.rejects(resolveModelArtifact(repo, "tiny-00001-of-00002.gguf", {}, network), /Split GGUF.*single-file/);
	await assert.rejects(resolveModelArtifact(repo, filename, { revision: "../../other" }, network), /revision/);
});
test("an explicitly pinned commit cannot silently resolve to a different revision", async () => {
	await assert.rejects(resolveModelArtifact(repo, filename, { revision: "b".repeat(40) }, { fetch: mockFetch(() => Response.json(metadata())) }), /explicitly requested model commit/);
});
test("missing hashes, inconsistent sizes and ambiguous metadata fail closed", async () => {
	const valid = metadata();
	for (const bad of [{ ...valid, sha: "main" }, { ...valid, siblings: [] }, { ...valid, siblings: [...valid.siblings, ...valid.siblings] }, { ...valid, siblings: [{ rfilename: filename, size: 128 }] }, { ...valid, siblings: [{ ...valid.siblings[0], size: 12 }] }]) await assert.rejects(resolveModelArtifact(repo, filename, {}, { fetch: mockFetch(() => Response.json(bad)) }));
	await assert.rejects(resolveModelArtifact(repo, filename, {}, { fetch: mockFetch(() => response("<html>oops</html>")) }), /invalid model metadata/);
	await assert.rejects(resolveModelArtifact(repo, filename, {}, { fetch: mockFetch(() => response("x".repeat(4 * 1024 ** 2 + 1))) }), /metadata exceeds/);
});
test("gated model errors explain account access without including response secrets", async () => {
	for (const status of [401, 403]) await assert.rejects(resolveModelArtifact(repo, filename, { token }, { fetch: mockFetch(() => response(token, { status })) }), error => { assert.match(String(error), /authorized token.*access agreement/); assert.equal(String(error).includes(token), false); return true; });
	await assert.rejects(resolveModelArtifact(repo, filename, { token }, { fetch: mockFetch(() => { throw new Error(`https://example.invalid/?secret=${token}`); }) }), error => { assert.equal(String(error).includes(token), false); return true; });
});
test("successful install is private, hash verified, listed and reused without network", async t => {
	const home = await fixture(t), a = await artifact(), progress: number[] = [];
	const installed = await installModelArtifact(a, { home, token, onProgress: received => progress.push(received) }, deps());
	assert.equal(installed.path, paths(home, a.id).final); assert.deepEqual(await readFile(installed.path), model);
	assert.equal((await stat(installed.path)).mode & 0o777, 0o600); assert.equal((await stat(paths(home, a.id).dir)).mode & 0o777, 0o700);
	assert.equal((await readFile(paths(home, a.id).manifest, "utf8")).includes(token), false); assert.deepEqual(progress, [0, model.length]);
	assert.deepEqual(await listInstalledModels({ home }), [installed]); assert.deepEqual(await verifyInstalledModel(a.id, { home }), installed);
	assert.deepEqual(await installModelArtifact(a, { home }, { fetch: mockFetch(() => { throw new Error("must reuse"); }) }), installed);
	assert.equal((await readdir(paths(home, a.id).root)).some(n => n.endsWith(".lock")), false);
});
test("empty stores list without creating directories and invalid IDs cannot traverse", async t => {
	const home = await fixture(t); assert.deepEqual(await listInstalledModels({ home }), []); assert.deepEqual(await readdir(home), []);
	await assert.rejects(verifyInstalledModel("../outside", { home }));
});
test("interrupted downloads preserve bytes and resume with exact Content-Range", async t => {
	const home = await fixture(t), a = await artifact(); let calls = 0;
	await assert.rejects(installModelArtifact(a, { home }, { freeDiskBytes: roomy, fetch: mockFetch(() => response(model.subarray(0, 40))) }), /ended early/);
	assert.deepEqual(await readFile(paths(home, a.id).partial), model.subarray(0, 40));
	const installed = await installModelArtifact(a, { home }, { freeDiskBytes: roomy, fetch: mockFetch((_url, opts) => { calls++; assert.equal(new Headers(opts.headers).get("range"), "bytes=40-"); return response(model.subarray(40), { status: 206, headers: { "content-range": `bytes 40-127/128`, "content-length": "88" } }); }) });
	assert.equal(calls, 1); assert.deepEqual(await readFile(installed.path), model);
});
test("ignored Range restarts cleanly while invalid range cannot append bytes", async t => {
	const home = await fixture(t), a = await artifact(); const p = await partial(home, a.id, model.subarray(0, 40));
	for (const range of ["bytes 0-127/128", "bytes 40-126/128", "bytes 40-127/*", "bytes 40-127/129"]) {
		await assert.rejects(installModelArtifact(a, { home }, { freeDiskBytes: roomy, fetch: mockFetch(() => response(model.subarray(40), { status: 206, headers: { "content-range": range } })) }), /Content-Range/);
		assert.deepEqual(await readFile(p.partial), model.subarray(0, 40));
	}
	await installModelArtifact(a, { home }, deps()); assert.deepEqual(await readFile(p.final), model);
});
test("wrong hash, HTML, unsupported GGUF and oversized data cannot publish a model", async t => {
	const home = await fixture(t);
	for (const kind of ["hash", "html", "magic", "version", "long", "length", "encoding"]) {
		const bytes = Buffer.from(model); if (kind === "hash") bytes[100] = 1; if (kind === "magic") bytes.write("oops"); if (kind === "version") bytes.writeUInt32LE(7, 4);
		const a = await artifact(kind === "magic" || kind === "version" ? bytes : model), headers: Record<string, string> = {};
		if (kind === "html") headers["content-type"] = "text/html"; if (kind === "length") headers["content-length"] = "130"; if (kind === "encoding") headers["content-encoding"] = "gzip";
		await assert.rejects(installModelArtifact(a, { home }, { freeDiskBytes: roomy, fetch: mockFetch(() => response(kind === "long" ? Buffer.concat([bytes, Buffer.from("extra")]) : bytes, { headers })) }));
		assert.deepEqual(await listInstalledModels({ home }), []); await rm(paths(home, a.id).dir, { recursive: true });
	}
});
test("download follows only official HTTPS origins and permanently drops cross-origin auth", async t => {
	const home = await fixture(t), a = await artifact(), seen: Array<[string, string | null]> = [];
	await installModelArtifact(a, { home, token }, { freeDiskBytes: roomy, fetch: mockFetch((url, opts) => {
		seen.push([new URL(url).host, new Headers(opts.headers).get("authorization")]);
		if (seen.length === 1) return response("", { status: 302, headers: { location: "https://cas-bridge.xethub.hf.co/fixture" } });
		if (seen.length === 2) return response("", { status: 302, headers: { location: a.url } });
		return response();
	}) });
	assert.deepEqual(seen.map(([, auth]) => auth), [`Bearer ${token}`, null, null]);
});
test("unsafe redirect destinations are never requested", async t => {
	const home = await fixture(t), a = await artifact();
	for (const location of ["http://huggingface.co/file", "https://evil.invalid/file", "https://huggingface.co.evil.invalid/file", "https://user:secret@huggingface.co/file", "https://127.0.0.1/file", "file:///tmp/model.gguf"]) {
		let calls = 0;
		await assert.rejects(installModelArtifact(a, { home, token }, { freeDiskBytes: roomy, fetch: mockFetch(() => { calls++; return response("", { status: 302, headers: { location } }); }) }), /outside.*Hugging Face/);
		assert.equal(calls, 1);
	}
});
test("insufficient disk space fails before network and leaves prior versions usable", async t => {
	const home = await fixture(t), a = await artifact(); await installModelArtifact(a, { home }, deps());
	const other = Buffer.from(model); other[100] = 7; const next = await artifact(other); let calls = 0;
	await assert.rejects(installModelArtifact(next, { home }, { freeDiskBytes: async () => 1, fetch: mockFetch(() => { calls++; return response(other); }) }), /free disk space/);
	assert.equal(calls, 0); assert.equal((await verifyInstalledModel(a.id, { home })).artifact.sha256, hash(model));
});
test("abort preserves a resumable partial and removes the owned lock", async t => {
	const home = await fixture(t), a = await artifact(), controller = new AbortController();
	await assert.rejects(installModelArtifact(a, { home, signal: controller.signal, onProgress: bytes => { if (bytes) controller.abort(); } }, deps()), /cancelled/);
	assert.deepEqual(await readFile(paths(home, a.id).partial), model); assert.equal((await readdir(paths(home, a.id).root)).some(n => n.endsWith(".lock")), false);
	await installModelArtifact(a, { home }, { fetch: mockFetch(() => { throw new Error("complete partial must not refetch"); }), freeDiskBytes: roomy });
	await verifyInstalledModel(a.id, { home });
});
test("stalled download is bounded and returns no token-bearing transport error", async t => {
	const home = await fixture(t), a = await artifact();
	await assert.rejects(installModelArtifact(a, { home, token }, { stallMs: 20, freeDiskBytes: roomy, fetch: mockFetch((_url, options) => new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener("abort", () => controller.error(new Error(token))); } }))) }), error => { assert.match(String(error), /stalled/); assert.equal(String(error).includes(token), false); return true; });
});
test("concurrent same-model writes reject without deleting the other install lock", async t => {
	const home = await fixture(t), a = await artifact(); let release!: () => void, entered!: () => void;
	const ready = new Promise<void>(r => entered = r), hold = new Promise<void>(r => release = r);
	const first = installModelArtifact(a, { home }, { freeDiskBytes: roomy, fetch: mockFetch(async () => { entered(); await hold; return response(); }) });
	await ready;
	await assert.rejects(installModelArtifact(a, { home }, deps()), /Another install owns/); assert.ok(await stat(paths(home, a.id).lock));
	release(); await first;
});
test("symlink directories, partial files and hard links cannot overwrite external bytes", async t => {
	const home = await fixture(t), a = await artifact(), outside = join(home, "outside"); await mkdir(outside); const kept = join(outside, "keep"); await writeFile(kept, "keep");
	await symlink(outside, join(home, "models")); await assert.rejects(installModelArtifact(a, { home }, deps()), /without symbolic links/); assert.equal(await readFile(kept, "utf8"), "keep"); await rm(join(home, "models"));
	const p = await partial(home, a.id, Buffer.alloc(0)); await rm(p.partial); await symlink(kept, p.partial);
	await assert.rejects(installModelArtifact(a, { home }, deps())); assert.equal(await readFile(kept, "utf8"), "keep"); await rm(p.partial);
	await link(kept, p.partial); await assert.rejects(installModelArtifact(a, { home }, deps()), /without symbolic or hard links/); assert.equal(await readFile(kept, "utf8"), "keep");
});
test("tampered installed files are preserved and rejected on reuse", async t => {
	const home = await fixture(t), a = await artifact(); const installed = await installModelArtifact(a, { home }, deps());
	const changed = Buffer.from(model); changed[100] = 1; await writeFile(installed.path, changed);
	await assert.rejects(verifyInstalledModel(a.id, { home }), /SHA256/); await assert.rejects(installModelArtifact(a, { home }, deps()), /SHA256/);
	assert.deepEqual(await readFile(installed.path), changed);
});
test("a verified final file without manifest is recovered without another download", async t => {
	const home = await fixture(t), a = await artifact(); await installModelArtifact(a, { home }, deps()); await rm(paths(home, a.id).manifest);
	assert.deepEqual(await listInstalledModels({ home }), []);
	await installModelArtifact(a, { home }, { fetch: mockFetch(() => { throw new Error("must recover final"); }) }); assert.equal((await listInstalledModels({ home })).length, 1);
});
test("forged URLs, IDs or paths cannot redirect managed downloads", async t => {
	const home = await fixture(t), a = await artifact();
	for (const patch of [{ id: "../elsewhere" }, { url: "https://evil.invalid/file" }, { revision: "main" }, { file: "../../model.gguf" }, { sha256: "0".repeat(64) }]) await assert.rejects(installModelArtifact({ ...a, ...patch }, { home }, deps()));
	assert.deepEqual(await readdir(home), []);
});
test("removal is scoped to one verified manifest and preserves every other version", async t => {
	const home = await fixture(t), a = await artifact(), other = Buffer.from(model); other[100] = 8;
	const b = await artifact(other); await installModelArtifact(a, { home }, deps()); await installModelArtifact(b, { home }, deps(other));
	await writeFile(join(home, "config.json"), "keep config"); await removeInstalledModel(a.id, { home });
	assert.deepEqual((await listInstalledModels({ home })).map(entry => entry.artifact.id), [b.id]); await verifyInstalledModel(b.id, { home });
	assert.equal(await readFile(join(home, "config.json"), "utf8"), "keep config");
});
test("removal refuses unknown files and links before deleting any bytes", async t => {
	const home = await fixture(t), a = await artifact(); await installModelArtifact(a, { home }, deps()); const p = paths(home, a.id), extra = join(p.dir, "my-notes.md");
	await writeFile(extra, "keep"); await assert.rejects(removeInstalledModel(a.id, { home }), /unexpected files/); assert.deepEqual(await readFile(p.final), model); await rm(extra);
	const outside = join(home, "outside"); await writeFile(outside, "keep"); await symlink(outside, p.partial);
	await assert.rejects(removeInstalledModel(a.id, { home }), /without symbolic or hard links/); assert.equal(await readFile(outside, "utf8"), "keep"); assert.deepEqual(await readFile(p.final), model);
});
