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
		if (question.startsWith("Installation [")) return "1";
		asked.push(question); assert.ok(answers.length, `Unexpected prompt: ${question}\n${logs.join("\n")}`);
		return answers.shift()! || fallback;
	}, async secret() { return undefined; }, close() {} };
	return { home, prompt, logs, asked, log: (text: string) => logs.push(text), close() {
		if (previous === undefined) delete process.env.REIN_HOME; else process.env.REIN_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	} };
}

test("profile wizard revisits answers, previews files, and allows skipping the skill pack", async () => {
	const f = fixture(["invalid", "1", "back", "c", "3", "1", "b", "c", "b", "3", "2", "1"]);
	try {
		writeFileSync(join(f.home, "config.json"), '{"model":"keep-model","apiKey":"fixture-only"}');
		assert.equal(await runProfileWizard(f), true);
		const profile = readOperatorProfile().profile!;
		assert.equal(profile.operator_profile.density, "walkthrough");
		assert.equal(profile.operator_profile.focus, "research");
		assert.equal(profile.operator_profile.surface, "cli");
		assert.equal(profile.preferences.pacing, "small-steps");
		assert.equal(profile.recommended_pack, "study"); assert.equal(profile.enabled_pack, null);
		assert.deepEqual(profile.enabled_skills, []);
		assert.match(f.logs.join("\n"), /--- SOUL.md ---/);
		assert.match(f.logs.join("\n"), /current terminal/);
		assert.doesNotMatch(f.logs.join("\n"), /fixture-only/);
		assert.equal(readFileSync(join(f.home, "config.json"), "utf8"), '{"model":"keep-model","apiKey":"fixture-only"}');
	} finally { f.close(); }
});

test("cancel or skip before saving leaves no operator files", async () => {
	for (const answers of [["skip"], ["a", "a", "c", "a", "a", "a", "5"], ["a", "a", "c", "a", "a", "a", "1", "4"]]) {
		const f = fixture(answers);
		try { assert.equal(await runProfileWizard(f), false); assert.deepEqual(readdirSync(f.home), []); }
		finally { f.close(); }
	}
});

test("full walkthrough saves profile, tests connection, and leaves background work optional", async () => {
	const f = fixture(["a", "a", "c", "a", "a", "a", "1", "1", "1", "1", "3"]);
	let connectionCalls = 0, autonomyCalls = 0;
	try {
		const code = await runOnboarding({}, { ...f, setup: async () => { connectionCalls++; return 0; }, autonomy: async () => { autonomyCalls++; } });
		assert.equal(code, 0); assert.equal(connectionCalls, 1); assert.equal(autonomyCalls, 0);
		assert.equal(readOperatorProfile().profile?.enabled_pack, "ship");
		assert.match(f.logs.join("\n"), /Setup complete/); assert.match(f.logs.join("\n"), /\[6\/6\]/);
	} finally { f.close(); }
});

test("failed model setup keeps the saved profile and does not report a working connection", async () => {
	const f = fixture(["a", "b", "b", "a", "a", "a", "3", "1", "1", "1", "2", "3"]);
	let autonomyCalls = 0;
	try {
		assert.equal(await runOnboarding({}, { ...f, setup: async () => 1, autonomy: async () => { autonomyCalls++; } }), 1);
		assert.ok(readOperatorProfile().profile); assert.equal(autonomyCalls, 0);
		assert.match(f.logs.join("\n"), /model connection is still incomplete/);
		assert.doesNotMatch(f.logs.join("\n"), /Setup complete/);
	} finally { f.close(); }
});

test("background enrollment requires a folder preview and supports changing that folder", async () => {
	const f = fixture(["skip", "1", "1", "2"]);
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
		assert.match(f.logs.join("\n"), /limited to 6 operations per day/);
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
		let result = await cli(["setup", "profile"], "a\na\nc\na\na\na\n1\n1\n");
		assert.equal(result.code, 0, result.text);
		result = await cli(["profile", "pack", "none"]); assert.equal(result.code, 0, result.text);
		result = await cli(["profile", "--json"]); assert.equal(JSON.parse(result.text).enabled_pack, null);
		result = await cli(["profile", "pack", "not-a-pack"]); assert.equal(result.code, 1);
		assert.equal(readOperatorProfile().profile!.enabled_pack, null);
	} finally { f.close(); }
});

test("background rules can be enabled without a main model and do not inspect or install a helper", async () => {
	const answers = ["skip", "1", "2", "2"];
	const f = fixture(answers);
	answers.push(f.home, "1", "1");
	const calls: string[] = [];
	try {
		const code = await runOnboarding({}, { ...f,
			setup: async () => { throw new Error("Main model setup was deferred"); },
			autonomy: async args => { calls.push(args[0]); },
			guardian: { plan: async () => { throw new Error("Rules must not probe hardware"); }, install: async () => { throw new Error("Rules must not download"); } },
		});
		assert.equal(code, 1, "the main interactive model is still unconfigured");
		assert.deepEqual(calls, ["enable"]);
		assert.match(f.logs.join("\n"), /Background checks use no cloud model/);
		assert.doesNotMatch(f.logs.join("\n"), /Background setup needs a working connection|Local helper setup did not finish/);
	} finally { f.close(); }
});

