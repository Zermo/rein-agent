import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/rein.js", import.meta.url));
const installer = fileURLToPath(new URL("../install.sh", import.meta.url));
const posix = { skip: process.platform === "win32", timeout: 20_000 };
async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	try { return { code: 0, ...await exec(command, args, { cwd, env, timeout: 15_000, maxBuffer: 200_000 }) }; }
	catch (error: any) {
		if (typeof error.code !== "number") throw error;
		return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) };
	}
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rein-update-"));
	const home = join(root, "state with spaces"), bin = join(root, "bin");
	for (const path of [home, bin]) mkdirSync(path);
	const config = '{"baseUrl":"http://127.0.0.1:1/v1","model":"offline","apiKey":"fixture-only"}\n';
	writeFileSync(join(home, "config.json"), config);
	writeFileSync(join(home, "session.jsonl"), "saved history\n");
	const env = { ...process.env, PATH: bin, REIN_HOME: home, REIN_UPDATE_FIXTURE: root, NO_COLOR: "1" };
	const program = (name: string, code: string) => writeFileSync(join(bin, name), `#!${process.execPath}\n${code}\n`, { mode: 0o700 });
	const close = () => rmSync(root, { recursive: true, force: true });
	const unchanged = () => {
		assert.equal(readFileSync(join(home, "config.json"), "utf8"), config);
		assert.equal(readFileSync(join(home, "session.jsonl"), "utf8"), "saved history\n");
	};
	const download = (exitCode = 0, empty = false) => program("curl", `
const fs = require('node:fs'), path = require('node:path');
const root = process.env.REIN_UPDATE_FIXTURE, args = process.argv.slice(2);
fs.writeFileSync(path.join(root, 'curl.json'), JSON.stringify(args));
fs.writeFileSync(args[args.indexOf('--output') + 1], ${JSON.stringify(empty ? "" : '#!/bin/bash\nprintf "%s" "$1" > "$REIN_HOME/update-args"\nprintf installed > "$REIN_HOME/installed"\nexit "${REIN_UPDATE_INSTALL_EXIT:-0}"\n')});
process.exit(${exitCode});`);
	const assertCleaned = () => {
		const args = JSON.parse(readFileSync(join(root, "curl.json"), "utf8"));
		assert.equal(existsSync(args[args.indexOf("--output") + 1]), false, "Downloaded installer must be removed.");
	};
	return { root, home, bin, env, program, close, unchanged, download, assertCleaned,
		run: (extraEnv: NodeJS.ProcessEnv = {}, args = ["update"]) => run(process.execPath, [cli, ...args], root, { ...env, ...extraEnv }) };
}

test("rein update downloads the official installer, runs Bash without setup, and preserves state", posix, async () => {
	const f = fixture();
	try {
		f.download(); symlinkSync("/bin/bash", join(f.bin, "bash"));
		const result = await f.run();
		assert.equal(result.code, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /Rein update complete/);
		assert.equal(readFileSync(join(f.home, "update-args"), "utf8"), "--skip-setup");
		const args = JSON.parse(readFileSync(join(f.root, "curl.json"), "utf8"));
		assert.equal(args.at(-1), "https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh");
		for (const flag of ["--fail", "--location", "--show-error"]) assert.ok(args.includes(flag));
		for (const flag of ["--proto", "--proto-redir"]) assert.equal(args[args.indexOf(flag) + 1], "=https");
		assert.ok(Number(args[args.indexOf("--max-time") + 1]) <= 120);
		f.unchanged(); f.assertCleaned();
	} finally { f.close(); }
});

test("failed or empty downloads are never executed", posix, async () => {
	for (const [exitCode, empty] of [[22, false], [0, true]] as const) {
		const f = fixture();
		try {
			f.download(exitCode, empty); symlinkSync("/bin/bash", join(f.bin, "bash"));
			const result = await f.run();
			assert.equal(result.code, 1);
			assert.match(result.stderr, exitCode ? /curl exited 22/ : /empty or invalid/);
			assert.doesNotMatch(result.stdout, /Rein update complete/);
			assert.equal(existsSync(join(f.home, "installed")), false);
			f.unchanged(); f.assertCleaned();
		} finally { f.close(); }
	}
});

