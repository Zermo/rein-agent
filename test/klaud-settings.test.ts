import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_KLAUD_RUN_SETTINGS, loadKlaudRunSettings, saveKlaudRunSettings, validateRunSettingsPatch } from "../src/harness/klaud/settings.ts";

function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "rein-klaud-settings-")), home = join(root, "rein-home"), directory = join(home, "klaud"), file = join(directory, "run-settings.json");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, home, directory, file };
}
function seed(f: ReturnType<typeof fixture>, text: string) { mkdirSync(f.directory, { recursive: true, mode: 0o700 }); writeFileSync(f.file, text, { mode: 0o600 }); }

test("missing desktop run settings use fresh defaults without creating files", t => {
	const f = fixture(t), settings = loadKlaudRunSettings(f.home);
	assert.deepEqual(settings, { bashApproval: "auto", reasoningEffort: "default" }); assert.equal(existsSync(f.home), false);
	settings.bashApproval = "ask"; settings.reasoningEffort = "high";
	assert.deepEqual(loadKlaudRunSettings(f.home), DEFAULT_KLAUD_RUN_SETTINGS, "callers cannot mutate the shared default object through a loaded value");
});

test("first save creates private owned settings and survives reopening", t => {
	const f = fixture(t);
	const saved = saveKlaudRunSettings({ bashApproval: "ask", reasoningEffort: "medium" }, f.home);
	assert.deepEqual(saved, { bashApproval: "ask", reasoningEffort: "medium" }); assert.deepEqual(loadKlaudRunSettings(f.home), saved);
	assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), saved); assert.equal(lstatSync(f.file).isFile(), true);
	assert.deepEqual(readdirSync(f.directory), ["run-settings.json"], "atomic publication leaves no temporary settings files");
	if (process.platform !== "win32") { assert.equal(statSync(f.home).mode & 0o777, 0o700); assert.equal(statSync(f.directory).mode & 0o777, 0o700); assert.equal(statSync(f.file).mode & 0o777, 0o600); }
});

test("partial updates preserve other run settings and unrelated config, shell and session files", t => {
	const f = fixture(t); seed(f, JSON.stringify({ bashApproval: "ask", reasoningEffort: "high" }));
	const unrelated = [[join(f.home, "config.json"), '{"provider":"fixture","maxTurns":300}'], [join(f.directory, "shell.json"), '{"keep":"operator theme"}'], [join(f.home, "session-fixture.jsonl"), '{"keep":"durable session"}\n']] as const;
	for (const [file, contents] of unrelated) writeFileSync(file, contents);
	assert.deepEqual(saveKlaudRunSettings({ reasoningEffort: "low" }, f.home), { bashApproval: "ask", reasoningEffort: "low" });
	assert.deepEqual(saveKlaudRunSettings({ bashApproval: "auto" }, f.home), { bashApproval: "auto", reasoningEffort: "low" });
	assert.deepEqual(saveKlaudRunSettings({}, f.home), { bashApproval: "auto", reasoningEffort: "low" });
	for (const [file, contents] of unrelated) assert.equal(readFileSync(file, "utf8"), contents);
	assert.deepEqual(readdirSync(f.directory).sort(), ["run-settings.json", "shell.json"]);
});

test("partial stored files receive defaults without rewriting their existing bytes", t => {
	const f = fixture(t), stored = '{ "reasoningEffort": "off" }\n'; seed(f, stored);
	assert.deepEqual(loadKlaudRunSettings(f.home), { bashApproval: "auto", reasoningEffort: "off" }); assert.equal(readFileSync(f.file, "utf8"), stored);
	writeFileSync(f.file, '{"bashApproval":"ask"}'); assert.deepEqual(loadKlaudRunSettings(f.home), { bashApproval: "ask", reasoningEffort: "default" });
});

test("invalid patches fail before creating settings or modifying valid settings", t => {
	const f = fixture(t), invalid: unknown[] = [null, undefined, false, 1, "auto", [], { bashApproval: "always" }, { bashApproval: true }, { reasoningEffort: "max" }, { reasoningEffort: null }, { reasoningEffort: 3 }, { maxTurns: 500 }, { bashApproval: "ask", unknown: "value" }, JSON.parse('{"__proto__":{"bashApproval":"auto"}}')];
	for (const value of invalid) { assert.throws(() => validateRunSettingsPatch(value)); assert.throws(() => saveKlaudRunSettings(value, f.home)); assert.equal(existsSync(f.home), false); }
	seed(f, '{ "bashApproval": "ask", "reasoningEffort": "high" }\n'); const before = readFileSync(f.file);
	for (const value of invalid) { assert.throws(() => saveKlaudRunSettings(value, f.home)); assert.deepEqual(readFileSync(f.file), before); }
	assert.deepEqual(readdirSync(f.directory), ["run-settings.json"]);
});

