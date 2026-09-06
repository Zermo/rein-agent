import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopAvailable, preferredSurface, preferSurface, registerRein, REIN_AGENT_ID, shouldOpenDesktop, remoteDesktopSession } from "../src/harness/desktop/surface.ts";
import { parseArgs } from "../src/cli.ts";
import { openDesktopActivity } from "../src/harness/desktop/activity.ts";

test("desktop routing requires an explicit request, even when old installers saved a NodeTerm preference", () => {
	const candidate = { interactive: true, insideNodeTerm: false, available: true, preference: "nodeterm" };
	assert.equal(shouldOpenDesktop(candidate), false);
	assert.equal(shouldOpenDesktop({ ...candidate, requested: true }), true);
	for (const override of [{ interactive: false }, { insideNodeTerm: true }, { available: false }, { preference: "terminal" }, { terminal: true }, { visual: false }, { visual: true }, { activity: "existing" }, { hasSessionOptions: true }]) assert.equal(shouldOpenDesktop({ ...candidate, requested: true, ...override }), false);
	assert.equal(desktopAvailable({}, "darwin"), true);
	for (const env of [{ CI: "true" }, { SSH_CONNECTION: "fixture" }, { SSH_TTY: "/dev/fixture" }]) assert.equal(desktopAvailable(env, "darwin"), false);
	assert.equal(desktopAvailable({}, "linux"), false);
	assert.equal(remoteDesktopSession({ NODETERM_HOOK_ENDPOINT: "/home/example/.nodeterm/hook-endpoint-project-id.env" }), true);
	assert.equal(remoteDesktopSession({ NODETERM_HOOK_ENDPOINT: "/home/example/.config/node-terminal/hook-endpoint.env" }), false);
	assert.deepEqual(parseArgs(["--terminal", "--visual=false", "--no-launch"]).flags, { terminal: true, visual: false, "no-launch": true });
});

test("desktop preference does not modify model configuration", () => {
	const home = mkdtempSync(join(tmpdir(), "rein-desktop-state-"));
	try {
		const config = '{"model":"fixture","apiKey":"fixture-only"}\n'; writeFileSync(join(home, "config.json"), config);
		assert.equal(preferredSurface(home), "terminal");
		writeFileSync(join(home, "desktop.json"), '{"surface":"invalid"}'); assert.equal(preferredSurface(home), "terminal");
		preferSurface("terminal", home); assert.equal(preferredSurface(home), "terminal");
		preferSurface("nodeterm", home); assert.equal(preferredSurface(home), "nodeterm");
		assert.equal(readFileSync(join(home, "config.json"), "utf8"), config);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("NodeTerm activity never falls back to a browser or leaves a listener open after failed embedding", async () => {
	const home = mkdtempSync(join(tmpdir(), "rein-canvas-test-")), script = join(home, "canvas.sh");
	let starts = 0, closes = 0;
	const start = async (_id: string) => { starts++; return { url: "http://127.0.0.1:49152/#fixture", close: async () => { closes++; } }; };
	try {
		writeFileSync(script, "fixture only");
		for (const env of [{}, { NODETERM_NODE_ID: "fixture" }, { NODETERM_CANVAS_CONTROL: "fixture" }]) {
			await assert.rejects(openDesktopActivity("fixture", { env, script, start }), /no NodeTerm canvas capability/);
		}
		assert.equal(starts, 0);
		const env = { NODETERM_NODE_ID: "fixture", NODETERM_CANVAS_CONTROL: "fixture" };
		await assert.rejects(openDesktopActivity("fixture", { env, script, start, run: async () => { throw new Error("embed failed"); } }), /embed failed/);
		assert.equal(closes, 1);
		const canvas = await openDesktopActivity("fixture", { env, script, start, log: () => {}, run: async (file, args) => {
			assert.equal(file, "sh"); assert.deepEqual(args, [script, "show-web", "--url", "http://127.0.0.1:49152/#fixture"]);
		} });
		assert.equal(starts, 2); assert.equal(closes, 1); await canvas.close(); assert.equal(closes, 2);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("registration preserves unrelated NodeTerm settings and is idempotent without borrowing another agent identity", async () => {
	const home = mkdtempSync(join(tmpdir(), "rein-native-settings-")), settingsFile = join(home, "settings.json");
	try {
		const original = { theme: "dark", projects: ["keep"], customAgents: [{ id: "custom:other", label: "Other" }], disabledAgents: ["other", REIN_AGENT_ID] };
		writeFileSync(settingsFile, JSON.stringify(original));
		const options = { settingsFile, running: async () => false, node: "/runtime with spaces/node", cli: "/agent's dir/rein.js" };
		await registerRein(options); await registerRein(options);
		const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
		assert.equal(settings.theme, original.theme); assert.deepEqual(settings.projects, original.projects);
		assert.deepEqual(settings.customAgents[0], original.customAgents[0]); assert.equal(settings.customAgents.length, 2);
		assert.equal(settings.defaultAgent, REIN_AGENT_ID); assert.deepEqual(settings.disabledAgents, ["other"]);
		assert.equal(settings.customAgents[1].baseAgent, undefined);
		assert.match(settings.customAgents[1].launchCmd, /--terminal/);
		assert.equal(settings.customAgents[1].promptInjectionMode, "stdin-after-start");
		assert.deepEqual(readdirSync(home), ["settings.json"]);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("registration never rewrites a running app, malformed settings, or a concurrent settings change", async () => {
	const home = mkdtempSync(join(tmpdir(), "rein-native-races-")), settingsFile = join(home, "settings.json");
	try {
		writeFileSync(settingsFile, "original");
		assert.match(await registerRein({ settingsFile, running: async () => true }), /settings were preserved/);
		assert.equal(readFileSync(settingsFile, "utf8"), "original");
		await assert.rejects(registerRein({ settingsFile, running: async () => false }));
		writeFileSync(settingsFile, "{}"); let calls = 0;
		await assert.rejects(registerRein({ settingsFile, running: async () => { if (++calls === 2) writeFileSync(settingsFile, '{"concurrent":true}'); return false; } }), /changed during registration/);
		assert.equal(readFileSync(settingsFile, "utf8"), '{"concurrent":true}');
		assert.deepEqual(readdirSync(home), ["settings.json"]);
	} finally { rmSync(home, { recursive: true, force: true }); }
});
