/** Offline foreground limits. Background autonomy has its own explicit limits. */
import { configPath, readConfig, saveConfig } from "../ai/config.ts";
import { createSetupPrompt } from "./setup.ts";
import type { SetupPrompt } from "./setup.ts";
import { resolveRunBudgets } from "./run-budgets.ts";
import type { RunBudgets } from "./run-budgets.ts";

interface BudgetSetupOptions { yes?: boolean; status?: boolean; json?: boolean; maxTurns?: number; maxIterations?: number }

export async function runBudgetSetup(options: BudgetSetupOptions = {}, dependencies: { prompt?: SetupPrompt; log?: (text: string) => void } = {}): Promise<void> {
	const log = dependencies.log ?? console.log;
	const config = readConfig();
	let current: RunBudgets;
	let repair: string | undefined;
	try { current = resolveRunBudgets(config, options); }
	catch (error) {
		if (options.yes || options.status || options.json) throw error;
		// Bad explicit flags are still input errors. Saved limits can be repaired
		// interactively after displaying the issue; nothing is saved on skip/EOF.
		current = resolveRunBudgets({}, options);
		for (const key of ["maxTurns", "maxIterations"] as const) {
			if (options[key] !== undefined || config[key] === undefined) continue;
			try { current = resolveRunBudgets(current, { [key]: config[key] }); } catch { /* Preview the default for this invalid field. */ }
		}
		repair = `Saved task limits need repair: ${(error as Error).message} Invalid fields use defaults in the preview below; save a choice to repair them, or skip to preserve the file.`;
	}
	const path = configPath();
	if (options.status || options.json) {
		if (options.maxTurns !== undefined || options.maxIterations !== undefined || options.yes) throw new Error("Budget status is read-only. Omit --status/--json to save limits.");
		const report = { configPath: path, ...current, source: { maxTurns: config.maxTurns === undefined ? "default" : "saved", maxIterations: config.maxIterations === undefined ? "default" : "saved" } };
		log(options.json ? JSON.stringify(report, null, 2) : `Config: ${path}\nModel turns per prompt: ${current.maxTurns} (${report.source.maxTurns})\nLoop/improve iterations: ${current.maxIterations} (${report.source.maxIterations})\nChange: rein setup budgets`);
		return;
	}
	let selected: RunBudgets = current;
	let prompt: SetupPrompt | undefined;
	try {
		if (!options.yes) {
			prompt = dependencies.prompt ?? createSetupPrompt();
			log(`\nTask duration · Config: ${path}`);
			if (repair) log(repair);
			log("A turn is one model call, including retries. An iteration is a loop/improve round, which can use several turns. Ordinary chat uses the turn limit only; there is no fixed overall time cutoff for foreground chat.");
			log("Longer limits allow more work and more model/account usage. They do not enlarge the context window or disable repeated-tool detection. Automatic context rollover, durable notes, and verification remain available; more turns do not guarantee better answers. Background autonomy keeps its own limits.");
			log(`  1. ${repair || options.maxTurns !== undefined || options.maxIterations !== undefined ? "Use proposed limits" : config.maxTurns !== undefined || config.maxIterations !== undefined ? "Keep current" : "Standard"}: ${current.maxTurns} turns / ${current.maxIterations} iterations\n  2. Extended task: 1000 turns / 100 iterations\n  3. Short task: 100 turns / 10 iterations\n  4. Choose exact limits\n  5. Skip without saving`);
			let choice: string;
			for (;;) {
				choice = await prompt.ask("Task limits [1]: ", "1");
				if (["1", "2", "3", "4", "5"].includes(choice)) break;
				log("Choose 1–5.");
			}
			if (choice === "5") { log("Task limits unchanged. Revisit with rein setup budgets."); return; }
			if (choice === "2") selected = { maxTurns: 1000, maxIterations: 100 };
			if (choice === "3") selected = { maxTurns: 100, maxIterations: 10 };
			if (choice === "4") {
				for (const [key, label] of [["maxTurns", "Model turns per prompt (1–10000)"], ["maxIterations", "Loop/improve iterations (1–1000)"]] as const) {
					for (;;) {
						const text = await prompt.ask(`${label} [${selected[key]}]: `, String(selected[key]));
						try { selected = resolveRunBudgets(selected, { [key]: text.trim() ? Number(text) : NaN }); break; }
						catch (error) { log((error as Error).message); }
					}
				}
			}
		}
		// Reread after questions so unrelated connection edits are never erased.
		const latest = readConfig();
		const budgetFields = (value: Record<string, unknown>) => JSON.stringify({ maxTurns: value.maxTurns, maxIterations: value.maxIterations });
		if (budgetFields(latest) !== budgetFields(config)) throw new Error("Task limits changed during setup. Run rein setup budgets again to review the latest settings.");
		saveConfig({ ...latest, ...selected });
		log(`Saved ${selected.maxTurns} model turns per prompt and ${selected.maxIterations} loop/improve iterations to ${path}. At most ${selected.maxTurns * selected.maxIterations} model turns across a full loop; it can finish earlier.`);
		log("New sessions use these limits. Override for one launch with --max-turns or --max-iterations. At the turn limit, review the saved results and reply continue. Configure background execution separately with rein autonomy init --turn-budget <n>.");
	} finally { if (!dependencies.prompt) prompt?.close(); }
}
