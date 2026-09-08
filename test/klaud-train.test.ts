import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { automodelAvailable, runTrain } from "../src/harness/klaud/train.ts";

async function fixture(run: (state: { dir: string; root: string; marker: string; script: (body: string) => void }) => Promise<void>): Promise<void> {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "rein-train-test-"))), root = join(dir, "automodel"), bin = join(dir, "bin with spaces"), marker = join(dir, "invocation.json");
	mkdirSync(root); mkdirSync(bin); writeFileSync(join(root, "pyproject.toml"), "[project]\nname='fixture'\n");
	const names = ["PATH", "REIN_AUTOMODEL_ROOT", "REIN_AUTOMODEL_BIN", "REIN_TRAIN_TIMEOUT_MS"];
	const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
	process.env.PATH = bin; process.env.REIN_AUTOMODEL_ROOT = root; process.env.REIN_AUTOMODEL_BIN = join(bin, "fake-automodel");
	delete process.env.REIN_TRAIN_TIMEOUT_MS;
	writeFileSync(join(bin, process.platform === "win32" ? "uv.exe" : "uv"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
	const script = (body: string) => writeFileSync(process.env.REIN_AUTOMODEL_BIN!, "#!" + process.execPath + "\n" + "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n" + body + "\n", { mode: 0o700 });
	try { await run({ dir, root, marker, script }); }
	finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } rmSync(dir, { recursive: true, force: true }); }
}

test("automodelAvailable is boolean and checks uv plus pyproject without executing them", () => fixture(async ({ dir, root, marker }) => {
	assert.equal(typeof automodelAvailable(), "boolean"); assert.equal(automodelAvailable(), true); assert.equal(existsSync(marker), false);
	rmSync(join(root, "pyproject.toml")); assert.equal(automodelAvailable(), false);
	writeFileSync(join(root, "pyproject.toml"), "[project]\n");
	process.env.PATH = join(dir, "missing"); assert.equal(automodelAvailable(), false);
}));

test("runTrain rejects traversal and non-YAML paths before spawning", () => fixture(async ({ script, marker }) => {
	script("process.stdout.write('should not run');");
	for (const recipe of ["../secret.yaml", "nested/../secret.yml", "nested\\..\\secret.yaml", "recipe..yaml", "recipe.json", "recipe.yaml.sh", "", "recipe.yaml\0"]) {
		await assert.rejects(runTrain(recipe), /recipe/i);
	}
	assert.equal(existsSync(marker), false);
}));

test("fake training captures metrics and preserves recipe paths, arguments, and Automodel cwd", () => fixture(async ({ root, marker, script }) => {
	script("console.log('METRIC=1');");
	const recipe = "recipe with spaces.yaml", extra = ["--nproc-per-node", "2", "--run.name=$(touch no-shell)"];
	const result = await runTrain(recipe, extra);
	assert.equal(result.code, 0); assert.match(result.log, /METRIC=1/);
	assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { args: ["run", "automodel", resolve(recipe), ...extra], cwd: root });
}));

test("training returns the child exit code and captures stderr", () => fixture(async ({ script }) => {
	script("process.stderr.write('fixture failure'); process.exitCode = 7;");
	const result = await runTrain("recipe.yml");
	assert.equal(result.code, 7); assert.match(result.log, /fixture failure/);
}));

test("spawn errors reject and remove process signal listeners", () => fixture(async () => {
	process.env.REIN_AUTOMODEL_BIN = "/nonexistent/rein-fake-trainer";
	const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
	await assert.rejects(runTrain("recipe.yaml"), /ENOENT|executable|spawn/i);
	assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
}));

test("timeout settings and argument values are validated before spawning", () => fixture(async ({ script, marker }) => {
	script("console.log('should not run');");
	for (const timeout of ["0", "-1", "NaN", "1.5", "2147483648", ""]) {
		process.env.REIN_TRAIN_TIMEOUT_MS = timeout;
		await assert.rejects(runTrain("recipe.yaml"), /REIN_TRAIN_TIMEOUT_MS/);
	}
	delete process.env.REIN_TRAIN_TIMEOUT_MS;
	await assert.rejects(runTrain("recipe.yaml", ["bad\0argument"]), /arguments/i);
	assert.equal(existsSync(marker), false);
}));

test("tests refuse to launch the real trainer without the fake-bin override", () => fixture(async ({ marker }) => {
	delete process.env.REIN_AUTOMODEL_BIN;
	await assert.rejects(runTrain("recipe.yaml"), /REIN_AUTOMODEL_BIN/);
	assert.equal(existsSync(marker), false);
}));

