import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyKlaudPatch, DEFAULT_KLAUD_SHELL, klaudShellPath, loadKlaudShell, saveKlaudShell } from "../src/harness/klaud/shell.ts";
import type { JsonPatchOp, KlaudShell } from "../src/harness/klaud/shell.ts";
import { klaudPrompt } from "../src/harness/klaud/prompt.ts";
import { createKlaudTools } from "../src/harness/klaud/tools.ts";

function fixture(t: test.TestContext): string {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "rein-klaud-shell-")));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

test("empty home loads an independent default shell without creating files", (t) => {
	const home = fixture(t);
	const shell = loadKlaudShell(home);
	assert.deepEqual(shell, DEFAULT_KLAUD_SHELL);
	assert.notEqual(shell, DEFAULT_KLAUD_SHELL);
	shell.theme.dark = false;
	assert.equal(loadKlaudShell(home).theme.dark, true);
	assert.deepEqual(readdirSync(home), []);
});

test("shell patches set dark and tray without changing the input", () => {
	const before = structuredClone(DEFAULT_KLAUD_SHELL);
	const next = applyKlaudPatch(before, [
		{ op: "replace", path: "/theme/dark", value: false },
		{ op: "add", path: "/chrome/tray", value: "quiet" },
	]);
	assert.equal(next.theme.dark, false);
	assert.equal(next.chrome.tray, "quiet");
	assert.deepEqual(before, DEFAULT_KLAUD_SHELL);
	assert.notEqual(next.theme, before.theme);
	assert.notEqual(next.chrome, before.chrome);
});

test("shell patches reject version, unknown, nested, and escaped pointers", () => {
	for (const path of ["/version", "/theme/unknown", "/theme", "/chrome/tray/child", "/theme/~1dark", "/theme/__proto__", "/chrome/constructor", "theme/dark"]) {
		assert.throws(() => applyKlaudPatch(DEFAULT_KLAUD_SHELL, [{ op: "replace", path, value: false }]), /path|pointer/i);
	}
});

test("failed test operations do not mutate or save an earlier patch", async (t) => {
	const home = fixture(t);
	saveKlaudShell(DEFAULT_KLAUD_SHELL, home);
	const before = readFileSync(klaudShellPath(home), "utf8");
	const shell = loadKlaudShell(home);
	const patch: JsonPatchOp[] = [
		{ op: "replace", path: "/theme/dark", value: false },
		{ op: "test", path: "/chrome/tray", value: "quiet" },
	];
	assert.throws(() => applyKlaudPatch(shell, patch), /test/i);
	assert.deepEqual(shell, DEFAULT_KLAUD_SHELL);
	const tool = createKlaudTools(home).find(tool => tool.name === "klaud_patch_shell")!;
	const result = await tool.execute("fixture-call", { patch });
	assert.equal(result.isError, true);
	assert.equal(typeof result.content, "string");
	assert.equal(readFileSync(klaudShellPath(home), "utf8"), before);
	assert.deepEqual(readdirSync(join(home, "klaud")), ["shell.json"]);
});

test("shell operations obey required fields and final schema", () => {
	assert.deepEqual(applyKlaudPatch(DEFAULT_KLAUD_SHELL, [{ op: "test", path: "/theme/dark", value: true }]), DEFAULT_KLAUD_SHELL);
	assert.throws(() => applyKlaudPatch(DEFAULT_KLAUD_SHELL, [{ op: "remove", path: "/theme/dark" }]), /required|remove/i);
	assert.throws(() => applyKlaudPatch(DEFAULT_KLAUD_SHELL, [
		{ op: "remove", path: "/theme/dark" }, { op: "add", path: "/theme/dark", value: true },
	]), /required|remove/i);
	assert.throws(() => applyKlaudPatch(DEFAULT_KLAUD_SHELL, [{ op: "remove", path: "/chrome/tray" }]), /schema|tray|required/i);
	assert.equal(applyKlaudPatch(DEFAULT_KLAUD_SHELL, [
		{ op: "remove", path: "/chrome/tray" }, { op: "add", path: "/chrome/tray", value: "hidden" },
	]).chrome.tray, "hidden");
	assert.throws(() => applyKlaudPatch(DEFAULT_KLAUD_SHELL, [
		{ op: "remove", path: "/chrome/tray" }, { op: "replace", path: "/chrome/tray", value: "hidden" },
	]), /exist|missing/i);
	for (const patch of [
		[{ op: "replace", path: "/theme/accent", value: "blue" }],
		[{ op: "replace", path: "/theme/density", value: "wide" }],
		[{ op: "replace", path: "/theme/dark", value: "false" }],
		[{ op: "add", path: "/chrome/sidebar", value: 0 }],
		[{ op: "replace", path: "/chrome/showActivity", value: null }],
		[{ op: "replace", path: "/chrome/tray", value: "loud" }],
		[{ op: "replace", path: "/theme/dark" }],
		[{ op: "move", path: "/theme/dark", value: true }],
		[null],
		null,
	]) assert.throws(() => applyKlaudPatch(DEFAULT_KLAUD_SHELL, patch as JsonPatchOp[]));
});

