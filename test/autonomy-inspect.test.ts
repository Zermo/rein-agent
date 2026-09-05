import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectionTools } from "../src/harness/autonomy/inspect.ts";

function fixture(t: any) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "rein-autonomy-inspect-")));
	const workspace = join(directory, "workspace");
	const outside = join(directory, "outside");
	mkdirSync(workspace); mkdirSync(outside);
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const tools = inspectionTools(workspace);
	const call = (name: string, args: any, signal?: AbortSignal) => tools.find(tool => tool.name === name)!.execute("test", args, signal);
	return { directory, workspace, outside, call };
}

test("background inspection reads ordinary files and excludes hidden paths, keys and links", async t => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "readme.txt"), "ordinary report text");
	writeFileSync(join(f.outside, "outside.txt"), "OUTSIDE_SECRET");
	for (const name of [".npmrc", ".netrc", ".pypirc", ".env", "credentials.json", "secrets.yaml", "id_rsa", "service.pem", "server.key", "auth.json", "service-account.json"]) writeFileSync(join(f.workspace, name), "PRIVATE_SECRET");
	symlinkSync(join(f.outside, "outside.txt"), join(f.workspace, "file-link"));
	symlinkSync(f.outside, join(f.workspace, "directory-link"));
	linkSync(join(f.outside, "outside.txt"), join(f.workspace, "hard-link"));
	assert.equal((await f.call("read", { path: "readme.txt" })).content, "ordinary report text");
	for (const path of ["../outside/outside.txt", ".npmrc", ".netrc", ".pypirc", ".env", "credentials.json", "secrets.yaml", "id_rsa", "service.pem", "server.key", "auth.json", "service-account.json", "file-link", "directory-link/outside.txt", "hard-link"]) {
		await assert.rejects(f.call("read", { path }), /outside|excluded/);
	}
	assert.doesNotMatch(String((await f.call("ls", {})).content), /\.npmrc|\.env|credentials|secrets|service\.pem|server\.key|auth\.json|service-account|file-link|directory-link|hard-link/);
	assert.equal((await f.call("search", { query: "SECRET" })).content, "No matches in inspected files.");
});

test("inspection rejects replacement of the enrolled root and malformed input", async t => {
	const f = fixture(t);
	await assert.rejects(f.call("read", {}), /workspace-relative/);
	await assert.rejects(f.call("read", { path: 5 }), /workspace-relative/);
	await assert.rejects(f.call("read", { path: "a\0b" }), /workspace-relative/);
	await assert.rejects(f.call("search", { query: "" }), /query/);
	await assert.rejects(f.call("search", { query: "x".repeat(301) }), /query/);
	renameSync(f.workspace, join(f.directory, "original-workspace"));
	symlinkSync(f.outside, f.workspace);
	await assert.rejects(f.call("ls", {}), /workspace directory changed/);
});

test("read and list bound output and reject oversized files", async t => {
	const f = fixture(t);
	writeFileSync(join(f.workspace, "ordinary.txt"), "x".repeat(180000));
	writeFileSync(join(f.workspace, "large.txt"), "x".repeat(200001));
	assert.equal(String((await f.call("read", { path: "ordinary.txt" })).content).length, 15000);
	await assert.rejects(f.call("read", { path: "large.txt" }), /no larger than 200000/);
	for (let i = 0; i < 250; i++) writeFileSync(join(f.workspace, `file-${i}.txt`), "data");
	assert.equal(String((await f.call("ls", {})).content).split("\n").length, 200);
});

test("search applies a total 8 MB read budget and stops after 40 hits", async t => {
	const f = fixture(t);
	for (let i = 0; i < 90; i++) writeFileSync(join(f.workspace, `file-${i}.txt`), "x".repeat(100000));
	const handle = await open(join(f.workspace, "file-0.txt"));
	const prototype = Object.getPrototypeOf(handle);
	const original = prototype.read;
	let total = 0;
	t.mock.method(prototype, "read", async function (this: any, ...args: any[]) {
		const result = await original.apply(this, args);
		total += result.bytesRead;
		return result;
	});
	await handle.close();
	assert.equal((await f.call("search", { query: "absent-query" })).content, "No matches in inspected files.");
	assert.ok(total <= 8 * 1024 * 1024, `read ${total} bytes`);
	assert.ok(total >= 8_000_000, "the search should use the available bounded budget");
	const hits = String((await f.call("search", { query: "xxx" })).content).split("\n");
	assert.equal(hits.length, 40);
});

test("search yields to cancellation after starting filesystem work", async t => {
	const f = fixture(t);
	for (let i = 0; i < 200; i++) writeFileSync(join(f.workspace, `file-${i}.txt`), "report\n".repeat(1000));
	const controller = new AbortController();
	const running = f.call("search", { query: "no match" }, controller.signal);
	const timeout = setTimeout(() => controller.abort(), 0);
	try { await assert.rejects(running, error => (error as Error).name === "AbortError"); }
	finally { clearTimeout(timeout); }
	for (const name of ["read", "ls", "search"]) await assert.rejects(f.call(name, { path: "file-0.txt", query: "report" }, controller.signal), error => (error as Error).name === "AbortError");
});
