import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { toolsForCwd, TOOLS } from "../src/harness/tools/index.ts";
import { createRunner } from "../src/harness/runner.ts";

function inDirectory(cwd: string) {
	return Object.fromEntries(toolsForCwd(cwd).map(tool => [tool.name, (args: Record<string, unknown>) => tool.execute("test", args)]));
}

test("runner tools bind file, shell, search and gate operations to their own cwd", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "rein-tool-cwd-"));
	const parentCwd = process.cwd();
	try {
		const target = join(fixture, "target"); const second = join(fixture, "second");
		mkdirSync(target); mkdirSync(second);
		const tools = inDirectory(target); const otherTools = inDirectory(second);
		const args = { path: "nested/sentinel.txt", content: "target needle" };
		assert.equal((await tools.write(args)).isError, undefined);
		assert.equal(args.path, "nested/sentinel.txt", "wrappers must not mutate tool-call arguments");
		assert.equal(readFileSync(join(target, args.path), "utf8"), "target needle");
		assert.match((await tools.read({ path: args.path })).content, /target needle/);
		assert.equal((await tools.edit({ path: args.path, edits: [{ oldText: "needle", newText: "replacement" }] })).isError, undefined);
		assert.equal(readFileSync(join(target, args.path), "utf8"), "target replacement");
		assert.match((await tools.ls({})).content, /nested\//);
		assert.match((await tools.grep({ pattern: "replacement" })).content, /sentinel.txt.*target replacement/);
		assert.match((await tools.grep({ pattern: "replacement", path: "nested/sentinel.txt" })).content, /target replacement/);
		assert.match((await tools.find({ pattern: "sentinel.txt" })).content, /sentinel.txt/);
		assert.equal((await tools.bash({ command: "pwd; printf shell-target > shell-marker" })).content.trim(), realpathSync(target));
		assert.equal(readFileSync(join(target, "shell-marker"), "utf8"), "shell-target");
		await otherTools.write({ path: "other-marker", content: "other" });
		const directories = await Promise.all([tools.bash({ command: "pwd" }), otherTools.bash({ command: "pwd" })]);
		assert.deepEqual(directories.map(result => result.content.trim()), [realpathSync(target), realpathSync(second)]);
		assert.equal(existsSync(join(target, "other-marker")), false);
		assert.equal(existsSync(join(second, "shell-marker")), false);
		writeFileSync(join(target, "GATES.md"), "# Gates\n\n- [ ] G1: TARGET LEDGER MARKER\n");
		const gates = await tools.gates({ mode: "status" });
		assert.doesNotMatch(gates.content, /Ledger not found/);
		assert.match(gates.content, /TARGET LEDGER MARKER/);
		mkdirSync(join(target, "sub"));
		writeFileSync(join(target, "sub", "GATES.md"), "# Gates\n\n- [ ] G2: NESTED LEDGER MARKER\n");
		assert.match((await tools.gates({ mode: "status", root: "sub" })).content, /NESTED LEDGER MARKER/);
		assert.match((await tools.read({ path: join(second, "other-marker") })).content, /other/, "explicit absolute paths retain compatibility");
		assert.equal(process.cwd(), parentCwd, "tools must never change global cwd");
		assert.equal(TOOLS.length, toolsForCwd(target).length, "legacy tool export remains available");
	} finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("createRunner installs tools for opts.cwd while preserving custom tool arrays", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "rein-runner-cwd-"));
	const previous = process.env.REIN_HOME;
	process.env.REIN_HOME = join(fixture, "rein-home");
	try {
		const target = join(fixture, "target"); mkdirSync(target);
		const runner = await createRunner({ cwd: target, modelOverride: "offline", baseUrlOverride: "http://localhost:1/v1", toolsMode: "native" });
		const write = runner.tools.find(tool => tool.name === "write")!;
		await write.execute("test", { path: "runner-marker", content: "correct target" });
		assert.equal(readFileSync(join(target, "runner-marker"), "utf8"), "correct target");
		const custom = { name: "custom", description: "custom", parameters: { type: "object" }, execute: async () => ({ content: "custom" }) };
		const customRunner = await createRunner({ cwd: target, modelOverride: "offline", baseUrlOverride: "http://localhost:1/v1", tools: [custom] });
		assert.deepEqual(customRunner.tools, [custom]);
		assert.equal(customRunner.tools[0], custom);
		const relativeTools = inDirectory(relative(process.cwd(), target));
		assert.match((await relativeTools.read({ path: "runner-marker" })).content, /correct target/);
	} finally {
		if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous;
		rmSync(fixture, { recursive: true, force: true });
	}
});


test("find passes only its bound search directory to fd", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "rein-find-cwd-"));
	const previousPath = process.env.PATH;
	try {
		const target = join(fixture, "target"); const bin = join(fixture, "bin");
		mkdirSync(target); mkdirSync(bin);
		const script = join(bin, "fd");
		writeFileSync(script, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
		chmodSync(script, 0o700);
		process.env.PATH = `${bin}:${previousPath ?? "/usr/bin:/bin"}`;
		const result = await inDirectory(target).find({ pattern: "*.ts", limit: 7 });
		assert.equal(result.isError, undefined);
		assert.deepEqual(result.content.split("\n"), ["-g", "*.ts", "--max-results", "7", target]);
	} finally {
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
		rmSync(fixture, { recursive: true, force: true });
	}
});
