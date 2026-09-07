import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { previewRain, rainFrame, RAIN_PALETTE } from "../src/os/rain.ts";
import { runOSCommand } from "../src/os/command.ts";
const exec = promisify(execFile);

function terminal(t: test.TestContext, wasRaw = false) {
	const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: wasRaw, modes: [] as boolean[], setRawMode(value: boolean) { this.isRaw = value; this.modes.push(value); return this; } });
	let text = "";
	const output = Object.assign(new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } }), { isTTY: true, columns: 81, rows: 25 });
	input.pause();
	t.after(() => { input.destroy(); output.destroy(); });
	return { input, output, text: () => text, io: { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, env: { TERM: "xterm-256color" } } };
}

test("plain static frames are bounded, deterministic and distinct from animation", () => {
	const first = rainFrame({ width: 60, height: 20, frame: 0 });
	assert.equal(first, rainFrame({ width: 60, height: 20, frame: 0 }));
	assert.notEqual(first, rainFrame({ width: 60, height: 20, frame: 8 }));
	assert.equal(first.split("\n").length, 20);
	assert.ok(first.split("\n").every(line => line.length === 60));
	assert.match(first, /rein-dərāchō \/ RAIN FIELD/); assert.match(first, /STATIC PREVIEW/); assert.doesNotMatch(first, /\x1b/);
	assert.equal(rainFrame({ width: 100000, height: 100000 }).split("\n").length, 48);
	assert.ok(rainFrame({ width: 100000 }).split("\n").every(line => line.length === 160));
	assert.equal(rainFrame({ width: 1, height: 1 }).length, 1);
});

test("static default and reduced motion never enter raw mode or take the screen", async t => {
	const f = terminal(t);
	await previewRain({}, f.io);
	await previewRain({ animate: true }, { ...f.io, env: { REIN_REDUCED_MOTION: "1" } });
	assert.equal(f.input.isPaused(), true); assert.deepEqual(f.input.modes, []);
	assert.doesNotMatch(f.text(), /\x1b/); assert.match(f.text(), /STATIC PREVIEW/);
});

test("animation requires an interactive input and output before altering either", async t => {
	const f = terminal(t);
	f.output.isTTY = false;
	await assert.rejects(previewRain({ animate: true }, f.io), /interactive terminal/);
	f.output.isTTY = true; f.input.isTTY = false;
	await assert.rejects(previewRain({ animate: true }, f.io), /interactive terminal/);
	f.input.isTTY = true;
	await assert.rejects(previewRain({ animate: true }, { ...f.io, env: { TERM: "dumb" } }), /interactive terminal/);
	assert.equal(f.text(), ""); assert.deepEqual(f.input.modes, []);
});

