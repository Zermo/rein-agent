import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createBot, getBot, listBots } from "../src/harness/klaud/bots.ts";
import { createSession, sessionPath, sessionsDir } from "../src/agent/session.ts";

function fixture(t: test.TestContext): string {
	const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "rein-klaud-bots-")));
	const previous = process.env.REIN_HOME;
	process.env.REIN_HOME = join(home, "ambient");
	t.after(() => {
		if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous;
		fs.rmSync(home, { recursive: true, force: true });
	});
	return home;
}

const registry = (home: string) => join(home, "klaud", "bots.json");

test("bots create, list, and reopen the same private JSONL session", (t) => {
	const home = fixture(t);
	assert.deepEqual(listBots(home), []);
	assert.deepEqual(fs.readdirSync(home), []);
	const bot = createBot("  Research  ", home);
	assert.equal(bot.name, "Research");
	assert.match(bot.id, /^klaud-bot-[a-f0-9]{8}$/);
	assert.equal(new Date(bot.created).toISOString(), bot.created);
	assert.deepEqual(listBots(home), [bot]);
	assert.deepEqual(getBot(bot.id, home), bot);
	const file = sessionPath(bot.sessionId, home);
	const header = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(header.type, "header");
	assert.equal(header.version, 1);
	assert.equal(header.id, bot.sessionId);
	assert.equal(header.cwd, process.cwd());
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(fs.statSync(registry(home)).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(join(home, "klaud")), ["bots.json"]);
	const copy = listBots(home);
	copy[0].name = "Changed locally";
	assert.equal(getBot(bot.id, home).name, "Research");
});

test("explicit homes do not alter ambient session paths or REIN_HOME", (t) => {
	const home = fixture(t);
	const ambient = process.env.REIN_HOME;
	const explicit = join(home, "explicit");
	const sessionId = createSession({ cwd: process.cwd() }, explicit);
	assert.equal(fs.existsSync(sessionPath(sessionId, explicit)), true);
	assert.equal(sessionsDir(), join(ambient!, "sessions"));
	assert.equal(sessionPath(sessionId), join(ambient!, "sessions", `${sessionId}.jsonl`));
	assert.equal(process.env.REIN_HOME, ambient);
	const bot = createBot("Explicit", explicit);
	assert.equal(process.env.REIN_HOME, ambient);
	assert.equal(fs.existsSync(ambient!), false);
	assert.deepEqual(listBots(explicit), [bot]);
	const defaultBot = createBot("Default");
	assert.deepEqual(listBots(), [defaultBot]);
	assert.equal(fs.existsSync(sessionPath(defaultBot.sessionId)), true);
});

test("bot names and lookup ids reject invalid input before creating files", (t) => {
	const home = fixture(t);
	for (const name of ["", "   ", "a".repeat(65), "hello\nworld", "\tName", "Name\r", "zero\0", "delete\x7f", "control\x85", null, 12]) {
		assert.throws(() => createBot(name as string, home), /name/i);
	}
	for (const id of ["../outside", "klaud-bot-nope", "", null]) assert.throws(() => getBot(id as string, home), /id/i);
	assert.throws(() => getBot("klaud-bot-aaaaaaaa", home), /no such bot/i);
	assert.deepEqual(fs.readdirSync(home), []);
	assert.equal(createBot("a".repeat(64), home).name.length, 64);
});

test("malformed registries and duplicate identities are preserved without creating sessions", (t) => {
	const home = fixture(t);
	fs.mkdirSync(join(home, "klaud"));
	const bot = { id: "klaud-bot-deadbeef", name: "Fixture", sessionId: "session-fixture", created: "2026-01-01T00:00:00.000Z" };
	for (const raw of [
		"{broken", "null", JSON.stringify({ version: 2, bots: [] }), JSON.stringify({ version: 1, bots: {} }),
		JSON.stringify({ version: 1, bots: [bot, bot] }),
		JSON.stringify({ version: 1, bots: [bot, { ...bot, id: "klaud-bot-abcdefab" }] }),
		...[{ name: " " }, { name: "bad\nname" }, { sessionId: "../outside" }, { id: "../outside" }, { created: "invalid" }]
			.map(patch => JSON.stringify({ version: 1, bots: [{ ...bot, ...patch }] })),
	]) {
		fs.writeFileSync(registry(home), raw);
		assert.throws(() => listBots(home));
		assert.throws(() => createBot("New", home));
		assert.equal(fs.readFileSync(registry(home), "utf8"), raw);
		assert.equal(fs.existsSync(join(home, "sessions")), false);
		assert.deepEqual(fs.readdirSync(join(home, "klaud")), ["bots.json"]);
	}
});

test("bots refuse symlinks at the home, klaud, sessions, registry, and lock boundaries", (t) => {
	const base = fixture(t);
	const outside = join(base, "outside");
	fs.mkdirSync(outside);
	const target = join(outside, "target");
	fs.writeFileSync(target, "preserve");
	for (const boundary of ["home", "klaud", "sessions", "bots.json", "bots.json.lock", "dangling.json"]) {
		const home = join(base, boundary.replaceAll(".", "-"));
		if (boundary === "home") fs.symlinkSync(outside, home, "dir");
		else {
			fs.mkdirSync(home);
			if (boundary === "klaud" || boundary === "sessions") fs.symlinkSync(outside, join(home, boundary), "dir");
			else {
				fs.mkdirSync(join(home, "klaud"));
				fs.symlinkSync(boundary === "dangling.json" ? join(outside, "missing") : target,
					join(home, "klaud", boundary === "dangling.json" ? "bots.json" : boundary));
			}
		}
		assert.throws(() => createBot("Blocked", home), /symlink|symbolic link/i);
		if (boundary !== "bots.json.lock") assert.throws(() => listBots(home), /symlink|symbolic link/i);
	}
	assert.deepEqual(fs.readdirSync(outside), ["target"]);
	assert.equal(fs.readFileSync(target, "utf8"), "preserve");
});