test("installer failure is reported and temporary downloads are removed", posix, async () => {
	const f = fixture();
	try {
		f.download(); symlinkSync("/bin/bash", join(f.bin, "bash"));
		const result = await f.run({ REIN_UPDATE_INSTALL_EXIT: "7" });
		assert.equal(result.code, 1); assert.match(result.stderr, /bash exited 7/);
		assert.doesNotMatch(result.stdout, /Rein update complete/);
		f.unchanged(); f.assertCleaned();
	} finally { f.close(); }
});

test("missing curl or Bash gives an actionable error without starting setup", posix, async () => {
	for (const command of ["curl", "bash"]) {
		const f = fixture();
		try {
			if (command === "bash") f.download();
			const result = await f.run();
			assert.equal(result.code, 1); assert.ok(result.stderr.includes(`${command} is required for rein update`));
			assert.equal(existsSync(join(f.home, "installed")), false);
			f.unchanged(); if (command === "bash") f.assertCleaned();
		} finally { f.close(); }
	}
});

test("update rejects unrecognized arguments before downloading anything", posix, async () => {
	const f = fixture();
	try {
		f.download();
		for (const args of [["update", "typo"], ["update", "--branch", "typo"]]) {
			const result = await f.run({}, args);
			assert.equal(result.code, 1); assert.match(result.stderr, /Usage: rein update/);
		}
		assert.equal(existsSync(join(f.root, "curl.json")), false);
		f.unchanged();
	} finally { f.close(); }
});