test("a training deadline kills TERM-resistant descendants and restores signal listeners", { timeout: 20_000, skip: process.platform === "win32" }, () => fixture(async ({ script, dir }) => {
	const escaped = join(dir, "escaped"), ready = join(dir, "ready");
	// The deadline must leave time for both real Node fixtures to start under
	// suite load. The later marker still proves resistant descendants were killed.
	const timeoutMs = 5000, escapeDelayMs = timeoutMs + 1200;
	const descendant = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(" + JSON.stringify(ready) + ",'ready');setTimeout(()=>require('node:fs').writeFileSync(" + JSON.stringify(escaped) + ",'escaped')," + escapeDelayMs + ");setInterval(()=>{},1000);";
	script("require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(descendant) + "],{stdio:'ignore'}); setInterval(()=>{},1000);");
	process.env.REIN_TRAIN_TIMEOUT_MS = String(timeoutMs);
	const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
	const result = await runTrain("recipe.yaml");
	assert.equal(existsSync(ready), true); assert.equal(result.code, 124); assert.match(result.log, /timed out.*5000/);
	assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
	await new Promise(resolve => setTimeout(resolve, escapeDelayMs + 100)); assert.equal(existsSync(escaped), false);
}));

test("SIGINT cancels the owned training process and returns exit 130", { timeout: 8000, skip: process.platform === "win32" }, () => fixture(async ({ script, dir }) => {
	const ready = join(dir, "ready"), resultFile = join(dir, "result.json");
	script("process.on('SIGINT',()=>{});require('node:fs').writeFileSync(" + JSON.stringify(ready) + ",'ready'); setInterval(()=>{},1000);");
	const source = "import {runTrain} from " + JSON.stringify(new URL("../src/harness/klaud/train.ts", import.meta.url).href) + ";import {writeFileSync} from 'node:fs'; const result=await runTrain('recipe.yaml');writeFileSync(" + JSON.stringify(resultFile) + ",JSON.stringify(result));process.exitCode=result.code;";
	const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, REIN_TRAIN_TIMEOUT_MS: "3000" }, stdio: "ignore" });
	const completion = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
	try {
		const deadline = Date.now() + 3000;
		while (!existsSync(ready)) { if (Date.now() > deadline) throw new Error("training fixture did not start"); await new Promise(resolve => setTimeout(resolve, 10)); }
		child.kill("SIGINT");
		assert.equal(await completion, 130); assert.match(JSON.parse(readFileSync(resultFile, "utf8")).log, /SIGINT/);
	} finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await completion; }
}));

test("CLI reports optional installation help without starting a trainer", () => fixture(async ({ dir }) => {
	const cli = fileURLToPath(new URL("../bin/rein.js", import.meta.url));
	const child = spawn(process.execPath, [cli, "train", "recipe.yaml"], { env: { ...process.env, PATH: join(dir, "missing") }, stdio: ["ignore", "pipe", "pipe"] });
	let log = ""; child.stdout.on("data", chunk => log += chunk); child.stderr.on("data", chunk => log += chunk);
	const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
	assert.equal(code, 1); assert.match(log, /git clone.*NousResearch\/Automodel/); assert.match(log, /uv/); assert.match(log, /REIN_AUTOMODEL_ROOT/);
}));

test("CLI forwards trainer flags unchanged and propagates the training exit status", () => fixture(async ({ script, marker }) => {
	script("console.log('METRIC=1'); process.exitCode = 3;");
	const cli = fileURLToPath(new URL("../bin/rein.js", import.meta.url));
	const extra = ["--nproc-per-node", "2", "--run.name=fixture"];
	const child = spawn(process.execPath, [cli, "train", "recipe.yaml", ...extra], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
	let log = ""; child.stdout.on("data", chunk => log += chunk); child.stderr.on("data", chunk => log += chunk);
	const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
	assert.equal(code, 3); assert.match(log, /METRIC=1/); assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")).args, ["run", "automodel", resolve("recipe.yaml"), ...extra]);
}));

test("the fake executable override is rejected outside a test process", () => fixture(async ({ marker, script }) => {
	script("console.log('should not run');");
	const source = "import {runTrain} from " + JSON.stringify(new URL("../src/harness/klaud/train.ts", import.meta.url).href) + ";try {await runTrain('recipe.yaml'); process.exitCode=2;}catch(error){console.log(error.message);}";
	const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
	const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env, stdio: ["ignore", "pipe", "pipe"] });
	let log = ""; child.stdout.on("data", chunk => log += chunk); child.stderr.on("data", chunk => log += chunk);
	const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
	assert.equal(code, 0); assert.match(log, /REIN_AUTOMODEL_BIN.*tests/); assert.equal(existsSync(marker), false);
}));
