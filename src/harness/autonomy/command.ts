/** Explicit CLI controls. Package installation never starts background inference. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { guessProvider, loadConfig, normalizeBaseUrl, PROVIDER_PRESETS } from "../../ai/models.ts";
import type { ReinConfig } from "../../ai/models.ts";
import { autonomyHome, canonicalWorkspace, decideProposal, readState, runsToday, updateState } from "./state.ts";
import { runCycle, runDaemon } from "./engine.ts";
import { installService, servicePlan, serviceStatus, uninstallService, waitForService } from "./service.ts";
import { renderDashboard, runDashboard, terminalText } from "./tui.ts";
import type { DashboardSnapshot } from "./tui.ts";

type Flags = Record<string, string | boolean>;
export interface AutonomyCommandDependencies {
	/** Test seams only; never loaded from user configuration. */
	serviceOptions?: typeof autonomyServiceOptions;
	install?: typeof installService;
	wait?: typeof waitForService;
	uninstall?: typeof uninstallService;
}

/** A user service does not inherit terminal exports. Do not persist credentials implicitly. */
export function serviceConfigurationIssue(config: ReinConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const provider = config.provider?.toLowerCase() ?? (config.auth?.type === "cli" ? config.auth.provider : undefined);
	const cli = provider === "codex" || provider === "copilot";
	const configuredBase = config.baseUrl ?? (provider ? PROVIDER_PRESETS[provider]?.baseUrl : undefined);
	const envBase = env.REIN_BASE_URL?.trim();
	const envModel = env.REIN_MODEL?.trim();
	const remedy = "Autonomy remains paused. User services do not inherit terminal exports. Save the intended connection with rein setup, or use rein autonomy resume followed by rein autonomy daemon in this terminal.";
	if (envBase) {
		let same = false;
		try { same = !cli && !!configuredBase && normalizeBaseUrl(envBase) === normalizeBaseUrl(configuredBase); } catch {}
		if (!same) return `REIN_BASE_URL changes the connection only in this terminal. ${remedy}`;
	}
	if (envModel && envModel !== (config.model ?? (cli ? "default" : undefined))) return `REIN_MODEL changes the model only in this terminal. ${remedy}`;
	if (cli) return undefined; // Official CLI profiles persist their own login state.
	let activeProvider = provider;
	try { if (envBase || !activeProvider) activeProvider = guessProvider(envBase ?? configuredBase ?? ""); } catch {}
	const preset = activeProvider ? PROVIDER_PRESETS[activeProvider] : undefined;
	let envName = env.REIN_API_KEY ? "REIN_API_KEY" : undefined;
	if (!envName && preset && env[preset.keyEnv] && configuredBase) {
		try { if (new URL(normalizeBaseUrl(configuredBase)).origin === new URL(preset.baseUrl).origin) envName = preset.keyEnv; } catch {}
	}
	if (envName && env[envName] !== config.apiKey) return `${envName} supplies a terminal-only API credential that differs from the saved connection. Autonomy remains paused; no secret was copied. Use rein autonomy resume followed by rein autonomy daemon in this terminal, or rerun interactive rein setup without exported API-key variables and enter the API key when prompted to save it explicitly.`;
	return undefined;
}
function numberOption(flags: Flags, name: string, min: number, max: number): number | undefined {
	if (flags[name] === undefined) return undefined;
	const n = typeof flags[name] === "string" ? Number(flags[name]) : NaN;
	if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
	return n;
}
export function autonomyServiceOptions() {
	return { home: autonomyHome(), cliPath: realpathSync(resolve(process.argv[1])), nodePath: process.execPath };
}
export function autonomySnapshot(): DashboardSnapshot {
	const state = readState(); let service: string;
	try { service = serviceStatus(autonomyServiceOptions()).message; } catch (e) { service = (e as Error).message; }
	return { paused: state.paused, workspaces: state.workspaces, service,
		budget: `${runsToday(state)}/${state.maxRunsPerDay} operations in the last 24h; at most 2 model calls per scan, ${state.maxTurns} turns per run; ${state.timeoutSeconds}s timeout`,
		lastError: state.lastError, proposals: state.proposals,
		recentRuns: state.runs.slice(-5).reverse().map(run => ({ id: run.id, status: run.status, detail: `${run.detail}${run.sessionId ? ` [session ${run.sessionId}]` : ""}` })),
	};
}
const HELP = `Rein autonomy controls

  rein autonomy init                  enroll this workspace; starts paused
    --workspace <path>                 enroll another workspace
    --interval <minutes>               history check interval, default 60
    --daily-budget <n>                 operations per rolling 24h, default 6
    --turn-budget <n>                  model turns per approved run, default 8
    --timeout <seconds>                per-operation timeout, default 180
  rein autonomy unenroll --workspace <path>  remove a directory and disable its tasks
  rein autonomy plan                  print the OS service definition
  rein autonomy enable                enroll this workspace and start user service
  rein autonomy daemon                run the supervisor in this terminal
  rein autonomy status [--json]        state, proposals, reports and budgets
  rein autonomy tui                   interactive controls and proposal alerts
  rein autonomy scan                  inspect changed history once, even while paused
  rein autonomy show <id>              full proposed task and supporting evidence IDs
  rein autonomy approve <id>           enable read-only inspection for this task
    --allow-writes                     authorize normal Rein tools, including shell
  rein autonomy dismiss <id>           dismiss/disable that proposal
  rein autonomy run <id>               run an enabled proposal once
  rein autonomy pause                 pause background work and cancel an active run
  rein autonomy resume                resume background work within its budget
  rein autonomy disable               pause, stop, and remove the OS user service

Routine proposals recur; loop/project proposals run once. Inspection reads only
enrolled workspaces and Rein task history. Scans use the configured model and can
use API credits or subscription allowance. Unchanged history makes no model calls.
There is no process injection, automatic account login, or network discovery.
`;

