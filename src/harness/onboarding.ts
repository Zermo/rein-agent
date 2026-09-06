/** Guided setup uses fixed work-style choices; no model calls score the operator. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../ai/models.ts";
import { createSetupPrompt, runSetup } from "./setup.ts";
import type { SetupOptions, SetupPrompt } from "./setup.ts";
import { ITEMS, PACKS, createOperatorProfile, readOperatorProfile, renderOperatorFiles, saveOperatorProfile, scoreOperatorProfile, operatorFilesFingerprint } from "./operator-profile.ts";
import type { PackId, OperatorProfileDocument } from "./operator-profile.ts";
import { canonicalWorkspace, readState } from "./autonomy/state.ts";
import { runAutonomyCommand } from "./autonomy/command.ts";
import { guardianPlan, installGuardianModel, readGuardianConfig } from "./autonomy/guardian.ts";
import { profileHardware } from "../hardware/profile.ts";
import { terminalText } from "./autonomy/tui.ts";

interface OnboardingDependencies {
	prompt?: SetupPrompt;
	log?: (text: string) => void;
	setup?: typeof runSetup;
	autonomy?: typeof runAutonomyCommand;
	guardian?: { plan: () => Promise<ReturnType<typeof guardianPlan>>; install: typeof installGuardianModel };
}
const privateHome = () => resolve(process.env.REIN_HOME || join(homedir(), ".rein"));
const packIds = Object.keys(PACKS) as PackId[];
const firstTasks = {
	everyday: "Help me make one small part of today easier. Ask what feels hard to start, then help me choose one manageable next step.",
	coding: "Read this project and suggest one small improvement. Explain how we would test it before editing.",
	ops: "Inspect this project and its run instructions. Report what you can verify and suggest one useful health check.",
	research: "Help me research a topic. First ask what I need to learn, then propose sources and a short plan.",
	creative: "Help me develop a creative brief. Ask about the audience, format, and constraints before proposing directions.",
};

async function menu(prompt: SetupPrompt, log: (text: string) => void, question: string, choices: string[], fallback = 1): Promise<number> {
	log(`\n${question}`);
	choices.forEach((choice, index) => log(`  ${index + 1}. ${choice}`));
	for (;;) {
		const answer = await prompt.ask(`Choose [${fallback}]: `, String(fallback));
		const number = Number(answer);
		if (Number.isInteger(number) && number > 0 && number <= choices.length) return number;
		log(`Enter a number from 1 to ${choices.length}.`);
	}
}

export function profileSummary(profile: OperatorProfileDocument): string {
	const support = Object.entries(profile.preferences ?? {}).filter(([name]) => name !== "requested_surface").map(([name, value]) => `  ${name}: ${value}`).join("\n");
	return `operator_profile\n${Object.entries(profile.operator_profile).map(([axis, value]) => `  ${axis}: ${value}`).join("\n")}\nSupport preferences:\n${support}\nSuggested pack: ${profile.recommended_pack}\nEnabled pack: ${profile.enabled_pack ?? "none"}\nSkills: ${profile.enabled_skills.join(", ") || "no optional skills"}`;
}

/** Returns false on a deliberate skip. No file changes precede the preview. */
export async function runProfileWizard(dependencies: OnboardingDependencies = {}): Promise<boolean> {
	const prompt = dependencies.prompt ?? createSetupPrompt();
	const log = dependencies.log ?? console.log;
	try {
		const current = readOperatorProfile();
		if (current.diagnostic) log(current.diagnostic);
		if (current.migration) log(current.migration);
		log("\nYour operator profile · communication and everyday work");
		log("Choose the explanations, pacing, and practical help that work for you. There is no ability score, diagnosis, or fixed learning type. You can change these preferences later.");
		log("Enter a letter or number. Type back to revisit a question, or skip to keep your current setup.");
		log("Answers stay on this computer. Saved guidance is sent to your selected model as part of future requests.");
		let answers: Record<string, string> = { ...current.profile?.answers, q4: "a" };
		for (;;) {
			for (let index = 0; index < ITEMS.length;) {
				const item = ITEMS[index];
				log(`\n[${index + 1}/${ITEMS.length}] ${item.prompt}`);
				if (item.id === "q3") log("Within a task you already authorized, Rein can show its plan and why, then proceed. New scope still needs approval; if you decline, it offers alternatives. Tool permissions remain separate.");
				item.choices.forEach((choice, n) => log(`  ${n + 1}. ${choice.label} (${choice.id})`));
				const previous = answers[item.id];
				const answer = (await prompt.ask(`Your choice${previous ? ` [${previous}]` : ""}: `, previous)).toLowerCase();
				if (answer === "skip") { log("Operator profile unchanged. Return with rein setup profile."); return false; }
				if (answer === "back") { index = Math.max(0, index - 1); continue; }
				const choice = item.choices.find(c => c.id === answer) ?? item.choices[Number(answer) - 1];
				if (!choice) { log("Choose one of the listed answers, back, or skip."); continue; }
				answers[item.id] = choice.id; index++;
			}
			const scored = scoreOperatorProfile(answers);
			let selected: PackId | null = scored.recommended_pack;
			log(`\nYour choices: ${Object.entries(scored.operator_profile).map(([axis, value]) => `${axis}=${value}`).join(" · ")}`);
			log(`Suggested pack: ${selected}. ${PACKS[selected].description}\nWorkflows: ${PACKS[selected].skills.join(", ")}`);
			log("The suggestion follows the tasks you chose. Your communication and pacing preferences apply with any pack. Change the pack or skip it below.");
			log("Packs enable Rein workflow guidance. They do not install external apps, connect accounts, or change tool permissions.");
			const choice = await menu(prompt, log, "Choose your starting workflows", [
				`Use ${selected}`, "Choose another pack", "Skip the pack", "Change my answers", "Cancel without saving",
			]);
			if (choice === 4) continue;
			if (choice === 5) return false;
			if (choice === 2) selected = packIds[(await menu(prompt, log, "Available packs", packIds.map(id => `${id}: ${PACKS[id].description} (${PACKS[id].skills.join(", ")})`))) - 1];
			if (choice === 3) selected = null;
			const profile = createOperatorProfile(answers, selected);
			const expectedFingerprint = operatorFilesFingerprint();
			const preview = renderOperatorFiles(profile);
			log(`\nPreview\n${profileSummary(profile)}\n\nPrivate files in ${privateHome()}:\n  SOUL.md: agent voice\n  USER.md: your work style\n  AGENTS.md: operating brief\n  profile.yaml: choices, scores, and enabled skills`);
			log("Existing text outside Rein's managed sections stays in place; changed originals are backed up. Project instructions stay in their project.");
			log("Rein works in your current terminal. No chat-channel or voice setup is required.");
			for (;;) {
				const action = await menu(prompt, log, "Save this profile?", ["Save and continue", "Read the full file preview", "Change my answers", "Cancel without saving"]);
				if (action === 2) { for (const [name, content] of Object.entries(preview)) log(`\n--- ${name} ---\n${terminalText(content, true)}`); continue; }
				if (action === 3) break;
				if (action === 4) return false;
				const result = saveOperatorProfile(profile, { expectedFingerprint });
				log(`Saved operator profile. ${selected ? `${selected} workflows are enabled` : "Optional pack skipped"}. New sessions load these preferences.`);
				if (result.backupDirectory) log(`Previous files: ${result.backupDirectory}`);
				return true;
			}
		}
	} finally { if (!dependencies.prompt) prompt.close(); }
}

