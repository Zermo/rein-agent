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
import { terminalText } from "./autonomy/tui.ts";

interface OnboardingDependencies {
	prompt?: SetupPrompt;
	log?: (text: string) => void;
	setup?: typeof runSetup;
	autonomy?: typeof runAutonomyCommand;
}
const privateHome = () => resolve(process.env.REIN_HOME || join(homedir(), ".rein"));
const packIds = Object.keys(PACKS) as PackId[];
const firstTasks = {
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
	return `operator_profile\n${Object.entries(profile.operator_profile).map(([axis, value]) => `  ${axis}: ${value}`).join("\n")}\nSuggested pack: ${profile.recommended_pack}\nEnabled pack: ${profile.enabled_pack ?? "none"}\nSkills: ${profile.enabled_skills.join(", ") || "no optional skills"}`;
}

/** Returns false on a deliberate skip. No file changes precede the preview. */
export async function runProfileWizard(dependencies: OnboardingDependencies = {}): Promise<boolean> {
	const prompt = dependencies.prompt ?? createSetupPrompt();
	const log = dependencies.log ?? console.log;
	try {
		const current = readOperatorProfile();
		if (current.diagnostic) log(current.diagnostic);
		log("\nYour operator profile · four work-style questions");
		log("Choose how you want Rein to work with you. These are preferences, not a test of ability or attention.");
		log("Enter a letter or number. Type back to revisit a question, or skip to keep your current setup.");
		log("Answers stay on this computer. Saved guidance is sent to your selected model as part of future requests.");
		let answers: Record<string, string> = { ...current.profile?.answers };
		for (;;) {
			for (let index = 0; index < ITEMS.length;) {
				const item = ITEMS[index];
				log(`\n[${index + 1}/${ITEMS.length}] ${item.prompt}`);
				if (item.id === "q3") log("This describes initiative within an authorized task. Tool approvals and service controls still apply.");
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
			log(`Suggested pack: ${selected}. ${PACKS[selected].skills.join(", ")}`);
			log("A mixed profile uses ops as the fallback suggestion. You can choose another pack or skip it.");
			log("Packs enable Rein workflow guidance. They do not install external apps, connect accounts, or change tool permissions.");
			const choice = await menu(prompt, log, "Choose your starting workflows", [
				`Use ${selected}`, "Choose another pack", "Skip the pack", "Change my answers", "Cancel without saving",
			]);
			if (choice === 4) continue;
			if (choice === 5) return false;
			if (choice === 2) selected = packIds[(await menu(prompt, log, "Available packs", packIds.map(id => `${id}: ${PACKS[id].skills.join(", ")}`))) - 1];
			if (choice === 3) selected = null;
			const profile = createOperatorProfile(answers, selected);
			const expectedFingerprint = operatorFilesFingerprint();
			const preview = renderOperatorFiles(profile);
			log(`\nPreview\n${profileSummary(profile)}\n\nPrivate files in ${privateHome()}:\n  SOUL.md: agent voice\n  USER.md: your work style\n  AGENTS.md: operating brief\n  profile.yaml: choices, scores, and enabled skills`);
			log("Existing text outside Rein's managed sections stays in place; changed originals are backed up. Project instructions stay in their project.");
			if (profile.operator_profile.surface !== "cli") log(`Your ${profile.operator_profile.surface} preference is saved. Chat/voice services are not connected by this wizard; use Rein in NodeTerm or your terminal now.`);
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

async function setupProactivity(prompt: SetupPrompt, log: (text: string) => void, connected: boolean, dependencies: OnboardingDependencies): Promise<boolean> {
	const state = readState();
	if (state.workspaces.length) {
		log(`Proactivity is already configured for ${state.workspaces.length} folder(s) and is ${state.paused ? "paused" : "enabled"}. Keeping those settings. Review with rein autonomy tui.`);
		return true;
	}
	log("\n[3/4] Follow up on useful work");
	log("Rein can compare recent task history and propose a routine, a loop, or a project. You review proposals before they run.");
	log(`Background checks use your model and may consume credits: every ${state.intervalMinutes} minutes, up to ${state.maxRunsPerDay} operations per day, up to 2 model calls per scan. Approved tasks allow at most ${state.maxTurns} turns and ${state.timeoutSeconds} seconds per operation.`);
	const choice = await menu(prompt, log, "When should Rein look for follow-ups?", [
		"When I request a scan. Choose one folder now",
		connected ? "In the background. Choose one folder and start the user service" : "Background setup needs a working connection. Set it up later",
		"Skip for now",
	]);
	if (choice === 3 || choice === 2 && !connected) { log("No background service started. You can set this up later with rein autonomy init."); return true; }
	log("Choose a project folder whose Rein conversations may be used for suggestions. Avoid your entire home folder.");
	const candidate = resolve(process.cwd());
	const defaultFolder = [resolve(homedir()), privateHome()].includes(candidate) ? undefined : candidate;
	if (!defaultFolder) log("You are in a settings or home folder. Enter an existing project folder, or skip and run rein autonomy init from your project later.");
	for (;;) {
		const answer = await prompt.ask(`Folder [${defaultFolder ?? "skip"}] (or skip): `, defaultFolder ?? "skip");
		if (answer.toLowerCase() === "skip") return true;
		let workspace: string;
		try { workspace = canonicalWorkspace(answer.startsWith("~/") ? join(homedir(), answer.slice(2)) : resolve(answer)); }
		catch (error) { log((error as Error).message); continue; }
		log(`Folder: ${terminalText(workspace)}\n${choice === 2 ? "This will start a persistent user service that checks this folder's Rein task history." : "This enrolls the folder for manual scans; background work stays paused."}`);
		const confirmation = await menu(prompt, log, "Use this folder?", ["Yes, use this folder", "Choose a different folder", "Skip"]);
		if (confirmation === 1) {
			try {
				if (choice === 1) await (dependencies.autonomy ?? runAutonomyCommand)(["pause"]);
				await (dependencies.autonomy ?? runAutonomyCommand)([choice === 2 ? "enable" : "init"], { workspace });
				log("Review suggestions: rein autonomy tui\nScan on demand: rein autonomy scan\nPause: rein autonomy pause\nRemove the service: rein autonomy disable");
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
		log("No local server yet? Install LM Studio at https://lmstudio.ai/download or Ollama at https://ollama.com/download, load a model, then start its API server.");
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
		const proactivityReady = await setupProactivity(getPrompt(), log, connected, dependencies);
		log("\n[4/4] Start with one real task");
		const profile = readOperatorProfile().profile;
		log(`Open your project folder in NodeTerm and add a Rein node, or run rein --terminal in that folder.\nTry: ${firstTasks[profile?.operator_profile.focus ?? "coding"]}`);
		log("Your messages say OPERATOR; Rein replies and tool activity have separate labels. Use /help for controls, /sessions for saved conversations, and /skills for workflows.");
		log("Rein keeps project notes and lessons across sessions. It checks current workspace changes when you resume. Save preferences in your private profile; keep passwords and keys out of notes.");
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
		if (selected !== "none" && !packIds.includes(selected as PackId)) throw new Error("Use rein profile pack ship|ops|study|studio|none.");
		const current = readOperatorProfile();
		if (!current.profile) throw new Error(current.diagnostic ?? "Run rein setup profile before choosing a pack.");
		const profile = createOperatorProfile(current.profile.answers, selected === "none" ? null : selected as PackId);
		saveOperatorProfile(profile); console.log(profileSummary(profile)); return;
	}
	if (args.length || Object.keys(flags).some(key => key !== "json")) throw new Error("Usage: rein profile [--json] | setup | pack ship|ops|study|studio|none");
	const current = readOperatorProfile();
	if (current.diagnostic) throw new Error(current.diagnostic);
	console.log(flags.json === true ? JSON.stringify(current.profile ?? null, null, 2) : current.profile ? profileSummary(current.profile) : "No operator profile yet. Run rein setup profile, or rein setup for the full walkthrough.");
}