for (const [signal, phase] of [["SIGINT", "curl"], ["SIGHUP", "bash"], ["SIGTERM", "bash"]] as const) {
	test(`update ${signal} during ${phase} drains owned descendants and removes the download`, posix, async () => {
		const f = fixture();
		let child: ReturnType<typeof spawn> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const pidFiles = ["parent.pid", "descendant.pid"];
		try {
			f.download();
			const descendant = `const fs = require('node:fs'), path = require('node:path'); const root = process.env.REIN_UPDATE_FIXTURE;
process.on('SIGTERM', () => {}); fs.writeFileSync(path.join(root, 'descendant.pid'), String(process.pid));
setTimeout(() => fs.writeFileSync(path.join(root, 'escaped'), 'escaped'), 3000); setInterval(() => {}, 1000);`;
			f.program(phase, `const fs = require('node:fs'), path = require('node:path'); const root = process.env.REIN_UPDATE_FIXTURE;
fs.writeFileSync(path.join(root, 'parent.pid'), String(process.pid));
if (${JSON.stringify(phase)} === 'curl') {
  const args = process.argv.slice(2); fs.writeFileSync(path.join(root, 'curl.json'), JSON.stringify(args));
  fs.writeFileSync(args[args.indexOf('--output') + 1], 'partial installer');
}
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
setInterval(() => {}, 1000);`);
			child = spawn(process.execPath, [cli, "update"], { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
			timeout = setTimeout(() => child?.kill("SIGKILL"), 15_000);
			let output = "";
			child.stdout!.on("data", chunk => output += chunk); child.stderr!.on("data", chunk => output += chunk);
			const done = new Promise<number | null>((resolve, reject) => { child!.on("error", reject); child!.on("close", resolve); });
			const deadline = Date.now() + 10_000;
			while (!existsSync(join(f.root, "descendant.pid")) && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 20));
			assert.ok(existsSync(join(f.root, "descendant.pid")), output);
			const started = Date.now(); child.kill(signal);
			assert.equal(await done, { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 }[signal], output);
			assert.ok(Date.now() - started >= 900, "Shutdown must wait for escalation after the parent exits.");
			assert.match(output, /Update interrupted/); assert.doesNotMatch(output, /Rein update complete/);
			f.assertCleaned(); f.unchanged();
			await new Promise(resolve => setTimeout(resolve, 2200));
			assert.equal(existsSync(join(f.root, "escaped")), false, "A descendant survived updater shutdown.");
		} finally {
			clearTimeout(timeout);
			child?.kill("SIGKILL");
			for (const name of pidFiles) if (existsSync(join(f.root, name))) {
				const pid = Number(readFileSync(join(f.root, name), "utf8"));
				if (!Number.isSafeInteger(pid) || pid <= 1) continue;
				try { process.kill(name === "parent.pid" ? -pid : pid, "SIGKILL"); } catch { /* Already gone. */ }
			}
			f.close();
		}
	});
}

function installFixture() {
	const f = fixture(), remote = join(f.root, "remote"), checkout = join(f.home, "repo");
	mkdirSync(remote); mkdirSync(join(remote, "dist"));
	const env = { ...f.env, PATH: `${f.bin}:/usr/bin:/bin`, REIN_REPO: remote, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
	symlinkSync(process.execPath, join(f.bin, "node"));
	f.program("npm", `const fs = require('node:fs'), path = require('node:path');
fs.appendFileSync(path.join(process.env.REIN_UPDATE_FIXTURE, 'npm.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === '--version') console.log('fixture');
if (process.argv.includes('--global') && process.env.REIN_UPDATE_NPM_FAIL === '1') process.exit(9);`);
	f.program("rein", `require('node:fs').writeFileSync(require('node:path').join(process.env.REIN_UPDATE_FIXTURE, 'setup-called'), 'called'); process.exit(99);`);
	const gitAt = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
	gitAt(remote, "init", "-b", "main"); gitAt(remote, "config", "user.name", "Update Fixture"); gitAt(remote, "config", "user.email", "fixture@example.invalid");
	const publish = (version: string) => {
		writeFileSync(join(remote, "dist/rein.js"), `require('node:fs').appendFileSync(require('node:path').join(process.env.REIN_UPDATE_FIXTURE, 'installed-cli.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n'); console.log(${JSON.stringify("rein " + version)});\n`);
		writeFileSync(join(remote, "package.json"), JSON.stringify({ name: "rein-agent", version }));
		gitAt(remote, "add", "."); gitAt(remote, "commit", "-m", `Publish ${version}`);
		return gitAt(remote, "rev-parse", "HEAD");
	};
	publish("1.0.0");
	return { ...f, remote, checkout, gitAt, publish, installEnv: env,
		install: (args = ["--skip-setup"], extraEnv: NodeJS.ProcessEnv = {}) => run("/bin/bash", [installer, ...args], f.root, { ...env, ...extraEnv }),
		npmCalls: () => readFileSync(join(f.root, "npm.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

for (const scenario of ["success", "cloud", "os", "no-launch", "setup-failed", "setup-eof", "setup-cancel"] as const) test(`curl-piped installer keeps setup and chat in its controlling terminal (${scenario})`, posix, async t => {
	if (spawnSync("python3", ["--version"]).error) { t.skip("python3 is needed only to create a real test PTY"); return; }
	const f = installFixture();
	let child: ReturnType<typeof spawn> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		writeFileSync(join(f.remote, "dist/rein.js"), `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.REIN_UPDATE_FIXTURE, 'installed-cli.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'setup' && args[1] === 'edition') { console.log(['cloud','os'].includes(process.env.REIN_TEST_SCENARIO) ? process.env.REIN_TEST_SCENARIO : 'gateway');
} else if (args[0] === 'setup') {
  if (args.length !== 1 || !process.stdin.isTTY) { console.error('GUIDED_SETUP_HAS_NO_TTY'); process.exit(8); }
  console.log('OPERATOR_PROFILE_READY');
  const rl = require('node:readline').createInterface({ input: process.stdin });
  let answered = false;
  rl.once('line', line => { answered = true; console.log('OPERATOR_ANSWER=' + line); rl.close(); process.exit(process.env.REIN_TEST_SCENARIO === 'setup-failed' ? 1 : 0); });
  rl.once('close', () => { if (!answered) process.exit(1); });
} else if (args[0] === 'desktop' && args[1] === 'open') { console.log('BOT_APP_LAUNCHED');
} else if (args[0] === '--terminal') {
  if (!process.stdin.isTTY || fs.realpathSync(process.cwd()) !== fs.realpathSync(process.env.REIN_UPDATE_FIXTURE)) { console.error('CHAT_WRONG_TTY_OR_CWD'); process.exit(9); }
  console.log('INTERACTIVE_SESSION_READY');
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.once('line', line => { console.log('CHAT_ANSWER=' + line); rl.close(); process.exit(line === '/quit' ? 0 : 10); });
} else console.log('rein fixture');
`);
		f.gitAt(f.remote, "add", "dist/rein.js"); f.gitAt(f.remote, "commit", "-m", "Interactive installer fixture");
		const python = `import os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execl('/bin/bash', 'bash', '-c', 'cat "$REIN_INSTALL_SCRIPT" | /bin/bash -s -- ' + ('--no-launch' if os.environ['REIN_TEST_SCENARIO'] == 'no-launch' else ''))
seen = b''
answered = False
quit_sent = False
deadline = time.monotonic() + 15
try:
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.1)[0]:
            continue
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        seen += data
        if not answered and b'OPERATOR_PROFILE_READY' in seen:
            os.write(fd, b'\\x03' if os.environ['REIN_TEST_SCENARIO'] == 'setup-cancel' else b'\\x04' if os.environ['REIN_TEST_SCENARIO'] == 'setup-eof' else b'work-style-answer\\n')
            answered = True
        if not quit_sent and b'INTERACTIVE_SESSION_READY' in seen:
            os.write(fd, b'/quit\\n')
            quit_sent = True
    else: raise RuntimeError('installer PTY timed out')
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    os.close(fd)
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
`;
		child = spawn("python3", ["-c", python], { cwd: f.root, env: { ...f.installEnv, REIN_INSTALL_SCRIPT: installer, REIN_TEST_SCENARIO: scenario, CI: "", TERM: "xterm" } });
		let output = "";
		timer = setTimeout(() => child?.kill("SIGKILL"), 17000);
		const code = await new Promise<number | null>((resolve, reject) => {
			child!.on("error", reject); child!.on("close", resolve);
			child!.stdout!.on("data", chunk => output += chunk);
			child!.stderr!.on("data", chunk => output += chunk);
		});
		if (scenario === "setup-cancel") assert.ok(code === 130 || code === 254, output);
		else assert.equal(code, 0, output);
		if (scenario !== "setup-eof" && scenario !== "setup-cancel") assert.match(output, /OPERATOR_ANSWER=work-style-answer/);
		assert.doesNotMatch(output, /GUIDED_SETUP_HAS_NO_TTY|CHAT_WRONG_TTY_OR_CWD/);
		if (scenario === "success") assert.match(output, /CHAT_ANSWER=\/quit/);
		else assert.doesNotMatch(output, /INTERACTIVE_SESSION_READY/);
		if (scenario === "setup-failed" || scenario === "setup-eof") assert.match(output, /Setup is unfinished/);
		else if (scenario === "setup-cancel") assert.doesNotMatch(output, /Starting Rein in this terminal/);
		else assert.doesNotMatch(output, /Setup is unfinished/);
		const calls = readFileSync(join(f.root, "installed-cli.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(calls.some(args => args[0] === "desktop" && args[1] === "install"), false, "Default installs must not install NodeTerm.");
		assert.equal(calls.some(args => args.join(" ") === "desktop open"), scenario === "cloud");
		if (scenario === "cloud") assert.match(output, /BOT_APP_LAUNCHED/);
		if (scenario === "os") assert.match(output, /Dareecho assessment finished/);
		f.unchanged();
	} finally { clearTimeout(timer); child?.kill(); f.close(); }
});

test("published installer clones and updates the latest build without probing the offline model or changing state", posix, async () => {
	const f = installFixture();
	try {
		let result = await f.install(); assert.equal(result.code, 0, result.stdout + result.stderr);
		const next = f.publish("1.1.0");
		result = await f.install(); assert.equal(result.code, 0, result.stdout + result.stderr);
		assert.equal(f.gitAt(f.checkout, "rev-parse", "HEAD"), next);
		assert.equal(f.gitAt(f.checkout, "status", "--porcelain"), "");
		assert.match(result.stdout, /rein 1.1.0/);
		assert.equal(existsSync(join(f.root, "setup-called")), false);
		assert.equal(f.npmCalls().filter(args => args[0] === "ci").length, 2);
		assert.equal(f.npmCalls().filter(args => args.includes("--global")).length, 2);
		const calls = readFileSync(join(f.root, "installed-cli.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(calls.some(args => args[0] === "desktop" || args[0] === "--terminal"), false);
		f.unchanged();
	} finally { f.close(); }
});

test("terminal-only installer saves its opt-out instead of installing a native app", posix, async () => {
	const f = installFixture();
	try {
		const result = await f.install(["--skip-setup", "--terminal-only", "--no-launch"]);
		assert.equal(result.code, 0, result.stdout + result.stderr);
		const calls = readFileSync(join(f.root, "installed-cli.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.ok(calls.some(args => args.join(" ") === "desktop use terminal"));
		assert.equal(calls.some(args => args[0] === "desktop" && args[1] === "install"), false);
		f.unchanged();
	} finally { f.close(); }
});

for (const scenario of ["default", "opt-out", "unavailable", "linux"] as const) test(`combined installer handles native Mac app ${scenario} without affecting the CLI`, posix, async () => {
	const f = installFixture();
	try {
		f.program("uname", `console.log(${JSON.stringify(scenario === "linux" ? "Linux" : "Darwin")});`);
		mkdirSync(join(f.remote, "scripts"));
		writeFileSync(join(f.remote, "scripts/install-macos-app.sh"), `#!/bin/bash\nprintf '%s\\n' "$*" > "$REIN_UPDATE_FIXTURE/native-app-called"\nexit ${scenario === "unavailable" ? 1 : 0}\n`);
		f.gitAt(f.remote, "add", "."); f.gitAt(f.remote, "commit", "-m", "Native app fixture");
		const result = await f.install(["--skip-setup", ...(scenario === "opt-out" ? ["--no-app"] : [])]);
		assert.equal(result.code, 0, result.stdout + result.stderr);
		assert.equal(existsSync(join(f.root, "native-app-called")), false);
		assert.equal(existsSync(join(f.root, "native-app-called")), false, "The base install never adds an app before selection");
		assert.doesNotMatch(result.stdout, /installing the native rein-klaud app/);
		assert.ok(f.npmCalls().some(args => args.includes("--global")));
		f.unchanged();
	} finally { f.close(); }
});

test("app-only installer downloads the release helper without installing a CLI checkout", posix, async () => {
	const f = installFixture();
	try {
		f.program("uname", "console.log('Darwin');");
		const helper = '#!/bin/bash\nprintf "%s\\n" "$*" > "$REIN_UPDATE_FIXTURE/native-app-called"\n';
		f.program("curl", `const fs = require('node:fs'); const args = process.argv.slice(2);
if (args.at(-1) !== 'https://github.com/Zermo/rein-agent/releases/latest/download/install-macos-app.sh') process.exit(8);
fs.writeFileSync(args[args.indexOf('--output') + 1], ${JSON.stringify(helper)});`);
		const result = await f.install(["--app-only", "--no-launch"]);
		assert.equal(result.code, 0, result.stdout + result.stderr);
		assert.equal(readFileSync(join(f.root, "native-app-called"), "utf8").trim(), "--no-launch");
		assert.equal(existsSync(f.checkout), false);
		assert.equal(existsSync(join(f.root, "npm.jsonl")), false);
		f.unchanged();
	} finally { f.close(); }
});

test("unattended setup never opens a chat and NodeTerm installation requires its explicit flag", posix, async () => {
	const f = installFixture();
	try {
		let result = await f.install(["--yes"]);
		assert.equal(result.code, 0, result.stdout + result.stderr);
		let calls = readFileSync(join(f.root, "installed-cli.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.ok(calls.some(args => args.join(" ") === "setup --yes"));
		assert.equal(calls.some(args => args[0] === "desktop" || args[0] === "--terminal"), false);
		result = await f.install(["--skip-setup", "--nodeterm"]);
		assert.equal(result.code, 0, result.stdout + result.stderr);
		calls = readFileSync(join(f.root, "installed-cli.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.ok(calls.some(args => args.join(" ") === "desktop install --no-launch"));
		assert.equal(calls.some(args => args.join(" ") === "desktop open" || args[0] === "--terminal"), false);
		f.unchanged();
	} finally { f.close(); }
});

test("installer preserves dirty checkouts and stops when fetching a new build fails", posix, async () => {
	const f = installFixture();
	try {
		assert.equal((await f.install()).code, 0);
		const oldHead = f.gitAt(f.checkout, "rev-parse", "HEAD");
		f.publish("2.0.0");
		const local = join(f.checkout, "local-notes.txt"); writeFileSync(local, "keep me");
		let result = await f.install(); assert.equal(result.code, 1); assert.match(result.stderr, /local changes/);
		assert.equal(readFileSync(local, "utf8"), "keep me");
		assert.equal(f.gitAt(f.checkout, "rev-parse", "HEAD"), oldHead);
		rmSync(local); f.gitAt(f.checkout, "remote", "set-url", "origin", join(f.root, "missing-remote"));
		result = await f.install(); assert.equal(result.code, 1); assert.match(result.stderr, /could not fetch/);
		assert.equal(f.gitAt(f.checkout, "rev-parse", "HEAD"), oldHead);
		assert.equal(f.npmCalls().filter(args => args.includes("--global")).length, 1);
		f.unchanged();
	} finally { f.close(); }
});

test("installer rejects non-repositories and invalid branches before global installation", posix, async () => {
	const f = installFixture();
	try {
		let result = await f.install(["--branch"]); assert.equal(result.code, 2); assert.match(result.stderr, /requires a name/);
		result = await f.install(["--branch", "--bad"]); assert.equal(result.code, 1); assert.match(result.stderr, /invalid branch/);
		assert.equal(existsSync(f.checkout), false);
		mkdirSync(f.checkout); writeFileSync(join(f.checkout, "keep.txt"), "keep me");
		result = await f.install(); assert.equal(result.code, 1); assert.match(result.stderr, /not a git checkout/);
		assert.equal(readFileSync(join(f.checkout, "keep.txt"), "utf8"), "keep me");
		assert.equal(f.npmCalls().some(args => args.includes("--global")), false);
		f.unchanged();
	} finally { f.close(); }
});

test("installer reports global npm failures without claiming a successful install", posix, async () => {
	const f = installFixture();
	try {
		const result = await f.install(["--skip-setup"], { REIN_UPDATE_NPM_FAIL: "1" });
		assert.equal(result.code, 9); assert.doesNotMatch(result.stdout, /✓ installed|done\./);
		assert.equal(existsSync(join(f.root, "setup-called")), false);
		f.unchanged();
	} finally { f.close(); }
});

for (const edition of ["gateway", "cloud", "os"]) test(`installer applies explicit ${edition} after the base harness, with setup skipped`, posix, async () => {
 const f = installFixture();
 try {
  const result = await f.install(["--skip-setup", "--edition", edition, "--no-launch"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(f.npmCalls().some(args => args.includes("--global")));
  const calls = readFileSync(join(f.root, "installed-cli.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.filter(args => args.join(" ") === `setup edition --edition ${edition} --yes`).length, 1);
  assert.equal(calls.some(args => args[0] === "--terminal" || args.join(" ") === "desktop open"), false);
  f.unchanged();
 } finally { f.close(); }
});

test("installer rejects invalid or conflicting editions before touching a checkout", posix, async () => {
 const f = installFixture();
 try {
  for (const args of [["--edition"], ["--edition", "wipe"], ["--edition", "cloud", "--terminal-only"], ["--edition", "os", "--nodeterm"], ["--app-only", "--edition", "cloud"]]) {
   const result = await f.install(args); assert.equal(result.code, 2, result.stdout + result.stderr);
   assert.equal(existsSync(f.checkout), false);
  }
  assert.equal(existsSync(join(f.root, "npm.jsonl")), false); f.unchanged();
 } finally { f.close(); }
});