async function setupLocalHelper(prompt: SetupPrompt, log: (text: string) => void, dependencies: OnboardingDependencies, releasePrompt: () => void): Promise<void> {
	const current = readGuardianConfig();
	log("The supervisor waits and checks history without a model. A headless local worker can optionally filter suggestions for Rein; it uses local compute only when there is new actionable history. It has no chat window, persona, or tools and cannot execute tasks.");
	const choice = await menu(prompt, log, "Add a local suggestion helper?", [
		current.mode === "local" ? "Keep my existing local helper settings" : "Use rules-only checks: no model download or inference",
		"Check this machine and show the optional local model setup",
	]);
	if (choice === 1) return;
	let retry = "rein autonomy guardian install";
	try {
		const plan = await (dependencies.guardian?.plan ?? (async () => guardianPlan(await profileHardware())))();
		log(`${plan.model.name}: about ${Math.ceil(plan.model.downloadBytes / 1_000_000)} MB to download, plus a private headless Ollama runtime download if no usable executable is installed.
Memory estimate: ${Math.ceil(plan.fit.totalBytes / 1024 ** 2)} MiB; ${plan.fit.verdict}. Context: ${plan.limits.contextTokens} tokens; output: at most ${plan.limits.outputTokens} tokens. It unloads after ${plan.limits.keepAliveSeconds} seconds idle. This is a fit estimate, not a speed or quality benchmark.`);
		if (!plan.readyForLocal) { log(plan.fallback); return; }
		log("Rein manages a dedicated background worker with a private model store and loopback endpoint. It talks only to the autonomy engine through bounded triage requests. No desktop app is opened and your main model server stays as configured.");
		plan.installSteps.forEach(step => log(`  ${step}`));
		const action = await menu(prompt, log, "Local helper installation", [
			"Keep current settings; skip installation",
			"Use an installed runtime: start Rein's headless worker and download its helper",
			"Also download a private runtime if missing, then start the worker and helper",
		]);
		if (action === 1) return;
		retry += action === 3 ? " --install-runtime" : "";
		// Release readline while downloading and starting the headless worker.
		releasePrompt();
		const controller = new AbortController();
		const cancel = () => controller.abort();
		process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
		try {
			const result = await (dependencies.guardian?.install ?? installGuardianModel)({ installRuntime: action === 3, startRuntime: true, signal: controller.signal, log });
			controller.signal.throwIfAborted();
			log(result.detail);
		} finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }

	} catch (error) { if (error instanceof Error && (error.name === "AbortError" || /cancelled|canceled/i.test(error.message))) throw error; log(`Local helper setup did not finish: ${(error as Error).message}\nRules-only checks remain available. Retry with ${retry}.`); }
}