test("q and Ctrl-C restore raw mode, the cursor, alternate screen and event handlers", async t => {
	for (const key of ["q", "\x03"]) {
		const f = terminal(t), signals = ["SIGINT", "SIGTERM", "SIGHUP"].map(name => process.listenerCount(name));
		const run = previewRain({ animate: true }, f.io);
		assert.equal(f.input.isRaw, true); assert.match(f.text(), /\x1b\[\?1049h/);
		f.input.emit("data", Buffer.from(key)); await run;
		assert.deepEqual(f.input.modes, [true, false]); assert.equal(f.input.isPaused(), true);
		assert.ok(f.text().endsWith("\x1b[0m\x1b[?25h\x1b[?1049l"));
		assert.equal(f.input.listenerCount("data"), 0);
		assert.deepEqual(["SIGINT", "SIGTERM", "SIGHUP"].map(name => process.listenerCount(name)), signals);
	}
});

test("animation resizes without wrapping and cancellation preserves a preexisting raw mode", async t => {
	const f = terminal(t, true), controller = new AbortController();
	const run = previewRain({ animate: true }, { ...f.io, signal: controller.signal, env: { NO_COLOR: "1" } });
	f.output.columns = 30; f.output.rows = 12;
	await new Promise(resolve => setTimeout(resolve, 155));
	controller.abort(); await run;
	assert.deepEqual(f.input.modes, [true, true]);
	assert.doesNotMatch(f.text(), /38;2;/);
	const lastFrame = f.text().split("\x1b[H").at(-1)!.split("\x1b[J")[0];
	assert.equal(lastFrame.split("\r\n").length, 11);
	assert.ok(lastFrame.split("\r\n").every(line => line.length === 29));
});

test("terminal output failure and termination both restore input", async t => {
	const f = terminal(t), run = previewRain({ animate: true }, f.io);
	f.output.emit("error", new Error("fixture output closed"));
	await assert.rejects(run, /fixture output closed/);
	assert.deepEqual(f.input.modes, [true, false]);
	const other = terminal(t), stopped = previewRain({ animate: true }, other.io);
	process.emit("SIGTERM"); await stopped;
	assert.deepEqual(other.input.modes, [true, false]);
});

test("rain command validates options before previewing and does not probe hardware", async () => {
	let renders = 0;
	const deps = { rain: async (options: unknown) => { assert.deepEqual(options, { animate: false, static: true }); renders++; }, hardware: async () => { assert.fail("preview must not probe hardware"); } };
	await runOSCommand(["rain"], { animate: "false", static: true }, deps);
	assert.equal(renders, 1);
	for (const flags of [{ animate: true, static: true }, { animate: "maybe" }, { output: "anywhere" }, { json: true }]) await assert.rejects(runOSCommand(["rain"], flags, deps));
	assert.equal(renders, 1);
});

test("source CLI static rain creates no config and animation refuses pipes", async t => {
	const home = await mkdtemp(join(tmpdir(), "rein-os-rain-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const cli = fileURLToPath(new URL("../bin/rein.js", import.meta.url)), env = { ...process.env, REIN_HOME: home, REIN_REDUCED_MOTION: "0" };
	const still = await exec(process.execPath, [cli, "os", "rain", "--static"], { env });
	assert.match(still.stdout, /SAME JOURNEY/); assert.doesNotMatch(still.stdout, /\x1b/);
	await assert.rejects(exec(process.execPath, [cli, "os", "rain", "--animate"], { env }), /interactive terminal/);
	assert.deepEqual(await readdir(home), []);
});

test("OS theme and terminal palette agree and wallpaper is a static self-contained SVG", async () => {
	const theme = JSON.parse(await readFile(new URL("../src/os/assets/rain/theme.json", import.meta.url), "utf8"));
	assert.deepEqual(theme.palette, RAIN_PALETTE);
	assert.deepEqual(theme.motion, { default: "static", terminalFramesPerSecond: 8 });
	assert.deepEqual(theme.supportedSurfaces, ["terminal-preview", "static-wallpaper"]);
	assert.equal(theme.desktopIntegration, "not-installed");
	const wallpaper = await readFile(new URL("../src/os/assets/rain/wallpaper.svg", import.meta.url), "utf8");
	assert.match(wallpaper, /width="1920" height="1080"/);
	assert.doesNotMatch(wallpaper, /<script|<animate|<set\b|(?:href|src)\s*=|@import|@font-face|url\(https?:/i);
	for (const color of Object.values(RAIN_PALETTE)) assert.ok(wallpaper.includes(color));
});

test("real terminal preview exits on q and Ctrl-C with original terminal modes restored", { timeout: 10000, skip: process.platform === "win32" }, async () => {
	const cli = fileURLToPath(new URL("../bin/rein.js", import.meta.url));
	const script = `import os, pty, select, subprocess, sys, termios, time
for key in (b'q', b'\\x03'):
    master, slave = pty.openpty()
    before = termios.tcgetattr(slave)
    env = dict(os.environ, TERM='xterm-256color', REIN_REDUCED_MOTION='0')
    child = subprocess.Popen([sys.argv[1], sys.argv[2], 'os', 'rain', '--animate'], stdin=slave, stdout=slave, stderr=slave, env=env)
    output = b''
    try:
        deadline = time.monotonic() + 3
        while b'RAIN PREVIEW' not in output and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]: output += os.read(master, 32768)
        assert b'RAIN PREVIEW' in output, output
        os.write(master, key)
        deadline = time.monotonic() + 3
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]: output += os.read(master, 32768)
        assert child.poll() == 0, 'preview did not exit after its quit key'
        while select.select([master], [], [], 0.1)[0]: output += os.read(master, 32768)
        assert b'\\x1b[?25h\\x1b[?1049l' in output, 'screen was not restored'
        assert termios.tcgetattr(slave) == before, 'terminal modes were not restored'
    finally:
        if child.poll() is None: child.kill(); child.wait()
        os.close(master); os.close(slave)
print('RAIN_PTY_RESTORED')`;
	assert.match((await exec("python3", ["-c", script, process.execPath, cli], { timeout: 9000 })).stdout, /RAIN_PTY_RESTORED/);
});
