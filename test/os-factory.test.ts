import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_HELP, FACTORY_VERBS, findTemplateDir, formatFactoryStatus, runFactoryCommand, setupFactory } from "../src/os/factory.ts";
import { runOSCommand } from "../src/os/command.ts";
import { probeUrl, readPidFile, serverPort, serverStatus, startServer, stopServer, writePidFile } from "../apps/factory/supervisor.mjs";

async function fakeHome(t: any) {
	const base = await mkdtemp(join(tmpdir(), "rein-os-factory-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const project = join(base, ".local", "share", "rein-factory");
	await mkdir(project, { recursive: true });
	const fakeServer = `import { createServer } from "node:http";
const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
server.listen(Number(process.env.PORT || 4111), "127.0.0.1");
`;
	await writeFile(join(project, "fake-server.mjs"), fakeServer);
	await writeFile(join(project, "package.json"), JSON.stringify({ name: "fake-factory", scripts: { start: "node fake-server.mjs", dev: "node fake-server.mjs" } }));
	await mkdir(join(project, "node_modules"), { recursive: true });
	await writeFile(join(project, ".env"), "FACTORY_SANDBOX_PROVIDER=local\n");
	const state = join(base, ".local", "state", "rein-factory");
	await mkdir(state, { recursive: true });
	return { base, project, state };
}

function envFor(home: string, port = 4199) {
	return { HOME: home, PATH: process.env.PATH, FACTORY_PORT: String(port) };
}

test("help lists every verb and nothing else is advertised", () => {
	for (const verb of FACTORY_VERBS) assert.match(FACTORY_HELP, new RegExp(`rein os factory ${verb}`));
	assert.equal(FACTORY_VERBS.length, 6);
});

test("unknown verbs and extra arguments give the usage", async () => {
	await assert.rejects(() => runFactoryCommand(["restart"]), /Usage: rein os factory setup\|start\|dev\|stop\|status\|open/);
	await assert.rejects(() => runFactoryCommand(["start", "now"]), /Usage: rein os factory start/);
	await assert.rejects(() => runFactoryCommand(["help"], { json: true }), /Usage: rein os factory help/);
});

test("status reports stopped with paths, before anything is running", async t => {
	const f = await fakeHome(t);
	const status = await serverStatus({ env: envFor(f.base), userHome: f.base });
	assert.equal(status.state, "stopped");
	assert.equal(status.url, `http://127.0.0.1:${serverPort({ env: envFor(f.base) })}`);
	assert.equal(status.projectDir, f.project);
	assert.ok(status.logFile.endsWith("server.log"));
	assert.match(formatFactoryStatus(status), /Mastra Factory: stopped/);
	assert.match(formatFactoryStatus(status), /rein os factory start/);
});

test("start, status, and stop drive one shared server", async t => {
	const f = await fakeHome(t);
	const env = envFor(f.base);
	const logs: string[] = [];
	const log = (text: string) => logs.push(text);

	const started = await startServer({ env, userHome: f.base, timeoutMs: 20_000, mode: "dev", log });
	assert.equal(started.state, "running");
	assert.ok(started.pid > 0);
	assert.equal(started.url, `http://127.0.0.1:4199`);

	const running = await serverStatus({ env, userHome: f.base });
	assert.equal(running.state, "running");
	assert.equal(running.owned, true);
	assert.equal(running.pid, started.pid);
	assert.equal(readPidFile(join(f.state, "server.pid")), started.pid);

	await assert.rejects(() => startServer({ env, userHome: f.base, timeoutMs: 20_000 }), /already running \(pid \d+\)\. Stop it first/);

	const stopped = await stopServer({ env, userHome: f.base, log });
	assert.equal(stopped.state, "stopped");
	assert.equal(await probeUrl(`http://127.0.0.1:4199`, 1000), undefined, "the port must stop answering");
	assert.equal(readPidFile(join(f.state, "server.pid")), undefined, "the pid file must be cleared");

	await assert.rejects(() => stopServer({ env, userHome: f.base }), /server is registered/);
});

test("start refuses to guess when a foreign server holds the port", async t => {
	const f = await fakeHome(t);
	const env = envFor(f.base);
	// A server with no pid file: reachable, but not owned by the supervisor.
	const { createServer } = await import("node:http");
	const server = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
	await new Promise(resolve => server.listen(4199, "127.0.0.1", resolve));
	t.after(() => new Promise(resolve => server.close(resolve)));
	await assert.rejects(() => startServer({ env, userHome: f.base, timeoutMs: 2_000 }), /does not own it/);
});

test("a stale pid file is cleared on stop instead of crashing", async t => {
	const f = await fakeHome(t);
	const env = envFor(f.base);
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
	await new Promise<void>(resolve => child.once("spawn", () => resolve()));
	const pid = child.pid!;
	await new Promise<void>(resolve => child.once("exit", () => resolve()));
	writePidFile(join(f.state, "server.pid"), pid);
	const stopped = await stopServer({ env, userHome: f.base });
	assert.equal(stopped.state, "stopped");
	assert.equal(readPidFile(join(f.state, "server.pid")), undefined);
});

test("setup installs the project once, writes a private .env, and never overwrites", async t => {
	const base = await mkdtemp(join(tmpdir(), "rein-os-factory-setup-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const project = join(base, ".local", "share", "rein-factory");
	const template = join(base, "template");
	await mkdir(join(template, "src", "mastra"), { recursive: true });
	let builds = 0;
	const build = async (dir: string) => { builds++; await mkdir(join(dir, ".mastra", "output"), { recursive: true }); };
	await writeFile(join(template, "package.json"), JSON.stringify({ scripts: { build: "node -e 1" } }));
	await writeFile(join(template, "src/mastra/index.ts"), "export const factory = {};\n");
	await writeFile(join(template, ".env.schema"), "FACTORY_SANDBOX_PROVIDER=\n");
	await writeFile(join(template, "pnpm-workspace.yaml"), "allowBuilds: {}\n");
	let installs = 0;
	const install = async (dir: string) => { installs++; await mkdir(join(dir, "node_modules"), { recursive: true }); };
	const env = { HOME: base, PATH: process.env.PATH, FACTORY_PORT: "4201" };
	process.env.HOME = base;
	t.after(() => { delete process.env.HOME; });

	const first = await setupFactory({ templateDir: template, install, build, log: () => {} });
	assert.equal(first.created, true);
	assert.equal(first.installed, true);
	assert.equal(installs, 1);
	assert.equal(builds, 1);
	const envStat = await stat(join(project, ".env"));
	assert.equal(envStat.mode & 0o777, 0o600);
	assert.match(await readFile(join(project, ".env"), "utf8"), /FACTORY_CREDENTIAL_ENCRYPTION_KEY=/);
	assert.match(await readFile(join(project, ".env"), "utf8"), /FACTORY_SANDBOX_PROVIDER=local/);

	// Second run: nothing is rewritten, nothing is reinstalled or rebuilt.
	await writeFile(join(project, "marker.txt"), "user state");
	const second = await setupFactory({ templateDir: template, install, build, log: () => {} });
	assert.equal(second.created, false);
	assert.equal(installs, 1);
	assert.equal(builds, 1);
	assert.equal(await readFile(join(project, "marker.txt"), "utf8"), "user state");
});

test("the production profile requires DATABASE_URL", async t => {
	const f = await fakeHome(t);
	const env = envFor(f.base);
	await assert.rejects(() => startServer({ env, userHome: f.base, timeoutMs: 2_000, mode: "production" }), /requires DATABASE_URL/);
});

test("start builds the server once when the project was never built", async t => {
	const f = await fakeHome(t);
	const env = { ...envFor(f.base), DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/factory" };
	await writeFile(join(f.project, "package.json"), JSON.stringify({ scripts: { start: "node fake-server.mjs", build: "node fake-build.mjs" } }));
	await writeFile(join(f.project, "fake-build.mjs"), "import { mkdirSync } from \"node:fs\"; mkdirSync(\".mastra/output\", { recursive: true });\n");
	await startServer({ env, userHome: f.base, timeoutMs: 20_000, mode: "production" });
	const { existsSync } = await import("node:fs");
	assert.ok(existsSync(join(f.project, ".mastra", "output")), "the build must have produced its output");
	await stopServer({ env, userHome: f.base });
});

test("open starts the server when needed, then hands the URL to the opener", async t => {
	const f = await fakeHome(t);
	const env = envFor(f.base);
	process.env.HOME = f.base;
	process.env.FACTORY_PORT = "4199";
	t.after(() => { delete process.env.HOME; delete process.env.FACTORY_PORT; });
	const opened: string[] = [];
	await runFactoryCommand(["open"], {}, { open: url => { opened.push(url); } });
	assert.deepEqual(opened, ["http://127.0.0.1:4199"]);
	assert.equal((await serverStatus({ env, userHome: f.base })).state, "running");
	await stopServer({ env, userHome: f.base });
});

test("rein os dispatches factory verbs and rejects foreign flags", async t => {
	const f = await fakeHome(t);
	const logs: string[] = [];
	process.env.HOME = f.base;
	process.env.FACTORY_PORT = "4202";
	t.after(() => { delete process.env.HOME; delete process.env.FACTORY_PORT; });

	await runOSCommand(["factory", "status"], {}, { log: text => logs.push(text) });
	assert.match(logs.join("\n"), /Mastra Factory: stopped/);

	await assert.rejects(() => runOSCommand(["factory", "status"], { verbose: "x" }), /Unsupported factory option --verbose/);
	await assert.rejects(() => runOSCommand(["factory", "status", "extra"], {}), /Usage: rein os factory status/);

	const helpLogs: string[] = [];
	await runOSCommand(["factory", "help"], {}, { log: text => helpLogs.push(text) });
	assert.match(helpLogs.join("\n"), /rein os factory setup/);

	// The OS help advertises the factory verbs.
	const osHelp: string[] = [];
	await runOSCommand(["help"], {}, { log: text => osHelp.push(text) });
	assert.match(osHelp.join("\n"), /rein os factory setup\|start\|dev\|stop\|status\|open/);
});

test("the template resolver finds vendor/mastra-factory from tests, source, and bundle depths", () => {
	const found = findTemplateDir();
	assert.match(found, /vendor[/\\]mastra-factory$/);
});
