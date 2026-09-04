#!/usr/bin/env node
/**
 * rein — a minimal, local-first agent harness.
 *
 *   rein                        interactive REPL
 *   rein -p "query"             one-shot
 *   rein loop                   autonomous experiment loop (TASK.md + METRIC.md)
 *   rein improve                self-improvement loop on the harness itself
 *   rein gates <file> [--mode m] unlazy: lint / status / approve / reverify a ledger
 *   rein models                 list what rein can see (local servers, presets)
 *   rein hardware [--json]      profile this machine + what it can run (stolen from Magnitude)
 *   rein doctor [--fix]         auto-detect + self-heal the whole stack (Magnitude doctor, extended)
 *   rein heartbeat              self-sustaining loop: self-heal → HEARTBEAT.md tasks → self-advance
 *   rein setup [--yes|--status] interactive onboarding: pick model, test, save config
 *
 * Local AI is the default provider: Ollama → LM Studio → llama.cpp → vLLM.
 * Any OpenAI-compatible server works: --provider, --base-url, --model,
 * or REIN_BASE_URL / REIN_MODEL.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "./ai/models.ts";

/** "what you can run" section for `rein models` — hardware-aware fit, best 5. */
async function printHardwareSection(): Promise<void> {
	try {
		const { summarizeHardware } = await import("./hardware/profile.ts");
		const { assessCatalog } = await import("./hardware/fit.ts");
		const { profile, all } = await assessCatalog();
		const ranked = all
			.filter((x) => x.a.verdict !== "no")
			.sort((a, b) => (b.a.estTokS ?? 0) - (a.a.estTokS ?? 0) || b.model.params - a.model.params)
			.slice(0, 5);
		if (ranked.length === 0) return;
		console.log("\nyour machine:");
		console.log(`  ${summarizeHardware(profile)}`);
		console.log("top local picks (see `rein hardware` for the full table):");
		for (const { model: m, a } of ranked) {
			const mark = a.verdict === "fits" ? `~${a.estTokS ?? "?"} tok/s` : "tight";
			console.log(`  ${m.name.padEnd(28)} ${String(mark).padEnd(12)} ${m.ollama ?? ""}`);
		}
	} catch {
		// hardware section is best-effort; never break `rein models`
	}
}

function cliVersion(): string {
	try {
		return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
	} catch {
		return "0.0.0";
	}
}

function usage(): void {
	console.log(`rein — minimal local-first agent harness

Usage:
  rein                          start an interactive session in this directory
  rein -p, --print "query"      one-shot: run the query, print the answer, exit
  rein -p "query" --json        one-shot, raw event stream (JSON lines)
  rein -p "query" --save        one-shot, persist the session (resume with --resume <id>)
  rein loop                     autonomous experiment loop (needs TASK.md + METRIC.md)
  rein improve [goal]           self-improvement loop on the rein repo
  rein gates [file]             unlazy gates: --mode lint|status|approve|reverify (default approve)
  rein models                   show detected local servers and provider presets
  rein hardware [--json]        profile this machine + what it can run (tok/s estimates)
  rein doctor [--fix]           auto-detect the whole stack; --fix self-repairs (pull/bundle/pull-model/chmod)
  rein heartbeat [--init]       self-sustaining beat: self-heal → HEARTBEAT.md tasks → self-advance
                                (--improve [goal] adds one self-improvement iteration; idle if no tasks)
  rein setup                    interactive onboarding: provider → model → key
                                → connection test → saves ~/.rein/config.json
  rein setup --yes              non-interactive (first local server / existing config)
  rein setup --status           show config, detected servers, test the connection

Model selection (highest wins):
  --model <id> --base-url <url>    explicit endpoint
  --provider <name> --model <id>   preset (openai, deepseek, groq, together, openrouter, mistral, ...)
  REIN_BASE_URL / REIN_MODEL       environment
  ~/.rein/config.json              {"model": "...", "baseUrl": "...", "apiKey": "..."}
  auto-detect                      Ollama, LM Studio, llama.cpp, vLLM (in that order)

Options:
  --tools <auto|native|text>       tool protocol (auto = capability table + runtime fallback)
  --max-turns <n>                  safety cap per prompt (default 60)
  --temperature <t>                sampling temperature
  --context-window <n>             model context window in tokens
  --reserve-tokens <n>             tokens reserved before rollover
  --no-auto-context                disable automatic context rollover
  --max-iterations <n>             loop/improve: max iterations
  --task-file <f>                  loop: task file (default TASK.md)
  --metric-file <f>                loop: metric file (default METRIC.md)
  --resume <id>                    resume a session (REPL)
  --ask <tools>                    tools that need approval: bash,write
                                    (REPL: /ask; nodeterm: canvas/phone answers)
  --no-tools                       run with no tools (pure chat)
  -h, --help                       this help
  -v, --version                    print version`);

}