async function setupProactivity(getPrompt: () => SetupPrompt, releasePrompt: () => void, log: (text: string) => void, connected: boolean, dependencies: OnboardingDependencies): Promise<boolean> {
	let prompt = getPrompt();
	const state = readState();
	if (state.workspaces.length) {
		log(`Proactivity is already configured for ${state.workspaces.length} folder(s) and is ${state.paused ? "paused" : "enabled"}. Keeping those settings. Planning: ${state.planner === "main" ? "main model (explicitly enabled; account usage applies)" : "rules (no cloud inference)"}. Review here with /autonomy after setup, or rein autonomy tui; inspect the local helper with rein autonomy guardian status or select personalized planning with rein autonomy planner main.`);
		return true;
	}
	log("\n[3/4] Follow up on useful work");
	log("Rein can check recent task history for unfinished work and suggest follow-ups. You review proposals before they run.");
	log(`${state.planner === "main" ? "Previously enabled main-model planning may use your cloud account" : "Background checks use no cloud model"}: every ${state.intervalMinutes} minutes, with unchanged history skipped. An optional local helper can filter suggestions. Executing an approved task uses your selected main model/account, limited to ${state.maxRunsPerDay} operations per day, ${state.maxTurns} turns and ${state.timeoutSeconds} seconds per operation.`);
	const choice = await menu(prompt, log, "When should Rein look for follow-ups?", [
		"When I request a scan. Choose one folder now",
		"In the background. Choose one folder and start the user service",
		"Skip for now",
	]);
	if (choice === 3) { log("No background service started. You can set this up later with rein autonomy init."); return true; }
	log("Choose a folder for your notes, everyday tasks, or project whose Rein conversations may be used for suggestions. Git is not required. Avoid your entire home folder.");
	const candidate = resolve(process.cwd());
	const defaultFolder = [resolve(homedir()), privateHome()].includes(candidate) ? undefined : candidate;
	if (!defaultFolder) log("You are in a settings or home folder. Enter an existing working folder, or skip and run rein autonomy init from that folder later.");
	for (;;) {
		const answer = await prompt.ask(`Folder [${defaultFolder ?? "skip"}] (or skip): `, defaultFolder ?? "skip");
		if (answer.toLowerCase() === "skip") return true;
		let workspace: string;
		try { workspace = canonicalWorkspace(answer.startsWith("~/") ? join(homedir(), answer.slice(2)) : resolve(answer)); }
		catch (error) { log((error as Error).message); continue; }
		log(`Folder: ${terminalText(workspace)}\n${choice === 2 ? "This will start a persistent user service that checks this folder's Rein task history." : "This enrolls the folder for manual scans; background work stays paused."}`);
		const confirmation = await menu(prompt, log, "Use this folder?", ["Yes, use this folder", "Choose a different folder", "Skip"]);
		if (confirmation === 1) {
			await setupLocalHelper(prompt, log, dependencies, releasePrompt);
			prompt = getPrompt();
			let plannerChoice: "main" | "rules" | undefined;
			if (connected || state.planner === "main") {
				log("Personalized planning can use your main model to compare your preferences, past decisions, and recent work, then propose a useful improvement with reasons and tradeoffs. Plans are suggestions; execution still requires approval. This can use up to two main-model calls per scan of changed history or preferences within your daily budget. A cloud account may charge for those calls; a self-hosted model uses your own compute.");
				const selection = await menu(prompt, log, "How should Rein develop follow-up ideas?", state.planner === "main" ? [
					"Keep my previously enabled main-model planning and account usage", "Switch to free checks and optional local triage",
				] : ["Keep free checks and optional local triage", "Enable personalized planning with my main model and these limits"]);
				if (selection === 2) plannerChoice = state.planner === "main" ? "rules" : "main";
			} else log("You can enable personalized planning after connecting your main model: rein autonomy planner main. Free checks work now.");
			try {
				if (plannerChoice) await (dependencies.autonomy ?? runAutonomyCommand)(["planner", plannerChoice]);
				if (choice === 1) await (dependencies.autonomy ?? runAutonomyCommand)(["pause"]);
				await (dependencies.autonomy ?? runAutonomyCommand)([choice === 2 ? "enable" : "init"], { workspace });
				log("Review in chat: /autonomy, then /autonomy show <id>\nStandalone review: rein autonomy tui\nScan on demand: rein autonomy scan\nPause: rein autonomy pause\nRemove the service: rein autonomy disable");
			} catch (error) { log(`Proactivity setup needs attention: ${(error as Error).message}\nYour saved profile and connection settings are kept. Retry with rein autonomy ${choice === 2 ? "enable" : "init"}.`); return false; }
			return true;
		}
		// A skip at confirmation exits; a different folder repeats the prompt.
		if (confirmation === 3) return true;
	}
}