test("optional helper setup discloses effects before explicit install or service choices", async () => {
	const { guardianPlan } = await import("../src/harness/autonomy/guardian.ts");
	const plan = guardianPlan({ os: "linux", arch: "x64", cpu: { name: "fixture CPU", cores: 4, physicalCores: 4, features: [] },
		ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 }, gpus: [], unifiedMemory: false });
	assert.equal(plan.readyForLocal, true);
	for (const action of ["1", "2", "3"]) {
		const answers = ["skip", "1", "1", "1"];
		const f = fixture(answers);
		answers.push(f.home, "1", "2", action, "1");
		const installations: any[] = [];
		try {
			const code = await runOnboarding({}, { ...f, setup: async () => 0, autonomy: async () => {}, guardian: {
				plan: async () => plan,
				install: async opts => {
					assert.match(f.logs.join("\n"), /dedicated background worker/);
					assert.match(f.logs.join("\n"), /523 MB/);
					installations.push(opts);
					return { installed: true, detail: "Fixture helper enabled", plan };
				},
			} });
			assert.equal(code, 0, f.logs.join("\n"));
			assert.equal(installations.length, action === "1" ? 0 : 1);
			if (installations.length) {
				assert.equal(installations[0].installRuntime, action === "3");
				assert.equal(installations[0].startRuntime, true);
			}
		} finally { f.close(); }
	}
});

test("personalized planning is enabled only after its account-usage preview is accepted", async () => {
	for (const choice of ["1", "2"]) {
		const answers = ["skip", "1", "1", "2"];
		const f = fixture(answers);
		answers.push(f.home, "1", "1", choice);
		const calls: string[][] = [];
		try {
			assert.equal(await runOnboarding({}, { ...f, setup: async () => 0, autonomy: async args => {
				if (args[0] === "planner") {
					assert.match(f.logs.join("\n"), /cloud account may charge/);
					assert.match(f.logs.join("\n"), /two main-model calls/);
				}
				calls.push(args);
			} }), 0);
			assert.deepEqual(calls, choice === "2" ? [["planner", "main"], ["enable"]] : [["enable"]]);
		} finally { f.close(); }
	}
});

test("canceling a helper installation aborts it and does not enable background work", async () => {
	const { guardianPlan } = await import("../src/harness/autonomy/guardian.ts");
	const plan = guardianPlan({ os: "linux", arch: "x64", cpu: { name: "fixture CPU", cores: 4, physicalCores: 4, features: [] },
		ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 }, gpus: [], unifiedMemory: false });
	const answers = ["skip", "1", "1", "2"];
	const f = fixture(answers);
	answers.push(f.home, "1", "2", "3");
	let autonomyCalls = 0;
	const listenerCount = process.listenerCount("SIGINT");
	try {
		assert.equal(await runOnboarding({}, { ...f, setup: async () => 0, autonomy: async () => { autonomyCalls++; }, guardian: {
			plan: async () => plan, install: async options => {
				assert.ok(options.signal);
				process.emit("SIGINT");
				assert.equal(options.signal.aborted, true);
				options.signal.throwIfAborted();
				throw new Error("unreachable");
			},
		} }), 1);
		assert.equal(autonomyCalls, 0);
		assert.equal(process.listenerCount("SIGINT"), listenerCount);
		assert.match(f.logs.join("\n"), /Setup stopped/);
		assert.doesNotMatch(f.logs.join("\n"), /Setup complete/);
	} finally { f.close(); }
});

test("retained main planning is disclosed when connection testing is deferred", async () => {
	const { updateState } = await import("../src/harness/autonomy/state.ts");
	for (const selection of ["1", "2"]) {
		const answers = ["skip", "1", "2", "2"];
		const f = fixture(answers); answers.push(f.home, "1", "1", selection);
		const calls: string[][] = [];
		try {
			await updateState(state => { state.planner = "main"; });
			assert.equal(await runOnboarding({}, { ...f, setup: async () => { throw new Error("deferred"); }, autonomy: async args => { calls.push(args); } }), 1);
			assert.match(f.logs.join("\n"), /Previously enabled main-model planning may use your cloud account/);
			assert.match(f.logs.join("\n"), /Keep my previously enabled main-model planning and account usage/);
			assert.doesNotMatch(f.logs.join("\n"), /Background checks use no cloud model|Free checks work now/);
			assert.deepEqual(calls, selection === "1" ? [["enable"]] : [["planner", "rules"], ["enable"]]);
		} finally { f.close(); }
	}
});

test("a failed helper runtime installation reports the exact retry without blocking free checks", async () => {
	const { guardianPlan } = await import("../src/harness/autonomy/guardian.ts");
	const plan = guardianPlan({ os: "linux", arch: "x64", cpu: { name: "fixture CPU", cores: 4, physicalCores: 4, features: [] },
		ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 }, gpus: [], unifiedMemory: false });
	const answers = ["skip", "1", "1", "1"];
	const f = fixture(answers); answers.push(f.home, "1", "2", "3", "1");
	try {
		assert.equal(await runOnboarding({}, { ...f, setup: async () => 0, autonomy: async () => {}, guardian: {
			plan: async () => plan, install: async () => { throw new Error("fixture download failed"); },
		} }), 0);
		assert.match(f.logs.join("\n"), /Retry with rein autonomy guardian install --install-runtime/);
		assert.match(f.logs.join("\n"), /Rules-only checks remain available/);
	} finally { f.close(); }
});

test("an explicit unattended edition follows base connection setup without inventing a profile", async () => {
 const f = fixture([]), events: string[] = [];
 try {
  const code = await runOnboarding({ yes: true, edition: "cloud" }, { ...f,
   setup: async () => { events.push("base-setup"); return 1; },
   edition: async options => { assert.deepEqual(options, { edition: "cloud", yes: true }); events.push("selected-edition"); return "cloud"; },
  });
  assert.equal(code, 1, "an incomplete model connection is still reported");
  assert.deepEqual(events, ["base-setup", "selected-edition"]);
  assert.deepEqual(readdirSync(f.home), []); assert.equal(f.asked.length, 0);
 } finally { f.close(); }
});
