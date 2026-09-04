import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readMetric, readMetricCommand, requireCleanGit, discardIteration, recordLesson, runExperimentLoop } from "../src/harness/loop.ts";
import { runHarnessTests, runImproveLoop } from "../src/harness/improve.ts";

function temp() { return mkdtempSync(join(tmpdir(), "rein-autonomous-")); }
function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function repository() {
	const cwd = temp(); git(cwd, "init", "-q"); git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.invalid");
	writeFileSync(join(cwd, "tracked.txt"), "baseline"); writeFileSync(join(cwd, "LESSONS.md"), "# Lessons\n");
	git(cwd, "add", "-A"); git(cwd, "commit", "-qm", "baseline"); return cwd;
}

test("metric parser accepts documented multiline shell fences as contents", () => {
	for (const label of ["bash", "sh", "shell", ""]) {
		const doc = `# Metric\n\n\`\`\`${label}\nvalue=1.25\nprintf 'METRIC=%s\\n' "$value"\n\`\`\`\nHigher is better.\n`;
		const command = readMetricCommand(doc);
		const output = execFileSync("bash", ["-c", command], { encoding: "utf8" });
		assert.equal(readMetric(output), 1.25);
	}
	assert.equal(readMetricCommand("# metric\nprintf 'METRIC=1\\n'"), "printf 'METRIC=1\\n'");
	assert.throws(() => readMetricCommand("```python\nprint(1)\n```"), /fenced command/);
});

test("metric values must occupy one exact finite output line", () => {
	assert.equal(readMetric("progress\nMETRIC=-1.2e-3\n"), -0.0012);
	assert.equal(readMetric("METRIC=.5\r\n"), 0.5);
	for (const output of ["NOT_METRIC=1", "METRIC=1oops", "METRIC=1\nMETRIC=2", "METRIC=Infinity", "METRIC=1e999", "prefix METRIC=1"]) assert.equal(readMetric(output), undefined);
});

test("clean Git guard rejects dirty and nested targets without modifying them", () => {
	const cwd = repository();
	try {
		requireCleanGit(cwd);
		mkdirSync(join(cwd, "subdir")); assert.throws(() => requireCleanGit(join(cwd, "subdir")), /repository root/);
		writeFileSync(join(cwd, "tracked.txt"), "user work"); git(cwd, "add", "tracked.txt");
		assert.throws(() => requireCleanGit(cwd), /dirty/); assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "user work");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("experiment loop rejects dirty input before model setup or metric execution", async () => {
	const cwd = repository();
	try {
		writeFileSync(join(cwd, "TASK.md"), "improve"); writeFileSync(join(cwd, "METRIC.md"), "```bash\ntouch executed\nprintf 'METRIC=1\\n'\n```\n");
		await assert.rejects(runExperimentLoop({ cwd, maxIterations: 1 }), /dirty/);
		assert.equal(existsSync(join(cwd, "executed")), false);
		assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "baseline");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("discard removes staged and untracked experiment changes while preserving committed lessons", () => {
	const cwd = repository();
	try {
		requireCleanGit(cwd); recordLesson(cwd, "- preserved lesson", "record lesson"); requireCleanGit(cwd);
		writeFileSync(join(cwd, "tracked.txt"), "experiment"); git(cwd, "add", "tracked.txt");
		writeFileSync(join(cwd, "temporary.txt"), "experiment");
		discardIteration(cwd);
		assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "baseline");
		assert.equal(existsSync(join(cwd, "temporary.txt")), false);
		assert.match(readFileSync(join(cwd, "LESSONS.md"), "utf8"), /preserved lesson/);
		requireCleanGit(cwd);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

function validationFixture(cwd: string) {
	mkdirSync(join(cwd, "test"), { recursive: true });
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node test/smoke.js && node test/regressions.js" } }));
	writeFileSync(join(cwd, "test", "smoke.js"), "console.log('smoke passed')");
	writeFileSync(join(cwd, "test", "regressions.js"), "console.error('regression caught'); process.exit(1)");
}

test("improve validation includes regression suite beyond smoke", () => {
	const cwd = temp();
	try {
		validationFixture(cwd); const result = runHarnessTests(cwd);
		assert.equal(result.pass, false); assert.match(result.output, /regression caught/);
		writeFileSync(join(cwd, "test", "regressions.js"), "console.log('regressions passed')");
		assert.equal(runHarnessTests(cwd).pass, true);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("installed validation scratch copy includes package script and regression suite", () => {
	const root = temp(); const cwd = join(root, "node_modules", "rein-agent");
	try {
		validationFixture(cwd); const result = runHarnessTests(cwd);
		assert.equal(result.pass, false); assert.match(result.output, /regression caught/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("improve dry run returns without model setup or target mutation", async () => {
	await runImproveLoop({ dryRun: true, maxIterations: 1 });
});


test("discard refuses to reset a different committed iteration", () => {
	const cwd = repository();
	try {
		const head = git(cwd, "rev-parse", "HEAD"); recordLesson(cwd, "- newer work", "newer commit");
		writeFileSync(join(cwd, "tracked.txt"), "preserve this");
		assert.throws(() => discardIteration(cwd, head), /HEAD changed/);
		assert.equal(readFileSync(join(cwd, "tracked.txt"), "utf8"), "preserve this");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
