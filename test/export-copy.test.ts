import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportFiles, formatBytes, isInside } from "../src/export/copy.ts";

test("export copies a file and leaves the source untouched", async () => {
	const base = await mkdtemp(join(tmpdir(), "export-copy-"));
	const src = join(base, "notes.txt");
	const target = join(base, "out");
	await writeFile(src, "keep me");
	const summary = await exportFiles([src], target);
	assert.equal(summary.files, 1);
	assert.equal(await readFile(join(target, "notes.txt"), "utf8"), "keep me");
	assert.equal(await readFile(src, "utf8"), "keep me", "source must survive");
});

test("export copies a folder tree, preserving structure and skipping symlinks", async () => {
	const base = await mkdtemp(join(tmpdir(), "export-copy-"));
	const docs = join(base, "Documents");
	await mkdir(join(docs, "work"), { recursive: true });
	await writeFile(join(docs, "readme.md"), "hi");
	await writeFile(join(docs, "work", "plan.md"), "plan");
	await symlink(join(docs, "readme.md"), join(docs, "link.md"));
	const target = join(base, "backup");
	const summary = await exportFiles([docs], target);
	assert.equal(summary.files, 2);
	assert.equal(await readFile(join(target, "Documents", "readme.md"), "utf8"), "hi");
	assert.equal(await readFile(join(target, "Documents", "work", "plan.md"), "utf8"), "plan");
	assert.ok(summary.skipped.some(s => s.includes("link.md")));
	assert.ok((await readdir(docs)).includes("link.md"), "source tree must be unchanged");
});

test("export refuses a target inside the source and vice versa", async () => {
	const base = await mkdtemp(join(tmpdir(), "export-copy-"));
	const docs = join(base, "Documents");
	await mkdir(docs, { recursive: true });
	await assert.rejects(() => exportFiles([docs], join(docs, "out")), /inside source/i);
	const outer = await mkdtemp(join(tmpdir(), "export-copy-"));
	const inner = join(outer, "nested");
	await mkdir(inner, { recursive: true });
	await assert.rejects(() => exportFiles([inner], outer), /inside the export target/i);
});

test("isInside resolves relative and absolute paths", () => {
	assert.equal(isInside("/a/b/c", "/a/b"), true);
	assert.equal(isInside("a/b/c", "a/b"), true);
	assert.equal(isInside("/a/b", "/a"), true);
	assert.equal(isInside("/a/bc", "/a/b"), false);
	assert.equal(isInside("b/c", "a"), false);
	assert.equal(isInside("/a", "/a"), false);
});

test("formatBytes keeps human sizes", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(2 ** 10), "1.0 KiB");
	assert.equal(formatBytes(2 ** 30), "1.0 GiB");
});