export async function runOnboarding(options: SetupOptions = {}, dependencies: OnboardingDependencies = {}): Promise<number> {
	if (options.yes || options.status) return (dependencies.setup ?? runSetup)(options);
	const log = dependencies.log ?? console.log;
	if (!dependencies.prompt && !process.stdin.isTTY) {
		log("The guided walkthrough needs an interactive terminal. Run rein setup in your terminal, use rein setup --yes for unattended model setup, or pipe choices to rein setup profile for the offline profile wizard.");
		return 1;
	}
	let prompt: SetupPrompt | undefined;
	const getPrompt = () => prompt ??= dependencies.prompt ?? createSetupPrompt();
	const release = () => { if (!dependencies.prompt) prompt?.close(); prompt = undefined; };
	try {
		log("\nREIN · First steps\nWork style → model connection → follow-ups → your first task\nNo model is needed for the work-style questions. You can revise any choice later.");
		log("\n[1/4] Work with Rein your way");
		const current = readOperatorProfile();
		const keep = current.profile && await menu(getPrompt(), log, profileSummary(current.profile), ["Keep my operator profile", "Change it"]) === 1;
		if (!keep) await runProfileWizard({ ...dependencies, prompt: getPrompt(), log });
		log("\n[2/4] Give Rein a model");
		log("A model is the engine that answers and uses tools. Run one on your hardware, or connect a cloud account.");
		log("Connection setup checks this machine's model fit and known LAN/mesh servers. Choose hosting recipes if you need to install LM Studio, Ollama, llama.cpp, or vLLM. For cloud access, choose an API key or an official subscription CLI, including Grok for SuperGrok / X Premium+.");
		const config = loadConfig() ?? {};
		const explicit = options.provider || options.baseUrl || options.model || options.auth || options.cliProvider || options.sshHost || options.api;
		let reuse = !explicit && !!(config.model && (config.baseUrl || config.auth?.type === "cli"));
		let connectLater = false;
		if (reuse) {
			const action = await menu(getPrompt(), log, "A saved model connection is available", ["Keep it and test the connection", "Choose a different connection", "Finish connecting later"]);
			reuse = action === 1; connectLater = action === 3;
		} else if (!explicit) connectLater = await menu(getPrompt(), log, "Ready to connect a model?", ["Connect a local server or cloud account", "Finish connecting later"]) === 2;
		let connected = false;
		while (!connectLater) {
			const code = await (dependencies.setup ?? runSetup)({ ...options, status: !!reuse }, {
				prompt: getPrompt(), log, keepPromptOpen: true,
				// Official subscription login needs exclusive control of the terminal.
				onPromptReleased: () => { prompt = undefined; },
			});
			if (code === 0) { connected = true; break; }
			const action = await menu(getPrompt(), log, "Connection needs attention. Your saved profile is ready", ["Try connection setup again", "Finish connecting later"]);
			if (action === 2) break;
			reuse = false;
		}
		const proactivityReady = await setupProactivity(getPrompt, () => { if (!dependencies.prompt) release(); }, log, connected, dependencies);
		log("\n[4/4] Start with one real task");
		const profile = readOperatorProfile().profile;
		log(`Continue in this terminal. Workspace: ${terminalText(process.cwd())}\nTry: ${firstTasks[profile?.operator_profile.focus ?? "everyday"]}`);
		log("Your messages say OPERATOR; Rein replies and tool activity have separate labels. Use /activity for a tool timeline, /help for controls, /sessions for saved conversations, and /skills for workflows.");
		log("Rein keeps workspace notes and lessons across sessions. It checks current workspace changes when you resume. Save preferences in your private profile; keep passwords and keys out of notes.");
		log("Change your profile: rein setup profile\nCheck the connection: rein setup --status\nUpdate Rein: rein update");
		log(connected ? proactivityReady ? "\nSetup complete. Your connection is ready for a first task." : "\nYour connection is ready. Proactivity setup still needs attention; use the recovery command above." : "\nProfile setup finished. The model connection is still incomplete. Run rein setup --connection-only when your model is ready.");
		return connected && proactivityReady ? 0 : 1;
	} catch (error) { log(`Setup stopped: ${(error as Error).message}\nRun rein setup to continue; saved settings are kept.`); return 1; }
	finally { release(); }
}

export async function profileCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
	if (args[0] === "setup" && args.length === 1 && !Object.keys(flags).length) { await runProfileWizard(); return; }
	if (args[0] === "pack" && args.length === 2 && !Object.keys(flags).length) {
		const selected = args[1];
		if (selected !== "none" && !packIds.includes(selected as PackId)) throw new Error("Use rein profile pack everyday|ship|ops|study|studio|none.");
		const current = readOperatorProfile();
		if (!current.profile) throw new Error(current.diagnostic ?? "Run rein setup profile before choosing a pack.");
		const profile = createOperatorProfile(current.profile.answers, selected === "none" ? null : selected as PackId);
		saveOperatorProfile(profile); console.log(profileSummary(profile)); return;
	}
	if (args.length || Object.keys(flags).some(key => key !== "json")) throw new Error("Usage: rein profile [--json] | setup | pack everyday|ship|ops|study|studio|none");
	const current = readOperatorProfile();
	if (current.diagnostic) throw new Error(current.diagnostic);
	console.log(flags.json === true ? JSON.stringify(current.profile ?? null, null, 2) : current.profile ? profileSummary(current.profile) : "No operator profile yet. Run rein setup profile, or rein setup for the full walkthrough.");
}