test("invalid stored JSON, unknown fields and oversized files are preserved on load and update", t => {
	const f = fixture(t);
	for (const stored of ["{", "null", "[]", '"ask"', '{"bashApproval":"sometimes"}', '{"reasoningEffort":"max"}', '{"bashApproval":"ask","unexpected":true}', " ".repeat(4097) + "{}"] ) {
		seed(f, stored); assert.throws(() => loadKlaudRunSettings(f.home)); assert.throws(() => saveKlaudRunSettings({ reasoningEffort: "low" }, f.home));
		assert.equal(readFileSync(f.file, "utf8"), stored); assert.deepEqual(readdirSync(f.directory), ["run-settings.json"]);
	}
});

test("symbolic-link settings files and dangling links cannot be read or replaced", t => {
	const f = fixture(t); mkdirSync(f.directory, { recursive: true, mode: 0o700 });
	const external = join(f.root, "outside-settings.json"), original = '{"bashApproval":"ask","reasoningEffort":"high"}'; writeFileSync(external, original);
	try { symlinkSync(external, f.file); } catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows account cannot create symbolic links"); return; } throw error; }
	assert.throws(() => loadKlaudRunSettings(f.home)); assert.throws(() => saveKlaudRunSettings({ bashApproval: "auto" }, f.home));
	assert.equal(readFileSync(external, "utf8"), original); assert.equal(lstatSync(f.file).isSymbolicLink(), true);
	rmSync(f.file); const absent = join(f.root, "missing-outside.json"); symlinkSync(absent, f.file);
	assert.throws(() => loadKlaudRunSettings(f.home)); assert.throws(() => saveKlaudRunSettings({ bashApproval: "auto" }, f.home));
	assert.equal(existsSync(absent), false); assert.equal(lstatSync(f.file).isSymbolicLink(), true);
});

test("symbolic-link home and klaud directories are rejected without writing through them", t => {
	const f = fixture(t), outside = join(f.root, "outside"); mkdirSync(outside, { mode: 0o700 });
	try { symlinkSync(outside, f.home, "junction"); } catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows account cannot create symbolic links"); return; } throw error; }
	assert.throws(() => loadKlaudRunSettings(f.home), /without symbolic links/); assert.throws(() => saveKlaudRunSettings({}, f.home), /without symbolic links/); assert.deepEqual(readdirSync(outside), []);
	rmSync(f.home); mkdirSync(f.home, { mode: 0o700 }); symlinkSync(outside, f.directory, "junction");
	assert.throws(() => loadKlaudRunSettings(f.home), /without symbolic links/); assert.throws(() => saveKlaudRunSettings({}, f.home), /without symbolic links/); assert.deepEqual(readdirSync(outside), []);
});

test("hard-linked settings and non-file settings paths are preserved", t => {
	const f = fixture(t); mkdirSync(f.directory, { recursive: true, mode: 0o700 });
	const external = join(f.root, "outside.json"), original = '{"bashApproval":"ask"}'; writeFileSync(external, original); linkSync(external, f.file);
	assert.throws(() => loadKlaudRunSettings(f.home), /ordinary file/); assert.throws(() => saveKlaudRunSettings({ reasoningEffort: "high" }, f.home), /ordinary file/);
	assert.equal(readFileSync(external, "utf8"), original); assert.equal(statSync(external).nlink, 2);
	rmSync(f.file); mkdirSync(f.file); writeFileSync(join(f.file, "keep"), "untouched");
	assert.throws(() => loadKlaudRunSettings(f.home)); assert.throws(() => saveKlaudRunSettings({}, f.home)); assert.equal(readFileSync(join(f.file, "keep"), "utf8"), "untouched");
});

test("replacement settings files retain private permissions", t => {
	const f = fixture(t); seed(f, '{"bashApproval":"ask"}');
	for (const reasoningEffort of ["off", "low", "medium", "high", "default"] as const) {
		assert.equal(saveKlaudRunSettings({ reasoningEffort }, f.home).bashApproval, "ask");
		assert.equal(loadKlaudRunSettings(f.home).reasoningEffort, reasoningEffort);
		if (process.platform !== "win32") assert.equal(statSync(f.file).mode & 0o777, 0o600);
	}
	assert.deepEqual(readdirSync(f.directory), ["run-settings.json"]);
});