test("bot id collisions preserve the registry and session set", (t) => {
	const home = fixture(t);
	const bot = createBot("Existing", home);
	const before = fs.readFileSync(registry(home), "utf8");
	const sessions = fs.readdirSync(join(home, "sessions"));
	const uuid = `${bot.id.slice(-8)}-0000-4000-8000-000000000000`;
	const mocked = t.mock.method(crypto, "randomUUID", () => uuid);
	syncBuiltinESMExports();
	try { assert.throws(() => createBot("Collision", home), /collision|unique/i); }
	finally { mocked.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(fs.readFileSync(registry(home), "utf8"), before);
	assert.deepEqual(fs.readdirSync(join(home, "sessions")), sessions);
	assert.deepEqual(fs.readdirSync(join(home, "klaud")), ["bots.json"]);
});

test("failed atomic registry replacement removes only the newly created session", (t) => {
	const home = fixture(t);
	const bot = createBot("Existing", home);
	const before = fs.readFileSync(registry(home), "utf8");
	const mocked = t.mock.method(fs, "renameSync", () => { throw new Error("fixture registry write failure"); });
	syncBuiltinESMExports();
	try { assert.throws(() => createBot("Not saved", home), /fixture registry write failure/); }
	finally { mocked.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(fs.readFileSync(registry(home), "utf8"), before);
	assert.deepEqual(fs.readdirSync(join(home, "sessions")), [`${bot.sessionId}.jsonl`]);
	assert.deepEqual(fs.readdirSync(join(home, "klaud")), ["bots.json"]);
});

test("a session file collision preserves its contents and existing bots", (t) => {
	const home = fixture(t);
	createBot("Existing", home);
	const before = fs.readFileSync(registry(home), "utf8");
	const uuid = "cccccccc-0000-4000-8000-000000000000";
	const file = sessionPath("session-123-cccccccc", home);
	fs.writeFileSync(file, "preserve existing session\n");
	const mockedUuid = t.mock.method(crypto, "randomUUID", () => uuid);
	const mockedTime = t.mock.method(Date, "now", () => 123);
	syncBuiltinESMExports();
	try { assert.throws(() => createBot("Collision", home), { code: "EEXIST" }); }
	finally { mockedUuid.mock.restore(); mockedTime.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(fs.readFileSync(file, "utf8"), "preserve existing session\n");
	assert.equal(fs.readFileSync(registry(home), "utf8"), before);
	assert.deepEqual(fs.readdirSync(join(home, "klaud")), ["bots.json"]);
});

test("a staging file collision keeps that file and rolls back the new session", (t) => {
	const home = fixture(t);
	const bot = createBot("Existing", home);
	const before = fs.readFileSync(registry(home), "utf8");
	const uuid = "aaaaaaaa-0000-4000-8000-000000000000";
	const file = `${registry(home)}.${uuid}.tmp`;
	fs.writeFileSync(file, "preserve staging file");
	const mocked = t.mock.method(crypto, "randomUUID", () => uuid);
	syncBuiltinESMExports();
	try { assert.throws(() => createBot("Collision", home), { code: "EEXIST" }); }
	finally { mocked.mock.restore(); syncBuiltinESMExports(); }
	assert.equal(fs.readFileSync(file, "utf8"), "preserve staging file");
	assert.equal(fs.readFileSync(registry(home), "utf8"), before);
	assert.deepEqual(fs.readdirSync(join(home, "sessions")), [`${bot.sessionId}.jsonl`]);
	assert.equal(fs.existsSync(join(home, "klaud", "bots.json.lock")), false);
});

test("successful replacement restores private registry permissions", (t) => {
	const home = fixture(t);
	const first = createBot("First", home);
	fs.chmodSync(registry(home), 0o644);
	const second = createBot("Second", home);
	assert.deepEqual(listBots(home), [first, second]);
	assert.equal(fs.statSync(registry(home)).mode & 0o777, 0o600);
});

test("independent processes can create bots without losing registry entries", async (t) => {
	const home = fixture(t);
	const moduleUrl = new URL("../src/harness/klaud/bots.ts", import.meta.url).href;
	const script = `import { createBot } from ${JSON.stringify(moduleUrl)};
		for (let i = 0; i < 4; i++) createBot(process.argv[2] + '-' + i, process.argv[1]);`;
	await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script, home, `worker-${index}`], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", data => { stderr += data; });
		child.on("error", reject);
		child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr || `Child exited ${code}`)));
	})));
	const bots = listBots(home);
	assert.equal(bots.length, 24);
	assert.equal(new Set(bots.map(bot => bot.id)).size, 24);
	assert.equal(new Set(bots.map(bot => bot.name)).size, 24);
	assert.equal(new Set(bots.map(bot => bot.sessionId)).size, 24);
	assert.equal(fs.readdirSync(join(home, "sessions")).length, 24);
	assert.deepEqual(fs.readdirSync(join(home, "klaud")), ["bots.json"]);
});