interface ParsedArgs {
	_: string[];
	flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["help", "h", "version", "v", "json", "save", "no-tools", "no-auto-context", "fix", "yes", "status", "init"]);

export function parseArgs(argv: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
			const raw = a.slice(a.startsWith("--") ? 2 : 1);
			const eq = raw.indexOf("=");
			const key = eq < 0 ? raw : raw.slice(0, eq);
			if (BOOLEAN_FLAGS.has(key)) {
				if (eq >= 0 && !["true", "false"].includes(raw.slice(eq + 1))) throw new Error(`--${key} expects true or false`);
				flags[key] = eq < 0 || raw.slice(eq + 1) === "true";
			} else if (eq >= 0) {
				flags[key] = raw.slice(eq + 1);
			} else {
				const next = argv[i + 1];
				if (next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) {
					flags[key] = next;
					i++;
				} else {
					flags[key] = true;
				}
			}
		} else positional.push(a);
	}
	return { _: positional, flags };
}

function numberFlag(flags: ParsedArgs["flags"], name: string, min: number, integer = true): number | undefined {
	const raw = flags[name];
	if (raw === undefined) return undefined;
	const value = typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
	if (!Number.isFinite(value) || value < min || (integer && !Number.isSafeInteger(value))) {
		throw new Error(`--${name} must be ${integer ? "an integer" : "a number"} >= ${min}`);
	}
	return value;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	const { _, flags } = parseArgs(argv);

	if (flags.help === true || flags.h === true || _[0] === "help") {
		usage();
		return;
	}

	if (flags.version === true || flags.v === true || _[0] === "--version") {
		console.log(`rein ${cliVersion()}`);
		return;
	}

	if (flags.tools !== undefined && !["auto", "native", "text"].includes(String(flags.tools))) throw new Error("--tools must be auto, native, or text");
	const maxIterations = numberFlag(flags, "max-iterations", 1);
	const common = {
		cwd: process.cwd(),
		modelOverride: typeof flags.model === "string" ? flags.model : undefined,
		baseUrlOverride: typeof flags["base-url"] === "string" ? flags["base-url"] : undefined,
		providerOverride: typeof flags.provider === "string" ? flags.provider : undefined,
		toolsMode: (typeof flags.tools === "string" ? flags.tools : undefined) as "auto" | "native" | "text" | undefined,
		maxTurns: numberFlag(flags, "max-turns", 1),
		temperature: numberFlag(flags, "temperature", 0, false),
		contextWindow: numberFlag(flags, "context-window", 1),
		reserveTokens: numberFlag(flags, "reserve-tokens", 0),
		autoContext: flags["no-auto-context"] === true ? false : undefined,
		askTools: typeof flags.ask === "string" ? flags.ask.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
	};

	if (_[0] === "models" || _[0] === "model") {
		const { discoverLocalServers, PROVIDER_PRESETS } = await import("./ai/models.ts");
		const servers = await discoverLocalServers();
		console.log("local servers detected:");
		if (servers.length === 0) console.log("  (none running — start ollama / LM Studio / llama.cpp / vLLM)");
		for (const s of servers) {
			console.log(`  ${s.provider.padEnd(10)} ${s.baseUrl}`);
			for (const m of s.models ?? []) console.log(`     ${m}`);
		}
		console.log("\nprovider presets:");
		for (const [name, p] of Object.entries(PROVIDER_PRESETS)) {
			console.log(`  ${name.padEnd(12)} ${p.baseUrl}  (key: ${p.keyEnv})`);
		}
		const config = loadConfig();
		if (config.model || config.baseUrl) console.log(`\nconfig: ~/.rein/config.json → ${JSON.stringify({ model: config.model, baseUrl: config.baseUrl })}`);
		await printHardwareSection();
		return;
	}
	if (_[0] === "hardware") {
		const { printHardwareReport } = await import("./hardware/report.ts");
		return printHardwareReport({ json: flags.json === true });
	}

	if (_[0] === "doctor") {
		const { runDoctor } = await import("./harness/doctor.ts");
		const r = await runDoctor({ fix: flags.fix === true });
		process.exitCode = r.healthy === r.total ? 0 : 1;
		return;
	}

	if (_[0] === "heartbeat" || _[0] === "hb") {
		const { runHeartbeat } = await import("./harness/heartbeat.ts");
		// --improve [goal]: flag present turns it on; a string value is the goal
		const code = await runHeartbeat({
			...common,
			file: typeof flags.file === "string" ? flags.file : undefined,
			improve: "improve" in flags && flags.improve !== "false",
			improveGoal: typeof flags.improve === "string" ? flags.improve : undefined,
			init: flags.init === true || _[1] === "init",
		});
		process.exitCode = code;
		return;
	}

	if (_[0] === "setup") {
		const { runSetup } = await import("./harness/setup.ts");
		const code = await runSetup({ yes: flags.yes === true, status: flags.status === true });
		process.exitCode = code;
		return;
	}

	if (_[0] === "loop") {
		const { runExperimentLoop } = await import("./harness/loop.ts");
		await runExperimentLoop({
			...common,
			taskFile: typeof flags["task-file"] === "string" ? flags["task-file"] : undefined,
			metricFile: typeof flags["metric-file"] === "string" ? flags["metric-file"] : undefined,
			maxIterations: maxIterations,
		});
		return;
	}

	if (_[0] === "gates") {
		const { default: gatesTool } = await import("./harness/tools/gates.ts");
		const mode = typeof flags.mode === "string" ? flags.mode : "approve";
		const r = await gatesTool.execute("cli", { mode, file: _.slice(1)[0] });
		console.log(r.content);
		process.exitCode = r.isError ? 1 : 0;
		return;
	}

	if (_[0] === "improve") {
		const goal = _.slice(1).join(" ");
		const { runImproveLoop } = await import("./harness/improve.ts");
		await runImproveLoop({
			...common,
			goal: goal || undefined,
			maxIterations: maxIterations ?? 5,
		});
		return;
	}

	if ("print" in flags || "p" in flags) {
		const { runPrint } = await import("./harness/print.ts");
		const query = typeof flags.print === "string" ? flags.print : typeof flags.p === "string" ? flags.p : _.join(" ");
		const code = await runPrint({
			...common,
			query,
			json: flags.json === true,
			save: flags.save === true,
			tools: flags["no-tools"] === true ? [] : undefined,
		});
		process.exitCode = code;
		return;
	}

	// Default: interactive REPL
	const { createRunner } = await import("./harness/runner.ts");
	const { startRepl } = await import("./harness/repl.ts");
	const runner = await createRunner({ ...common, tools: flags["no-tools"] === true ? [] : undefined, askTools: common.askTools });
	await startRepl({ runner, resumeSessionId: typeof flags.resume === "string" ? flags.resume : undefined });
}

// (main is invoked by bin/rein.js; the export keeps it testable)
