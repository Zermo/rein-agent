import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installModelService, modelServicePlan, modelServiceStatus, removeModelService, type ModelServiceOptions } from "../src/models/runtime-service.ts";

const id = "a".repeat(64);
async function fixture(t: any, platform: "darwin" | "linux" = "linux") {
	const userHome = await realpath(await mkdtemp(join(tmpdir(), "rein-model-service-")));
	t.after(() => rm(userHome, { recursive: true, force: true }));
	const cliPath = join(userHome, "rein $literal%name.js"); await writeFile(cliPath, "fixture");
	const calls: string[][] = [];
	const options: ModelServiceOptions = { id, home: userHome, userHome, platform, runtime: process.execPath, cliPath, nodePath: process.execPath,
		verify: async () => ({ artifact: { id, repo: "fixture/model", sizeBytes: 128 } as any, path: join(userHome, "model.gguf"), installedAt: "" }),
		commandRunner: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: "state = running" }; },
	};
	return { options, calls };
}
test("service plans are per-home/model, literal, and contain no account credentials", async t => {
	const f = await fixture(t), plan = modelServicePlan(f.options);
	assert.match(plan.content, /ExecStart=.*:/); assert.match(plan.content, /\$literal%%name/);
	assert.match(plan.content, /"model" "serve"/); assert.doesNotMatch(plan.content, /LLAMA_API_KEY|HF_TOKEN/);
	assert.notEqual(modelServicePlan({ ...f.options, id: "b".repeat(64) }).path, plan.path);
	assert.notEqual(modelServicePlan({ ...f.options, home: join(f.options.home, "other") }).path, plan.path);
	assert.equal(f.calls.length, 0);
});
test("install, status and removal work without resupplying the runtime; model data is preserved", async t => {
	for (const platform of ["linux", "darwin"] as const) {
		const f = await fixture(t, platform); await writeFile(join(f.options.home, "config.json"), "keep config");
		const installed = await installModelService(f.options); assert.equal(installed.installed, true); assert.equal(installed.active, true);
		const inspect = { ...f.options, runtime: undefined };
		assert.equal(modelServiceStatus(inspect).active, true);
		assert.equal(removeModelService(inspect).installed, false);
		assert.equal(modelServiceStatus(inspect).installed, false);
		assert.equal(await readFile(join(f.options.home, "config.json"), "utf8"), "keep config");
		assert.ok(f.calls.every(call => call.includes("--user") || call[0] === "/bin/launchctl"));
	}
});
test("modified service files and failed stops are preserved", async t => {
	const f = await fixture(t); const result = await installModelService(f.options);
	const original = await readFile(result.path, "utf8");
	await writeFile(result.path, original + "# user edit\n");
	assert.throws(() => removeModelService({ ...f.options, runtime: undefined }), /modified or unrelated/);
	assert.equal(await readFile(result.path, "utf8"), original + "# user edit\n");
	await writeFile(result.path, original);
	assert.throws(() => removeModelService({ ...f.options, commandRunner: () => ({ status: 1, stderr: "fixture failure" }) }), /file was kept/);
	assert.equal(await readFile(result.path, "utf8"), original);
});
test("Windows returns a foreground path and unavailable runtime cannot register a service", async t => {
	const f = await fixture(t);
	assert.equal((await installModelService({ ...f.options, platform: "win32", runtime: undefined })).manager, "foreground");
	assert.equal(modelServiceStatus({ ...f.options, platform: "win32", runtime: undefined }).manager, "foreground");
	await assert.rejects(installModelService({ ...f.options, runtime: join(f.options.home, "missing") }), /not found/);
	assert.equal(f.calls.length, 0);
});