test("persistence respects REIN_HOME and writes private files atomically", (t) => {
	const base = fixture(t);
	const home = join(base, "nested", "home");
	const previous = process.env.REIN_HOME;
	process.env.REIN_HOME = home;
	t.after(() => { if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous; });
	assert.equal(klaudShellPath(), join(home, "klaud", "shell.json"));
	assert.equal(klaudShellPath(base), join(base, "klaud", "shell.json"));
	saveKlaudShell(DEFAULT_KLAUD_SHELL);
	assert.deepEqual(loadKlaudShell(), DEFAULT_KLAUD_SHELL);
	assert.equal(statSync(home).mode & 0o777, 0o700);
	assert.equal(statSync(join(home, "klaud")).mode & 0o777, 0o700);
	assert.equal(statSync(klaudShellPath()).mode & 0o777, 0o600);
	chmodSync(klaudShellPath(), 0o644);
	const next = applyKlaudPatch(DEFAULT_KLAUD_SHELL, [{ op: "replace", path: "/theme/accent", value: "storm" }]);
	saveKlaudShell(next);
	assert.equal(statSync(klaudShellPath()).mode & 0o777, 0o600);
	assert.deepEqual(loadKlaudShell(), next);
	assert.deepEqual(readdirSync(join(home, "klaud")), ["shell.json"]);
});

test("malformed persisted shells fail without overwriting data", (t) => {
	const home = fixture(t);
	mkdirSync(join(home, "klaud"));
	for (const raw of ["{broken", '{"version":2}', JSON.stringify({ ...DEFAULT_KLAUD_SHELL, unexpected: true })]) {
		writeFileSync(klaudShellPath(home), raw);
		assert.throws(() => loadKlaudShell(home));
		assert.equal(readFileSync(klaudShellPath(home), "utf8"), raw);
	}
	const before = readFileSync(klaudShellPath(home), "utf8");
	assert.throws(() => saveKlaudShell({ ...DEFAULT_KLAUD_SHELL, version: 2 } as unknown as KlaudShell, home));
	assert.equal(readFileSync(klaudShellPath(home), "utf8"), before);
});

test("persistence refuses symlink files, dangling links, and linked parent directories", (t) => {
	const base = fixture(t);
	const target = join(base, "target.json");
	writeFileSync(target, "preserve");
	for (const dangling of [false, true]) {
		const home = join(base, dangling ? "dangling" : "file-link");
		mkdirSync(join(home, "klaud"), { recursive: true });
		symlinkSync(dangling ? join(base, "missing.json") : target, klaudShellPath(home));
		assert.throws(() => saveKlaudShell(DEFAULT_KLAUD_SHELL, home), /symlink|symbolic link/i);
		assert.throws(() => loadKlaudShell(home), /symlink|symbolic link/i);
	}
	const outside = join(base, "outside");
	mkdirSync(outside);
	const linkedHome = join(base, "linked-home");
	symlinkSync(outside, linkedHome, "dir");
	const parentHome = join(base, "parent-home");
	mkdirSync(parentHome);
	symlinkSync(outside, join(parentHome, "klaud"), "dir");
	for (const home of [linkedHome, parentHome]) {
		assert.throws(() => saveKlaudShell(DEFAULT_KLAUD_SHELL, home), /symlink|symbolic link/i);
		assert.throws(() => loadKlaudShell(home), /symlink|symbolic link/i);
	}
	assert.equal(readFileSync(target, "utf8"), "preserve");
	assert.equal(existsSync(join(base, "missing.json")), false);
	assert.deepEqual(readdirSync(outside), []);
});

test("klaud tools return JSON strings and persist valid patches", async (t) => {
	const home = fixture(t);
	const tools = createKlaudTools(home);
	assert.deepEqual(tools.map(tool => tool.name), ["klaud_get_shell", "klaud_patch_shell"]);
	const read = await tools[0].execute("fixture-read", {});
	assert.deepEqual(JSON.parse(read.content), DEFAULT_KLAUD_SHELL);
	assert.equal(existsSync(klaudShellPath(home)), false);
	const write = await tools[1].execute("fixture-write", { patch: [{ op: "replace", path: "/chrome/tray", value: "quiet" }] });
	assert.notEqual(write.isError, true);
	assert.deepEqual(JSON.parse(write.content), loadKlaudShell(home));
	assert.equal(loadKlaudShell(home).chrome.tray, "quiet");
	assert.equal((await tools[1].execute("fixture-invalid", {})).isError, true);
});

test("klaud prompt names the shell, every allowed pointer, and source approval under 1200 bytes", () => {
	const prompt = klaudPrompt(DEFAULT_KLAUD_SHELL);
	assert.match(prompt, /rein-klaʊd/);
	for (const path of ["/theme/accent", "/theme/density", "/theme/dark", "/chrome/sidebar", "/chrome/tray", "/chrome/showActivity"]) assert.ok(prompt.includes(path));
	assert.match(prompt, /source.*approval/i);
	assert.ok(Buffer.byteLength(prompt, "utf8") < 1200);
});
