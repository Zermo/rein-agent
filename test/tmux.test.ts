import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxShells, createTmuxTool, shellQuote } from "../src/harness/tmux.ts";
import { createBashTool } from "../src/harness/tools/bash.ts";

const exec = promisify(execFile);
const realTmux = (() => { try { return execFileSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
const real = { skip: !realTmux, timeout: 15_000 };

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!await check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for the tmux fixture.");
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

async function isolated(run: (dir: string, shells: TmuxShells) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "rein-tmux-test-"));
	const previous = process.env.REIN_HOME, previousPath = process.env.PATH;
	process.env.REIN_HOME = join(dir, "home");
	const shells = new TmuxShells(dir);
	try { await run(dir, shells); }
	finally {
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
		if (realTmux) await exec(realTmux, ["-L", shells.socket, "kill-server"]).catch(() => {});
		if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("tmux shells preserve environment and cwd across instances, capture recent output, send literal input, and stop", real, () => isolated(async (dir, shells) => {
	assert.deepEqual(await shells.list(), []);
	const id = await shells.start("export REIN_TMUX_VALUE='persistent value'; mkdir nested; cd nested; printf ready > ../ready");
	await until(() => existsSync(join(dir, "ready")));
	const resumed = new TmuxShells(dir);
	assert.deepEqual((await resumed.list()).map(s => s.id), [id]);
	await resumed.send(id, "printf '%s|%s' \"$REIN_TMUX_VALUE\" \"$PWD\" > ../state; printf 'CAPTURE_SENTINEL\\n'");
	await until(() => existsSync(join(dir, "state")));
	assert.equal(readFileSync(join(dir, "state"), "utf8"), `persistent value|${join(realpathSync(dir), "nested")}`);
	await until(async () => (await resumed.capture(id, 3)).includes("\nCAPTURE_SENTINEL\n"));
	await resumed.send(id, "printf ENTER_SENTINEL > ../entered", false);
	assert.equal(existsSync(join(dir, "entered")), false);
	await resumed.send(id, "", true);
	await until(() => existsSync(join(dir, "entered")));
	assert.equal(readFileSync(join(dir, "entered"), "utf8"), "ENTER_SENTINEL");
	await assert.rejects(resumed.attach(id), /interactive terminal/);
	await resumed.stop(id);
	assert.deepEqual(await resumed.list(), []);
	await assert.rejects(resumed.capture(id));
}));

test("tmux ownership isolates workspaces, accepts canonical aliases, and rejects unowned or malformed targets", real, () => isolated(async (dir, shells) => {
	const otherDir = join(dir, "other"); mkdirSync(otherDir);
	const other = new TmuxShells(otherDir);
	const first = await shells.start(), second = await other.start();
	assert.deepEqual((await shells.list()).map(s => s.id), [first]);
	assert.deepEqual((await other.list()).map(s => s.id), [second]);
	for (const action of [() => other.capture(first), () => other.send(first, "false"), () => other.interrupt(first), () => other.stop(first), () => other.split(first, "sleep 30")]) {
		await assert.rejects(action, /this workspace/);
	}
	await assert.rejects(shells.capture(first + ";kill-server"), /this workspace/);
	const alias = join(dir, "alias"); symlinkSync(dir, alias);
	assert.deepEqual((await new TmuxShells(alias).list()).map(s => s.id), [first]);
	await exec(realTmux, ["-L", shells.socket, "set-option", "-t", first, "@rein-workspace", "foreign"]);
	assert.deepEqual(await shells.list(), []);
	await assert.rejects(shells.send(first, "false"), /not owned/);
	assert.deepEqual((await other.list()).map(s => s.id), [second]);
}));

test("tmux interrupt stops the foreground job while completed persistent shells survive run cancellation", real, () => isolated(async (dir, shells) => {
	const controller = new AbortController();
	const id = await shells.start(undefined, controller.signal);
	controller.abort();
	assert.deepEqual((await shells.list()).map(s => s.id), [id]);
	await shells.send(id, "printf ready > running; sleep 30 && printf escaped > escaped");
	await until(() => existsSync(join(dir, "running")));
	await shells.interrupt(id);
	await until(async () => (await exec(realTmux, ["-L", shells.socket, "display-message", "-p", "-t", `${id}:0.0`, "#{pane_current_command}"])).stdout.trim() === "bash");
	await shells.send(id, "printf resumed > resumed");
	await until(() => existsSync(join(dir, "resumed")));
	assert.equal(existsSync(join(dir, "escaped")), false);
	await assert.rejects(shells.capture(id, 200, controller.signal), /abort/i);
	assert.deepEqual((await shells.list()).map(s => s.id), [id]);
}));

test("tmux visual split runs a quoted command in its workspace and leaves the main shell selected", real, () => isolated(async (dir, shells) => {
	const id = await shells.start();
	const path = join(dir, "panel marker 'quoted'");
	const text = "panel 'value' $HOME; literal";
	const pane = await shells.split(id, `printf '%s' ${shellQuote(text)} > ${shellQuote(path)}; sleep 30`);
	assert.match(pane, /^%\d+$/);
	await until(() => existsSync(path));
	assert.equal(readFileSync(path, "utf8"), text);
	const rows = (await exec(realTmux, ["-L", shells.socket, "list-panes", "-t", id, "-F", "#{pane_index}:#{pane_active}:#{pane_id}"])).stdout.trim().split("\n");
	assert.equal(rows.length, 2);
	assert.ok(rows[0].startsWith("0:1:"));
	assert.ok(rows[1].endsWith(pane));
	const widths = (await exec(realTmux, ["-L", shells.socket, "list-panes", "-t", id, "-F", "#{pane_width}"])).stdout.trim().split("\n").map(Number);
	assert.deepEqual(widths, [71, 48], "The side pane occupies 40% of the 120-column window, with one divider column.");
	await shells.send(id, "printf main > main");
	await until(() => existsSync(join(dir, "main")));
}));

function delayedTmux(dir: string, subcommand: string, delay: number): string {
	const bin = join(dir, "bin"); mkdirSync(bin);
	const marker = join(dir, "created");
	const path = join(bin, "tmux");
	writeFileSync(path, `#!/bin/sh\n${shellQuote(realTmux)} "$@"\ncode=$?\ncase " $* " in *" ${subcommand} "*) printf ready > ${shellQuote(marker)}; exec /bin/sleep ${delay};; esac\nexit "$code"\n`);
	chmodSync(path, 0o700);
	process.env.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
	return marker;
}

test("cancelling tmux start after server creation cleans the untagged session", real, () => isolated(async (dir, shells) => {
	const marker = delayedTmux(dir, "new-session", 10);
	const controller = new AbortController();
	const pending = shells.start(undefined, controller.signal);
	await until(() => existsSync(marker));
	controller.abort();
	await assert.rejects(pending, /abort/i);
	// Listing only tagged sessions would miss the original untagged-session leak.
	const all = await exec(realTmux, ["-L", shells.socket, "list-sessions", "-F", "#{session_name}"]).then(r => r.stdout, () => "");
	assert.equal(all.trim(), "");
}));

test("cancelling a visual split cleans only its new pane and preserves the main shell", real, () => isolated(async (dir, shells) => {
	const id = await shells.start();
	const marker = delayedTmux(dir, "split-window", 0.2);
	const controller = new AbortController();
	const pending = shells.split(id, "sleep 30", controller.signal);
	await until(() => existsSync(marker));
	controller.abort();
	await assert.rejects(pending, /abort/i);
	const panes = (await exec(realTmux, ["-L", shells.socket, "list-panes", "-t", id, "-F", "#{pane_id}"])).stdout.trim().split("\n");
	assert.equal(panes.length, 1);
	assert.deepEqual((await shells.list()).map(s => s.id), [id]);
}));

test("bash tmux mode exposes a reusable session ID while foreground bash remains ordinary exec", real, () => isolated(async (dir, shells) => {
	const tool = createBashTool(dir);
	const started = await tool.execute("start", { mode: "tmux", command: "export REIN_PERSISTED=yes; printf ready > ready" });
	assert.equal(started.isError, undefined);
	const id = String(started.details?.session);
	assert.equal(started.details?.persistent, true);
	assert.deepEqual((await shells.list()).map(s => s.id), [id]);
	await until(() => existsSync(join(dir, "ready")));
	const sent = await tool.execute("reuse", { mode: "tmux", session: id, command: "printf '%s' \"$REIN_PERSISTED\" > persisted" });
	assert.equal(sent.isError, undefined);
	await until(() => existsSync(join(dir, "persisted")));
	assert.equal(readFileSync(join(dir, "persisted"), "utf8"), "yes");
	const foreground = await tool.execute("foreground", { command: "printf '%s' \"${REIN_PERSISTED-unset}\"" });
	assert.equal(foreground.content, "unset");
	assert.equal(foreground.details?.persistent, undefined);
	const native = await createTmuxTool(dir).execute("start", { op: "start" });
	assert.equal(native.isError, undefined);
	assert.match(String(native.details?.session), /^rein-/);
}));

test("missing tmux reports an actionable tool error without disabling foreground bash", () => isolated(async (dir, shells) => {
	const bin = join(dir, "only-bash"); mkdirSync(bin); symlinkSync("/bin/bash", join(bin, "bash"));
	process.env.PATH = bin;
	await assert.rejects(shells.list(), /tmux is not installed/);
	const persistent = await createBashTool(dir).execute("missing", { mode: "tmux", command: "printf ready" });
	assert.equal(persistent.isError, true);
	assert.match(persistent.content, /tmux is not installed/);
	assert.equal((await createBashTool(dir).execute("foreground", { command: "printf foreground" })).content, "foreground");
}));

test("new tmux shells and splits use current environment, remove old keys, and keep values off argv", real, () => isolated(async (dir, shells) => {
	const names = ["REIN_TMUX_FIXTURE_KEY", "REIN_TMUX_FIXTURE_REMOVED", "REIN_TMUX_FIXTURE_SPECIAL", "REIN_TMUX_FIXTURE_OVERRIDE"];
	const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
	const bin = join(dir, "logging-bin"); mkdirSync(bin);
	const log = join(dir, "argv.log");
	writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${shellQuote(log)}\nexec ${shellQuote(realTmux)} "$@"\n`);
	chmodSync(join(bin, "tmux"), 0o700);
	process.env.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
	const special = "quote ' double \" dollar $HOME $(printf expanded) backtick `printf expanded` format #{session_name} backslash \\ semicolon ;\nSECOND=value\ntrailing\n";
	const inspect = (path: string) => `${shellQuote(process.execPath)} -e ${shellQuote("require('node:fs').writeFileSync(process.argv[1], JSON.stringify({key:process.env.REIN_TMUX_FIXTURE_KEY,removed:process.env.REIN_TMUX_FIXTURE_REMOVED,special:process.env.REIN_TMUX_FIXTURE_SPECIAL,override:process.env.REIN_TMUX_FIXTURE_OVERRIDE,path:process.env.PATH,home:process.env.REIN_HOME,pane:process.env.TMUX_PANE,tmux:process.env.TMUX}))")} ${shellQuote(path)}`;
	try {
		process.env.REIN_TMUX_FIXTURE_KEY = "INITIAL_SECRET_SENTINEL";
		process.env.REIN_TMUX_FIXTURE_REMOVED = "REMOVED_SECRET_SENTINEL";
		process.env.REIN_TMUX_FIXTURE_SPECIAL = special;
		const original = await shells.start(inspect(join(dir, "original.json")));
		await until(() => existsSync(join(dir, "original.json")));
		process.env.REIN_TMUX_FIXTURE_KEY = "CURRENT_SECRET_SENTINEL";
		process.env.PATH = `${join(dir, "current-path")}:${process.env.PATH}`;
		delete process.env.REIN_TMUX_FIXTURE_REMOVED;
		const current = await shells.start(inspect(join(dir, "current.json")), undefined, {
			REIN_TMUX_FIXTURE_OVERRIDE: "OVERRIDE_SECRET_SENTINEL", REIN_HOME: join(dir, "current-home"),
		});
		await until(() => existsSync(join(dir, "current.json")));
		const updated = JSON.parse(readFileSync(join(dir, "current.json"), "utf8"));
		assert.equal(updated.key, "CURRENT_SECRET_SENTINEL");
		assert.equal(updated.removed, undefined);
		assert.equal(updated.special, special);
		assert.equal(updated.override, "OVERRIDE_SECRET_SENTINEL");
		assert.equal(updated.path === process.env.PATH, true, "The new shell must use the current PATH.");
		assert.equal(updated.home, join(dir, "current-home"));
		assert.match(updated.pane, /^%\d+$/);
		assert.ok(updated.tmux.includes(shells.socket));
		process.env.REIN_TMUX_FIXTURE_KEY = "SPLIT_SECRET_SENTINEL";
		const splitPath = `${join(dir, "split-path")}:${process.env.PATH}`;
		await shells.split(current, inspect(join(dir, "split.json")) + "; sleep 30", undefined, {
			REIN_TMUX_FIXTURE_SPECIAL: undefined, REIN_TMUX_FIXTURE_OVERRIDE: "SPLIT_OVERRIDE_SENTINEL", PATH: splitPath, REIN_HOME: join(dir, "split-home"),
		});
		await until(() => existsSync(join(dir, "split.json")));
		const split = JSON.parse(readFileSync(join(dir, "split.json"), "utf8"));
		assert.equal(split.key, "SPLIT_SECRET_SENTINEL");
		assert.equal(split.removed, undefined);
		assert.equal(split.special, undefined);
		assert.equal(split.override, "SPLIT_OVERRIDE_SENTINEL");
		assert.equal(split.path === splitPath, true, "The visual child must use its explicit PATH override.");
		assert.equal(split.home, join(dir, "split-home"));
		assert.notEqual(split.pane, updated.pane);
		await shells.send(original, inspect(join(dir, "unchanged.json")));
		await until(() => existsSync(join(dir, "unchanged.json")));
		assert.equal(JSON.parse(readFileSync(join(dir, "unchanged.json"), "utf8")).key, "INITIAL_SECRET_SENTINEL");
		assert.doesNotMatch(readFileSync(log, "utf8"), /(?:INITIAL|REMOVED|CURRENT|OVERRIDE|SPLIT)_SECRET_SENTINEL|SPLIT_OVERRIDE_SENTINEL|SECOND=value/);
	} finally {
		for (const name of names) if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
	}
}));

test("visual harness sessions use a separate server from model-controlled persistent shells", real, () => isolated(async (dir, shells) => {
	const visual = new TmuxShells(dir, "visual");
	assert.notEqual(visual.socket, shells.socket);
	try {
		const shellId = await shells.start(), visualId = await visual.start();
		assert.deepEqual((await shells.list()).map(s => s.id), [shellId]);
		assert.deepEqual((await visual.list()).map(s => s.id), [visualId]);
		assert.deepEqual(JSON.parse((await createTmuxTool(dir).execute("list", { op: "list" })).content).map((s: any) => s.id), [shellId]);
		await assert.rejects(shells.send(visualId, "exit"));
		await assert.rejects(shells.stop(visualId));
		assert.deepEqual((await visual.list()).map(s => s.id), [visualId]);
	} finally { await exec(realTmux, ["-L", visual.socket, "kill-server"]).catch(() => {}); }
}));

test("tmux environment initialization errors redact configuration and clean the new session", real, () => isolated(async (dir, shells) => {
	const bin = join(dir, "error-bin"); mkdirSync(bin);
	writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncase " $* " in *" source-file "*) printf 'PRIVATE_ENV_SENTINEL parser failure\\n' >&2; exit 1;; esac\nexec ${shellQuote(realTmux)} "$@"\n`);
	chmodSync(join(bin, "tmux"), 0o700);
	process.env.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
	const result = await createTmuxTool(dir).execute("start", { op: "start" });
	assert.equal(result.isError, true);
	assert.match(result.content, /current shell environment/);
	assert.doesNotMatch(result.content, /PRIVATE_ENV_SENTINEL/);
	assert.deepEqual(await shells.list(), []);
}));
