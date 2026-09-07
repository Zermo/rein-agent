import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, spawn } from "node:child_process";
import { desktopCommand, launchKlaud } from "../src/harness/desktop/cli.ts";
import { preferSurface, preferredSurface } from "../src/harness/desktop/surface.ts";
import { buildSystemPrompt } from "../src/harness/system-prompt.ts";
import { main } from "../src/cli.ts";

function appFixture(built = true) {
	const root = mkdtempSync(join(tmpdir(), "rein-klaud-launch-"));
	mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
	writeFileSync(join(root, "main.mjs"), "// fixture; never executed");
	writeFileSync(join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron"), "fixture; never executed", { mode: 0o700 });
	if (built) { mkdirSync(join(root, "dist")); writeFileSync(join(root, "dist", "index.html"), "fixture"); }
	return root;
}

test("missing klaud installation gives manual npm instructions without starting serve or a child", async () => {
	const root = mkdtempSync(join(tmpdir(), "rein-klaud-missing-")), output: string[] = [];
	try {
		await launchKlaud({ appDir: root, log: message => output.push(message),
			start: async () => { throw new Error("must not start serve"); },
			spawn: (() => { throw new Error("must not launch software"); }) as typeof spawn });
		assert.match(output.join("\n"), /rein serve/);
		assert.match(output.join("\n"), /cd apps\/klaud && npm install && npm run dev/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("klaud child gets credentials only through env and closes its owned backend on exit", async () => {
	const root = appFixture(), signals = new EventEmitter(), output: string[] = [];
	let closes = 0, started = false, calls = 0;
	try {
		await launchKlaud({ appDir: root, signals, log: message => output.push(message),
			start: async () => { started = true; return { url: "http://127.0.0.1:49152", token: "fixture-secret", close: async () => { closes++; } }; },
			spawn: ((command, args, options) => {
				calls++;
				if (calls === 1) {
					assert.equal(started, false); assert.match(command, /^npm(?:\.cmd)?$/);
					assert.deepEqual(args, ["--prefix", root, "run", "build"]);
					assert.equal(options.env.REIN_KLAUD_TOKEN, undefined);
				} else {
					assert.equal(started, true); assert.equal(closes, 0);
					assert.match(command, /node_modules[/\\]\.bin[/\\]electron/);
					assert.deepEqual(args, [root]);
					assert.equal(options.env.REIN_KLAUD_URL, "http://127.0.0.1:49152");
					assert.equal(options.env.REIN_KLAUD_TOKEN, "fixture-secret");
					assert.equal(options.env.REIN_SURFACE, "klaud");
				}
				assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
				assert.equal(options.shell, false); assert.equal(options.stdio, "inherit");
				const child = new EventEmitter();
				queueMicrotask(() => child.emit("close", 0));
				return child as ChildProcess;
			}) as typeof spawn });
		assert.equal(closes, 1); assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);
		assert.doesNotMatch(output.join("\n"), /fixture-secret/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("klaud spawn failures close the owned backend and remove signal listeners", async () => {
	const root = appFixture(), signals = new EventEmitter();
	try {
		for (const synchronous of [false, true]) {
			let closes = 0, calls = 0;
			await assert.rejects(launchKlaud({ appDir: root, signals,
				start: async () => ({ url: "http://127.0.0.1:49152", token: "fixture", close: async () => { closes++; } }),
				spawn: (() => {
					if (++calls === 1) {
						const child = new EventEmitter();
						queueMicrotask(() => child.emit("close", 0));
						return child as ChildProcess;
					}
					if (synchronous) throw new Error("fixture launch failed");
					const child = new EventEmitter();
					queueMicrotask(() => child.emit("error", new Error("fixture launch failed")));
					return child as ChildProcess;
				}) as typeof spawn }), /fixture launch failed/);
			assert.equal(closes, 1); assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI cancellation closes serve promptly, terminates Electron, and preserves a signal exit code", async () => {
	const root = appFixture(), previousExitCode = process.exitCode;
	try {
		for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
			const signals = new EventEmitter(); let closes = 0, calls = 0;
			await launchKlaud({ appDir: root, signals,
				start: async () => ({ url: "http://127.0.0.1:49152", token: "fixture", close: async () => { closes++; } }),
				spawn: (() => {
					if (++calls === 1) {
						const child = new EventEmitter();
						queueMicrotask(() => child.emit("close", 0));
						return child as ChildProcess;
					}
					const child = new EventEmitter() as ChildProcess;
					child.kill = (sent) => {
						assert.ok(sent === "SIGTERM" || sent === "SIGKILL"); assert.equal(closes, 1);
						if (sent === "SIGTERM") queueMicrotask(() => child.emit("close", null, "SIGTERM"));
						return true;
					};
					queueMicrotask(() => signals.emit(signal));
					return child;
				}) as typeof spawn });
			assert.equal(closes, 1); assert.equal(process.exitCode, code);
			assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGTERM"), 0);
		}
	} finally { process.exitCode = previousExitCode; rmSync(root, { recursive: true, force: true }); }
});

test("every klaud launch builds its current renderer before starting serve; build failure starts no backend", async () => {
	const root = appFixture(), previousExitCode = process.exitCode;
	try {
		for (const buildCode of [0, 1]) {
			let starts = 0, closes = 0, calls = 0;
			await launchKlaud({ appDir: root, signals: new EventEmitter(),
				start: async () => { starts++; return { url: "http://127.0.0.1:49152", token: "fixture", close: async () => { closes++; } }; },
				spawn: ((command, args, options) => {
					calls++;
					if (calls === 1) {
						assert.equal(starts, 0); assert.match(command, /^npm(?:\.cmd)?$/);
						assert.deepEqual(args, ["--prefix", root, "run", "build"]);
						assert.equal(options.env.REIN_KLAUD_TOKEN, undefined);
					} else { assert.equal(starts, 1); assert.match(command, /electron/); }
					const child = new EventEmitter();
					queueMicrotask(() => child.emit("close", calls === 1 ? buildCode : 0));
					return child as ChildProcess;
				}) as typeof spawn });
			assert.equal(starts, buildCode === 0 ? 1 : 0);
			assert.equal(closes, starts);
			assert.equal(calls, buildCode === 0 ? 2 : 1);
		}
	} finally { process.exitCode = previousExitCode; rmSync(root, { recursive: true, force: true }); }
});

test("klaud prompt follows actual surface context, with explicit surface taking priority", () => {
	const root = mkdtempSync(join(tmpdir(), "rein-klaud-prompt-"));
	const old = { REIN_HOME: process.env.REIN_HOME, REIN_SURFACE: process.env.REIN_SURFACE, REIN_KLAUD: process.env.REIN_KLAUD };
	try {
		process.env.REIN_HOME = root; delete process.env.REIN_SURFACE; delete process.env.REIN_KLAUD;
		preferSurface("klaud", root);
		assert.doesNotMatch(buildSystemPrompt(root), /You're in rein-klaʊd/);
		process.env.REIN_SURFACE = "klaud";
		assert.match(buildSystemPrompt(root), /You're in rein-klaʊd/);
		assert.doesNotMatch(buildSystemPrompt(root, "terminal"), /You're in rein-klaʊd/);
		assert.doesNotMatch(buildSystemPrompt(root, "nodeterm"), /You're in rein-klaʊd/);
		process.env.REIN_SURFACE = "terminal"; process.env.REIN_KLAUD = "1";
		assert.doesNotMatch(buildSystemPrompt(root), /You're in rein-klaʊd/);
		assert.match(buildSystemPrompt(root, "klaud"), /You're in rein-klaʊd/);
		delete process.env.REIN_SURFACE;
		assert.match(buildSystemPrompt(root), /You're in rein-klaʊd/);
	} finally {
		for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(root, { recursive: true, force: true });
	}
});

test("desktop use persists klaud and both new command help paths describe loopback AG-UI", async () => {
	const root = mkdtempSync(join(tmpdir(), "rein-klaud-cli-")), oldHome = process.env.REIN_HOME, oldLog = console.log;
	const output: string[] = [];
	try {
		process.env.REIN_HOME = root; console.log = (...values) => output.push(values.join(" "));
		await desktopCommand(["use", "klaud"], {});
		assert.equal(preferredSurface(root), "klaud");
		for (const command of ["serve", "klaud"]) {
			output.length = 0; await main([command, "--help"]);
			assert.match(output.join("\n"), /rein-klaʊd/);
			assert.match(output.join("\n"), /loopback.*AG-UI/);
		}
		await assert.rejects(main(["klaud", "extra"]), /Usage: rein klaud/);
		await assert.rejects(main(["klaud", "--port", "9000"]), /Usage: rein klaud/);
	} finally {
		console.log = oldLog; if (oldHome === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = oldHome;
		rmSync(root, { recursive: true, force: true });
	}
});
