import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNodeRuntime, formatDoctorCheck, summarizeDoctor } from "../src/harness/doctor.ts";

test("supported Node compatibility versions are silent flags, with no warning or repair penalty", () => {
	for (const version of ["18.20.8", "20.20.2", "22.23.2", "24.20.0"]) {
		const check = checkNodeRuntime(version);
		assert.equal(check.status, "ok");
		assert.equal(check.fix, undefined);
		assert.equal(check.autoFix, undefined);
		assert.equal(check.flag?.kind, "compatibility");
		assert.equal(check.flag?.silent, true);
		assert.equal(formatDoctorCheck(check), undefined);
		assert.match(formatDoctorCheck(check, false)!, /compatibility matrix/);
		const result = summarizeDoctor([check]);
		assert.equal(result.healthy, result.total);
		assert.equal(result.warnings, 0);
		assert.equal(result.failures, 0);
		assert.equal(result.flags.length, 1);
		assert.equal(JSON.parse(JSON.stringify(result)).flags[0].silent, true);
	}
	for (const version of ["26.8.1", "28.0.0"]) {
		assert.equal(checkNodeRuntime(version).status, "ok");
		assert.equal(checkNodeRuntime(version).flag, undefined);
	}
});

test("silent compatibility flags never suppress actual warnings or failed runtime requirements", () => {
	for (const version of ["16.20.2", "invalid"]) {
		const check = checkNodeRuntime(version);
		assert.equal(check.status, "fail");
		assert.equal(check.flag, undefined);
		assert.match(formatDoctorCheck(check)!, /required/);
	}
	const oldFlag = checkNodeRuntime("24.20.0").flag;
	const checks = [
		{ name: "server", status: "fail" as const, detail: "connection refused", flag: oldFlag },
		{ name: "disk", status: "warn" as const, detail: "low space", flag: oldFlag },
	];
	for (const check of checks) assert.ok(formatDoctorCheck(check)?.includes(check.detail));
	const result = summarizeDoctor(checks);
	assert.equal(result.failures, 1);
	assert.equal(result.warnings, 1);
	assert.deepEqual(result.flags, []);
	assert.notEqual(result.healthy, result.total);
});

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/rein.js", import.meta.url));
function fixture(installName = "installed", homeName = "state") {
	const root = mkdtempSync(join(tmpdir(), "rein-doctor-flags-"));
	const home = join(root, homeName), bin = join(root, "bin"), install = join(root, installName);
	for (const path of [home, bin, join(install, "dist")]) mkdirSync(path, { recursive: true });
	writeFileSync(join(install, "package.json"), JSON.stringify({ name: "rein-agent" }));
	writeFileSync(join(install, "dist", "rein.js"), "#!/bin/sh\nexit 1\n");
	chmodSync(join(install, "dist", "rein.js"), 0o700);
	symlinkSync(join(install, "dist", "rein.js"), join(bin, "rein"));
	writeFileSync(join(bin, "codex"), `#!/bin/sh
case "$*" in
  --version) exit 0;;
  'login status') test "$REIN_FIXTURE_AUTH_FAIL" != 1; exit $?;;
  *) exit 99;;
esac
`);
	chmodSync(join(bin, "codex"), 0o700);
	writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "codex", auth: { type: "cli", provider: "codex" }, baseUrl: "cli://codex", model: "default" }));
	writeFileSync(join(home, "HEARTBEAT.md"), "# Idle compatibility fixture\n");
	const run = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
		const options = { cwd: root, env: { ...process.env, HOME: root, REIN_HOME: home, PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: "1", REIN_API_KEY: "", REIN_BASE_URL: "", REIN_MODEL: "", ...env }, timeout: 15_000, maxBuffer: 200_000 };
		try { const result = await exec(process.execPath, [cli, ...args], options); return { code: 0, ...result }; }
		catch (error: any) {
			if (typeof error.code !== "number") throw error;
			return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) };
		}
	};
	return { root, home, bin, install, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("doctor checks and repairs treat paths with shell syntax as literal arguments", async () => {
	const f = fixture("repo $(touch injected-dollar) `touch injected-backtick` 'quoted'", "state $(touch injected-config)");
	try {
		mkdirSync(join(f.install, ".git"));
		mkdirSync(join(f.install, "src"));
		writeFileSync(join(f.install, "src", "fixture.ts"), "// fixture\n");
		utimesSync(join(f.install, "dist", "rein.js"), 1, 1);
		const log = join(f.root, "commands.jsonl");
		for (const command of ["git", "npm"]) {
			writeFileSync(join(f.bin, command), `#!${process.execPath}
const fs = require("node:fs"), args = process.argv.slice(2);
fs.appendFileSync(process.env.REIN_FIXTURE_COMMAND_LOG, JSON.stringify({command: ${JSON.stringify(command)}, args}) + "\\n");
if (args[2] === "rev-parse") console.log("1111111");
if (args[2] === "ls-remote") console.log("2222222 refs/heads/main");
`);
			chmodSync(join(f.bin, command), 0o700);
		}
		const config = join(f.home, "config.json");
		writeFileSync(config, JSON.stringify({ provider: "codex", auth: { type: "cli", provider: "codex" }, baseUrl: "cli://codex", model: "default", apiKey: "synthetic-credential" }));
		chmodSync(config, 0o644);
		const moduleUrl = new URL("../src/harness/doctor.ts", import.meta.url).href;
		const result = await exec(process.execPath, ["--input-type=module", "-e", `
const {runDoctor} = await import(${JSON.stringify(moduleUrl)});
const result = await runDoctor({fix: true, quiet: true});
await result.checks.find(check => check.name === "perms").autoFix();
console.log(JSON.stringify(result.fixed));
`], { cwd: f.root, env: { ...process.env, HOME: f.root, REIN_HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin`, REIN_FIXTURE_COMMAND_LOG: log, REIN_FIXTURE_AUTH_FAIL: "0", REIN_API_KEY: "", REIN_BASE_URL: "", REIN_MODEL: "" }, timeout: 15_000 });
		assert.deepEqual(JSON.parse(result.stdout), ["repo", "bundle"]);
		const repo = realpathSync(f.install);
		assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)), [
			{ command: "git", args: ["-C", repo, "rev-parse", "HEAD"] },
			{ command: "git", args: ["-C", repo, "ls-remote", "origin", "main"] },
			{ command: "git", args: ["-C", repo, "pull", "--ff-only"] },
			{ command: "npm", args: ["run", "bundle", "--prefix", repo] },
		]);
		assert.equal(statSync(config).mode & 0o777, 0o600);
		for (const name of ["injected-dollar", "injected-backtick", "injected-config"]) assert.equal(existsSync(join(f.root, name)), false);
	} finally { f.close(); }
});

test("doctor reports malformed config and invalid budgets in JSON without leaking credentials", async () => {
	const f = fixture();
	try {
		const path = join(f.home, "config.json");
		writeFileSync(path, '{"apiKey":"fixture-private-value",BROKEN');
		let result = await f.run(["doctor", "--json"]);
		assert.equal(result.code, 1);
		assert.ok(JSON.parse(result.stdout).checks.some((check: any) => check.name === "config" && check.status === "fail"));
		assert.doesNotMatch(result.stdout + result.stderr, /fixture-private-value/);
		writeFileSync(path, JSON.stringify({ provider: "codex", auth: { type: "cli", provider: "codex" }, baseUrl: "cli://codex", model: "default", maxTurns: 0 }));
		result = await f.run(["doctor", "--json"]);
		assert.equal(result.code, 1);
		assert.ok(JSON.parse(result.stdout).checks.some((check: any) => check.name === "task budgets" && check.status === "fail"));
	} finally { f.close(); }
});

test("doctor CLI preserves JSON flags, accepts silent before the command, and still reports failures", { timeout: 20_000 }, async () => {
	const f = fixture();
	try {
		const json = await f.run(["--silent", "doctor", "--json"]);
		const result = JSON.parse(json.stdout);
		assert.equal(json.code, 0, json.stdout + json.stderr);
		assert.equal(result.healthy, result.total);
		assert.equal(result.warnings, 0);
		assert.equal(result.failures, 0);
		assert.deepEqual(result.flags, checkNodeRuntime().flag ? [checkNodeRuntime().flag] : []);
		const plain = await f.run(["doctor", "--silent"]);
		assert.equal(plain.code, 0, plain.stdout + plain.stderr);
		assert.doesNotMatch(plain.stdout, /compatibility matrix|auto-repair/);
		const shown = await f.run(["doctor", "--silent=false"]);
		assert.equal(shown.code, 0, shown.stdout + shown.stderr);
		if (result.flags.length) assert.match(shown.stdout, /compatibility matrix/);
		const failed = await f.run(["doctor", "--silent"], { REIN_FIXTURE_AUTH_FAIL: "1" });
		assert.equal(failed.code, 1);
		assert.match(failed.stdout, /not authenticated/);
		const failedJson = await f.run(["doctor", "--silent", "--json"], { REIN_FIXTURE_AUTH_FAIL: "1" });
		assert.equal(failedJson.code, 1);
		assert.equal(JSON.parse(failedJson.stdout).failures, 1);
	} finally { f.close(); }
});

test("heartbeat retains silent compatibility metadata in its own REIN_HOME log", { timeout: 20_000 }, async () => {
	const f = fixture();
	try {
		const result = await f.run(["heartbeat", "--silent"]);
		assert.equal(result.code, 0, result.stdout + result.stderr);
		assert.doesNotMatch(result.stdout, /compatibility matrix/);
		const entries = readFileSync(join(f.home, "heartbeat.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(entries.length, 1);
		assert.equal(entries[0].file, join(f.home, "HEARTBEAT.md"));
		assert.equal(entries[0].doctor.warnings, 0);
		assert.equal(entries[0].doctor.failures, 0);
		assert.deepEqual(entries[0].doctor.flags, checkNodeRuntime().flag ? [checkNodeRuntime().flag] : []);
		assert.equal(existsSync(join(f.root, ".rein", "heartbeat.log")), false);
	} finally { f.close(); }
});
