import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopAvailable, preferredSurface, preferSurface, registerRein, REIN_AGENT_ID, shouldOpenDesktop, remoteDesktopSession } from "../src/harness/desktop/surface.ts";
import { parseArgs } from "../src/cli.ts";

test("native routing is only for bare interactive local sessions, never supplied session options or pipes", () => {
	const candidate = { interactive: true, insideNodeTerm: false, available: true, preference: "nodeterm" };
	assert.equal(shouldOpenDesktop(candidate), true);
	for (const override of [{ interactive: false }, { insideNodeTerm: true }, { available: false }, { preference: "terminal" }, { terminal: true }, { visual: false }, { visual: true }, { activity: "existing" }, { hasSessionOptions: true }]) assert.equal(shouldOpenDesktop({ ...candidate, ...override }), false);
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
		preferSurface("terminal", home); assert.equal(preferredSurface(home), "terminal");
		preferSurface("nodeterm", home); assert.equal(preferredSurface(home), "nodeterm");
		assert.equal(readFileSync(join(home, "config.json"), "utf8"), config);
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
