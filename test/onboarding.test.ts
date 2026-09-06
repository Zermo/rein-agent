import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { runOnboarding, runProfileWizard } from "../src/harness/onboarding.ts";
import { readOperatorProfile } from "../src/harness/operator-profile.ts";

function fixture(answers: string[]) {
	const home = mkdtempSync(join(tmpdir(), "rein-onboarding-"));
	const previous = process.env.REIN_HOME; process.env.REIN_HOME = home;
	const logs: string[] = [], asked: string[] = [];
	const prompt = { async ask(question: string, fallback = "") {
		asked.push(question); assert.ok(answers.length, `Unexpected prompt: ${question}\n${logs.join("\n")}`);
		return answers.shift()! || fallback;
	}, async secret() { return undefined; }, close() {} };
	return { home, prompt, logs, asked, log: (text: string) => logs.push(text), close() {
		if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	} };
}

test("profile wizard revisits answers, previews files, and allows skipping the skill pack", async () => {
	const f = fixture(["invalid", "1", "back", "c", "3", "1", "3", "3", "2", "1"]);
	try {
		writeFileSync(join(f.home, "config.json"), '{"model":"keep-model","apiKey":"fixture-only"}');
		assert.equal(await runProfileWizard(f), true);
		const profile = readOperatorProfile().profile!;
		assert.equal(profile.operator_profile.density, "walkthrough");
		assert.equal(profile.operator_profile.focus, "research");
		assert.equal(profile.operator_profile.surface, "voice");
		assert.equal(profile.recommended_pack, "study"); assert.equal(profile.enabled_pack, null);
		assert.deepEqual(profile.enabled_skills, []);
		assert.match(f.logs.join("\n"), /--- SOUL.md ---/);
		assert.match(f.logs.join("\n"), /Chat\/voice services are not connected/);
		assert.doesNotMatch(f.logs.join("\n"), /fixture-only/);
		assert.equal(readFileSync(join(f.home, "config.json"), "utf8"), '{"model":"keep-model","apiKey":"fixture-only"}');
	} finally { f.close(); }
});

test("cancel or skip before saving leaves no operator files", async () => {
	for (const answers of [["skip"], ["a", "a", "c", "a", "5"], ["a", "a", "c", "a", "1", "4"]]) {
		const f = fixture(answers);
		try { assert.equal(await runProfileWizard(f), false); assert.deepEqual(readdirSync(f.home), []); }
		finally { f.close(); }
	}
});

test("full walkthrough saves profile, tests connection, and leaves background work optional", async () => {
	const f = fixture(["a", "a", "c", "a", "1", "1", "1", "3"]);
	let connectionCalls = 0, autonomyCalls = 0;
	try {
		const code = await runOnboarding({}, { ...f, setup: async () => { connectionCalls++; return 0; }, autonomy: async () => { autonomyCalls++; } });
		assert.equal(code, 0); assert.equal(connectionCalls, 1); assert.equal(autonomyCalls, 0);
		assert.equal(readOperatorProfile().profile?.enabled_pack, "ship");
		assert.match(f.logs.join("\n"), /Setup complete/); assert.match(f.logs.join("\n"), /\[4\/4\]/);
	} finally { f.close(); }
});

test("failed model setup keeps the saved profile and does not report a working connection", async () => {
	const f = fixture(["a", "b", "b", "a", "3", "1", "1", "2", "2"]);
	let autonomyCalls = 0;
	try {
		assert.equal(await runOnboarding({}, { ...f, setup: async () => 1, autonomy: async () => { autonomyCalls++; } }), 1);
		assert.ok(readOperatorProfile().profile); assert.equal(autonomyCalls, 0);
		assert.match(f.logs.join("\n"), /model connection is still incomplete/);
		assert.doesNotMatch(f.logs.join("\n"), /Setup complete/);
	} finally { f.close(); }
});

test("background enrollment requires a folder preview and supports changing that folder", async () => {
	const f = fixture(["skip", "1", "2"]);
	const calls: any[] = [];
	let askedFolder = 0, confirmations = 0;
	const baseAsk = f.prompt.ask;
	f.prompt.ask = async (question: string, fallback = "") => {
		if (question.startsWith("Folder")) { askedFolder++; return f.home; }
		if (askedFolder) return String(++confirmations === 1 ? 2 : 1);
		return baseAsk(question, fallback);
	};
	try {
		assert.equal(await runOnboarding({}, { ...f, setup: async () => 0, autonomy: async (args, flags) => { calls.push({ args, flags }); } }), 0);
		assert.equal(askedFolder, 2); assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].args, ["enable"]); assert.equal(calls[0].flags.workspace, realpathSync(f.home));
		assert.match(f.logs.join("\n"), /persistent user service/);
		assert.match(f.logs.join("\n"), /up to 6 operations per day/);
	} finally { f.close(); }
});

test("unattended setup configures only the requested connection and never invents a profile", async () => {
	const f = fixture([]);
	try {
		let forwarded: unknown;
		assert.equal(await runOnboarding({ yes: true, provider: "custom", model: "fixture" }, { ...f, setup: async opts => { forwarded = opts; return 0; } }), 0);
		assert.deepEqual(forwarded, { yes: true, provider: "custom", model: "fixture" });
		assert.deepEqual(readdirSync(f.home), []); assert.equal(f.asked.length, 0);
	} finally { f.close(); }
});

test("profile CLI can complete offline, change packs, and show saved scores", { timeout: 10000 }, async () => {
	const f = fixture([]);
	const cli = (args: string[], input = "") => new Promise<{ code: number | null; text: string }>((resolve, reject) => {
		const child = spawn(process.execPath, [new URL("../bin/rein.js", import.meta.url).pathname, ...args], { env: { ...process.env, REIN_HOME: f.home }, cwd: f.home });
		let text = ""; child.stdout.on("data", chunk => text += chunk); child.stderr.on("data", chunk => text += chunk);
		child.on("error", reject); child.on("close", code => resolve({ code, text })); child.stdin.end(input);
	});
	try {
		let result = await cli(["setup", "profile"], "a\na\nc\na\n1\n1\n");
		assert.equal(result.code, 0, result.text);
		result = await cli(["profile", "pack", "none"]); assert.equal(result.code, 0, result.text);
		result = await cli(["profile", "--json"]); assert.equal(JSON.parse(result.text).enabled_pack, null);
		result = await cli(["profile", "pack", "not-a-pack"]); assert.equal(result.code, 1);
		assert.equal(readOperatorProfile().profile!.enabled_pack, null);
	} finally { f.close(); }
});
