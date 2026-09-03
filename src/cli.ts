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
 *   rein setup [--yes|--status] interactive onboarding: pick model, test, save config
 *
 * Local AI is the default provider: Ollama → LM Studio → llama.cpp → vLLM.
 * Any OpenAI-compatible server works: --provider, --base-url, --model,
 * or REIN_BASE_URL / REIN_MODEL.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "./ai/models.ts";

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
  rein loop                     autonomous experiment loop (needs TASK.md + METRIC.md)
  rein improve [goal]           self-improvement loop on the rein repo
  rein gates [file]             unlazy gates: --mode lint|status|approve|reverify (default approve)
  rein models                   show detected local servers and provider presets
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

function parseArgs(argv: string[]): ParsedArgs {
	const _ : string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else if (a.startsWith("-") && a.length === 2) {
			const key = a.slice(1);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			_.push(a);
		}
	}
	return { _: _, flags };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	const { _, flags } = parseArgs(argv);

	if (flags.help === true || _[0] === "help") {
		usage();
		return;
	}

	if (flags.version === true || flags.v === true || _[0] === "--version") {
		console.log(`rein ${cliVersion()}`);
		return;
	}

	const common = {
		cwd: process.cwd(),
		modelOverride: typeof flags.model === "string" ? flags.model : undefined,
		baseUrlOverride: typeof flags["base-url"] === "string" ? flags["base-url"] : undefined,
		providerOverride: typeof flags.provider === "string" ? flags.provider : undefined,
		toolsMode: (typeof flags.tools === "string" ? flags.tools : undefined) as "auto" | "native" | "text" | undefined,
		maxTurns: typeof flags["max-turns"] === "string" ? parseInt(flags["max-turns"]) : undefined,
		temperature: typeof flags.temperature === "string" ? parseFloat(flags.temperature) : undefined,
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
			maxIterations: typeof flags["max-iterations"] === "string" ? parseInt(flags["max-iterations"]) : undefined,
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
			maxIterations: typeof flags["max-iterations"] === "string" ? parseInt(flags["max-iterations"]) : 5,
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