export async function runAutonomyCommand(args: string[], flags: Flags = {}, dependencies: AutonomyCommandDependencies = {}): Promise<void> {
	const command = args[0] ?? "tui";
	if (command === "help") { console.log(HELP); return; }
	if (command === "init" || command === "enable") {
		const workspace = canonicalWorkspace(typeof flags.workspace === "string" ? flags.workspace : process.cwd());
		const interval = numberOption(flags, "interval", 5, 10080);
		const daily = numberOption(flags, "daily-budget", 1, 100);
		const turns = numberOption(flags, "turn-budget", 1, 30);
		const timeout = numberOption(flags, "timeout", 10, 1800);
		await updateState(state => {
			state.controlRevision = (state.controlRevision ?? 0) + 1;
			if (!state.workspaces.includes(workspace)) state.workspaces.push(workspace);
			if (interval !== undefined) state.intervalMinutes = interval;
			if (daily !== undefined) state.maxRunsPerDay = daily;
			if (turns !== undefined) state.maxTurns = turns;
			if (timeout !== undefined) state.timeoutSeconds = timeout;
		});
		if (command === "enable") {
			// Pause before installation. A failed service start cannot enable work.
			const paused = await updateState(state => { state.paused = true; state.controlRevision = (state.controlRevision ?? 0) + 1; });
			const issue = serviceConfigurationIssue(loadConfig());
			if (issue) throw new Error(issue);
			const options = (dependencies.serviceOptions ?? autonomyServiceOptions)();
			const installed = (dependencies.install ?? installService)(options);
			const result = await (dependencies.wait ?? waitForService)(options, installed);
			if (!result.installed || result.active !== true) throw new Error(`${result.message} Autonomy remains paused. Check rein autonomy status and the user-service manager. For foreground operation, run rein autonomy resume followed by rein autonomy daemon in this terminal.`);
			let resumed = false;
			await updateState(state => {
				// A pause/disable/enrollment change during startup takes precedence.
				if (state.controlRevision !== paused.controlRevision) return;
				state.paused = false; state.controlRevision = (state.controlRevision ?? 0) + 1; resumed = true;
			});
			console.log(terminalText(`${result.message}${resumed ? " Autonomy enabled." : " Startup did not change your newer autonomy controls."}`));
		} else console.log(`Enrolled ${terminalText(workspace)}. Use rein autonomy scan to preview suggestions, or rein autonomy enable to start the user service.`);
		return;
	}
	if (command === "plan") { const plan = servicePlan(autonomyServiceOptions()); console.log(JSON.stringify(plan, null, 2)); return; }
	if (command === "unenroll") {
		let workspace = resolve(typeof flags.workspace === "string" ? flags.workspace : process.cwd());
		try { workspace = canonicalWorkspace(workspace); } catch { /* A moved directory can still be removed by its recorded path. */ }
		await updateState(state => { state.controlRevision = (state.controlRevision ?? 0) + 1; state.workspaces = state.workspaces.filter(path => path !== workspace); for (const p of state.proposals) if (p.workspace === workspace) { p.status = "dismissed"; p.allowWrites = false; p.approvedAt = undefined; p.nextRun = undefined; } });
		console.log(`Removed ${terminalText(workspace)} from autonomy.`); return;
	}
	if (command === "disable") {
		await updateState(state => { state.paused = true; state.controlRevision = (state.controlRevision ?? 0) + 1; });
		console.log(terminalText((dependencies.uninstall ?? uninstallService)((dependencies.serviceOptions ?? autonomyServiceOptions)()).message)); return;
	}
	if (command === "pause" || command === "resume") {
		await updateState(state => { state.paused = command === "pause"; state.controlRevision = (state.controlRevision ?? 0) + 1; });
		console.log(command === "pause" ? "Autonomy paused. Active background work is being cancelled." : "Autonomy resumed. Start the supervisor with enable or daemon if it is not running."); return;
	}
	if (command === "daemon") { await runDaemon(); return; }
	if (command === "status") { console.log(flags.json === true ? JSON.stringify(readState(), null, 2) : renderDashboard(autonomySnapshot())); return; }
	if (command === "scan" || command === "run") {
		if (command === "run" && !args[1]) throw new Error("Use rein autonomy run <proposal id>.");
		const controller = new AbortController(); const stop = () => controller.abort(); process.on("SIGINT", stop); process.on("SIGTERM", stop);
		try { console.log(terminalText(await runCycle(command === "scan" ? "scan" : "routine", args[1], { manual: true, signal: controller.signal }), true)); }
		finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
		return;
	}
	if (command === "show" || command === "approve" || command === "dismiss") {
		const proposal = readState().proposals.find(p => p.id === args[1]);
		if (!proposal) throw new Error("Unknown proposal. Use rein autonomy status to list proposal IDs.");
		console.log(terminalText(JSON.stringify(proposal, null, 2), true));
		if (command !== "show") {
			await decideProposal(proposal.id, command === "approve" ? "enabled" : "dismissed", flags["allow-writes"] === true);
			console.log(command === "dismiss" ? "Proposal dismissed." : flags["allow-writes"] === true ? "Enabled with normal Rein tools, including shell and file writes. Review saved run sessions for results." : "Enabled for read-only workspace inspection.");
		}
		return;
	}
	if (command === "tui") {
		await runDashboard({ snapshot: autonomySnapshot, async action(action, id) {
			if (action === "refresh") return;
			if (action === "pause" || action === "resume") { await updateState(state => { state.paused = action === "pause"; state.controlRevision = (state.controlRevision ?? 0) + 1; }); return action === "pause" ? "Paused; active background work is being cancelled." : "Resumed. The service must be running to execute work."; }
			if (action === "approve" || action === "dismiss") { await decideProposal(id!, action === "approve" ? "enabled" : "dismissed"); return action === "approve" ? "Enabled for read-only workspace inspection." : "Dismissed."; }
			// Schedule immediately and let the supervisor do the work, keeping UI
			// controls responsive while a model/tool is running.
			if (action === "run") { await updateState(state => {
				const proposal = state.proposals.find(p => p.id === id);
				if (!proposal || proposal.status !== "enabled") throw new Error("Enable this proposal first.");
				if (state.paused) throw new Error("Resume autonomy before scheduling a run.");
				proposal.nextRun = Date.now();
			}); return "Run queued. The supervisor must be running."; }
		} }); return;
	}
	throw new Error(`Unknown autonomy command '${command}'. Use rein autonomy help.`);
}
