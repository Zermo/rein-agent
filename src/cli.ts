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
 *   rein learn [--json]         read-only learn pass: boot chain + surface, writes a dossier
 *   rein export browse|presets  keep personal files before an OS replacement (copies, never deletes)
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

/** Hardware advice describes this gateway only, never an inferred remote GPU. */
async function printHardwareSection(): Promise<void> {
	const { printServingAdvice } = await import("./harness/server-setup.ts");
	await printServingAdvice();
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
  rein model help               pinned GGUF downloads, serving and background model services
  rein model plan <repo> --file <gguf> [--revision <ref>] [--json]
  rein os help                    Dareecho — the OS tier: full Rein takeover with complete
                                  rein-agent control (clean install, skins, Argent toolkit)
  rein os plan [--mode host|image] [--json]    native host and OS installation gates
  rein os prepare --output <dir>             prepare a pinned Omarchy VM overlay kit
  rein os skin render <file|dir> [--frames n]  Rainmeter-rebuilt skin engine, static by default
  rein os skin install|list [--dir <target>]   stage and list terminal skins
  rein os rainmeter [--json]                 Rainmeter rebuild report: pin, mapping, gates
  rein argent status|rebuild [--json]        Argent device toolkit: providers, rebuild report
  rein argent flow validate|run <flow.json>  record & replay interaction flows
  rein argent screenshot --out f.png         capture a terminal pane as a PNG
  rein argent diff <a.png> <b.png>           visual regression pixel diff
  rein skills [name]            list bundled workflows, or read one without running it
  rein profile [--json]         view your operator profile and enabled skill pack
  rein profile pack <name>      enable everyday|ship|ops|study|studio, or none
  rein debug <folder> [--json]  inspect exported JSONL sessions offline (counts only)
  rein web install|status       install or inspect the native Obscura browser
  rein web search <query>        search DuckDuckGo through Obscura (--json optional)
  rein web fetch <url>           render a page to markdown (--max-chars 20000)
  rein update                   curl the latest installer and update the installed build
  rein desktop install          optional NodeTerm installation and registration
  rein desktop [open|status]    open or inspect the selected desktop surface
  rein desktop use <surface>   choose klaud, nodeterm, or terminal
  rein klaud                    open rein-klaʊd with a loopback AG-UI backend
  rein --terminal               stay in this terminal for this session
  rein --visual                 split the terminal into chat and live activity (tmux)
  rein watch <activity-id>       inspect activity inside this terminal
  rein canvas <activity-id>      serve an optional node canvas; --browser opens it
  rein serve [--port n]          serve the loopback rein-klaʊd AG-UI API
  rein serve --mobile --host <private-ip> [--port n] [--trusted-origin <https-origin>]
                                opt-in resumable iOS gateway (default port 4318)
  rein train <recipe.yaml>       run optional Automodel training
  rein meat [ref [ref]]          review a commit or range with the embedded Meat engine
                                --staged or --working-tree selects uncommitted changes
  rein tmux start [command]      start a persistent bash shell; returns its session ID
  rein tmux list                list this workspace's persistent shells
  rein tmux capture|attach|interrupt|stop <id>
  rein tmux send <id> <text>     send literal input and Enter to a persistent shell
  rein hardware [--json]        model fit and serving recipes for this machine
    --context <tokens>          plan the recipe's context memory
    --focus everyday|coding|ops|research|creative   choose task-oriented recommendations
  rein learn [--json]           read-only learn pass on this machine (macOS/Windows/Linux, any arch)
                                writes a new dossier directory under ~/.rein/redteam/
  rein learn ios [--udid U]     learn an attached iOS device via libimobiledevice
    --output <new-directory>    write the dossier to a new directory of your choice
  rein export browse            Finder-style TUI: choose personal files, export before an OS replace
  rein export presets [--to D]  copy standard personal data groups (Documents, Mail, keys, …)
  rein export <paths…> --to D   copy chosen files/folders to a new directory; never deletes sources
  rein doctor [--fix] [--json]  auto-detect the whole stack; --fix self-repairs (pull/bundle/pull-model/chmod)
  rein heartbeat [--init]       self-sustaining beat: self-heal → HEARTBEAT.md tasks → self-advance
                                (--improve [goal] adds one self-improvement iteration; idle if no tasks)
  rein setup                    work style → limits → model → follow-ups → first task
  rein setup budgets            turn/iteration limits, offline; --status or --json shows effective settings
  rein setup profile            communication preferences and optional workflows, offline
  rein setup --connection-only  provider → login/key → model → connection test
                                saves $REIN_HOME/config.json (default ~/.rein)
  rein setup --yes              non-interactive (first local server / existing config)
  rein autonomy                 free background triggers, local helper, and approved tasks
  rein autonomy help            enrollment, budgets, approvals, pause, and removal
  rein setup --status           show config, detected servers, test the connection
  rein login codex|copilot|grok open official subscription device sign-in
  rein setup --provider codex   use a ChatGPT subscription through the official CLI
  rein setup --provider grok    SuperGrok / X Premium+ through the official Grok CLI
  rein setup --provider xai     xAI API key (XAI_API_KEY)
  rein setup --ssh model-host --base-url 127.0.0.1:1234
                                reach a remote loopback API through SSH

Model selection (highest wins):
  --model <id> --base-url <url>    explicit endpoint
  --provider <name> --model <id>   preset (openai, deepseek, groq, together, openrouter, mistral, ...)
  --ssh <host>                    SSH config alias for a remote HTTP API
  REIN_BASE_URL / REIN_MODEL       environment
  ~/.rein/config.json              {"model": "...", "baseUrl": "...", "apiKey": "..."}
  auto-detect                      Ollama, LM Studio, llama.cpp, vLLM (in that order)

Options:
  --silent[=false]               doctor/heartbeat: compatibility flags stay silent by default
                                 false shows them as information; warnings and failures remain visible
  --discover-network[=false]      setup/models: include known LAN and mesh peers
  --discover-hosts <hosts>        setup/models: comma-separated hosts or endpoint URLs
  --discover-ports <ports>        setup/models: additional listening ports
  --advertise=false              mobile gateway: disable Bonjour/Avahi discovery
  --trusted-origin <https-url>   mobile gateway: exact private-mesh proxy origin
  --auth <api-key|cli>            setup: API credentials or official subscription CLI
  --api chat-completions         explicit OpenAI-compatible HTTP protocol
  --activity <id>                record a private activity view under a fresh UUID
  --device-auth=false             login/setup: browser callback instead of device code
  --tools <auto|native|text>       tool protocol (auto = capability table + runtime fallback)
  --max-turns <n>                  model calls per prompt (saved config, default 300; maximum 10000)
  --temperature <t>                sampling temperature
  --context-window <n>             model context window in tokens
  --reserve-tokens <n>             tokens reserved before rollover
  --no-auto-context                disable automatic context rollover
  --max-iterations <n>             loop/improve rounds (saved config, default 25; maximum 1000)
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

const BOOLEAN_FLAGS = new Set(["help", "h", "version", "v", "json", "save", "no-tools", "no-auto-context", "fix", "yes", "status", "init", "device-auth", "no-browser", "allow-writes", "staged", "working-tree", "visual", "view", "silent", "terminal", "no-launch", "if-supported", "connection-only", "discover-network", "browser", "install-runtime", "start-runtime", "mobile", "advertise"]);

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

function stringFlag(flags: ParsedArgs["flags"], name: string): string | undefined {
	const value = flags[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} must have a value`);
	return value.trim();
}

export function resolveServePort(flags: ParsedArgs["flags"], mobile: boolean): number {
	const port = numberFlag(flags, "port", 0) ?? (mobile ? 4318 : 0);
	if (port > 65535) throw new Error("--port must be <= 65535");
	return port;
}

function discoveryFlags(flags: ParsedArgs["flags"]) {
	const hostText = stringFlag(flags, "discover-hosts");
	const portText = stringFlag(flags, "discover-ports");
	const discoverHosts = hostText?.split(",").map(s => s.trim());
	if (discoverHosts?.some(s => !s)) throw new Error("--discover-hosts requires comma-separated hosts or URLs.");
	const discoverPorts = portText?.split(",").map(s => Number(s.trim()));
	if (discoverPorts?.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error("--discover-ports requires comma-separated port numbers from 1 to 65535.");
	return { discoverNetwork: typeof flags["discover-network"] === "boolean" ? flags["discover-network"] : undefined, discoverHosts, discoverPorts };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	// Forward trainer arguments verbatim; Rein's flag parser must not consume them.
	if (argv[0] === "train" && !["--help", "-h"].includes(argv[1])) {
		if (!argv[1]) throw new Error("Usage: rein train <recipe.yaml> [Automodel arguments]");
		const { automodelAvailable, runTrain } = await import("./harness/klaud/train.ts");
		if (!automodelAvailable()) {
			console.error("I need uv on PATH and an Automodel checkout to train.\nInstall uv: https://docs.astral.sh/uv/getting-started/installation/\nClone: git clone https://github.com/NousResearch/Automodel.git ./automodel\nThen set REIN_AUTOMODEL_ROOT to the checkout's absolute path and retry.");
			process.exitCode = 1;
			return;
		}
		const result = await runTrain(argv[1], argv.slice(2));
		if (result.log) process.stdout.write(result.log);
		process.exitCode = result.code;
		return;
	}
	const { _, flags } = parseArgs(argv);

	if (flags.help === true || flags.h === true || _[0] === "help") {
		usage();
		return;
	}

	if (flags.version === true || flags.v === true || _[0] === "--version") {
		console.log(`rein ${cliVersion()}`);
		return;
	}
	if (flags.silent !== undefined && !["doctor", "heartbeat", "hb"].includes(_[0])) throw new Error("--silent controls compatibility flags for doctor and heartbeat.");
	if ((_[0] === "model" || _[0] === "models") && _.length > 1) {
		const { runModelCommand } = await import("./models/command.ts");
		await runModelCommand(_.slice(1), flags); return;
	}
	if (_[0] === "os") {
		const { runOSCommand } = await import("./os/command.ts");
		await runOSCommand(_.slice(1), flags); return;
	}
	if (_[0] === "argent") {
		const { runArgentCommand } = await import("./argent/command.ts");
		await runArgentCommand(_.slice(1), flags); return;
	}
	if (_[0] === "update") {
		if (_.length !== 1 || Object.keys(flags).length) throw new Error("Usage: rein update");
		const { runUpdate } = await import("./harness/update.ts");
		process.exitCode = await runUpdate();
		return;
	}
	if (_[0] === "serve") {
		const allowed = new Set(["port", "mobile", "host", "advertise", "trusted-origin"]);
		if (_.length !== 1 || Object.keys(flags).some(key => !allowed.has(key))) throw new Error("Usage: rein serve [--port n] | rein serve --mobile --host <private-ip> [--port n]");
		const mobile = flags.mobile === true;
		const port = resolveServePort(flags, mobile);
		if (!mobile && (flags.host !== undefined || flags.advertise !== undefined || flags["trusted-origin"] !== undefined || flags.mobile === false)) throw new Error("--host, --advertise, --trusted-origin, and --mobile=false are valid only with --mobile.");
		const handle = mobile
			? await (async () => {
				const host = stringFlag(flags, "host");
				if (!host) throw new Error("rein serve --mobile requires --host with an explicit private interface address.");
				const { startKlaudMobileGateway } = await import("./harness/klaud/mobile.ts");
				return startKlaudMobileGateway({ host, port, advertise: flags.advertise === false ? false : undefined, trustedOrigin: stringFlag(flags, "trusted-origin") });
			})()
			: await (async () => { const { startKlaudServe } = await import("./harness/klaud/serve.ts"); return startKlaudServe({ port }); })();
		console.log(`${mobile ? "rein-klaʊd mobile gateway" : "rein-klaʊd"} is listening at ${handle.url}`);
		console.log(mobile && "tokenFile" in handle && handle.tokenFile
			? `The reusable mobile bearer token is stored at ${handle.tokenFile}.`
			: "The bearer token is in $REIN_HOME/klaud/serve-<port>.token, default ~/.rein.");
		if (mobile && "trustedOrigin" in handle && handle.trustedOrigin) console.log(`The configured private-mesh origin is ${handle.trustedOrigin}.`);
		await new Promise<void>((resolve, reject) => {
			const stop = () => {
				process.removeListener("SIGINT", stop);
				process.removeListener("SIGTERM", stop);
				handle.close().then(resolve, reject);
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		});
		return;
	}
	if (_[0] === "klaud") {
		if (_.length !== 1 || Object.keys(flags).length) throw new Error("Usage: rein klaud");
		const { launchKlaud } = await import("./harness/desktop/cli.ts");
		await launchKlaud(); return;
	}
	if (_[0] === "desktop") {
		const { desktopCommand } = await import("./harness/desktop/cli.ts");
		await desktopCommand(_.slice(1), flags); return;
	}
	if (_[0] === "profile" || _[0] === "setup" && _[1] === "profile") {
		const { profileCommand } = await import("./harness/onboarding.ts");
		await profileCommand(_[0] === "profile" ? _.slice(1) : ["setup", ..._.slice(2)], flags); return;
	}

	if (_[0] === "setup" && _[1] === "budgets") {
		const allowed = new Set(["yes", "status", "json", "max-turns", "max-iterations"]);
		if (_.length !== 2 || Object.keys(flags).some(key => !allowed.has(key))) throw new Error("Usage: rein setup budgets [--status|--json|--yes] [--max-turns <n>] [--max-iterations <n>]");
		const { runBudgetSetup } = await import("./harness/budget-setup.ts");
		await runBudgetSetup({ yes: flags.yes === true, status: flags.status === true, json: flags.json === true,
			maxTurns: numberFlag(flags, "max-turns", 1), maxIterations: numberFlag(flags, "max-iterations", 1) });
		return;
	}

	if (flags.tools !== undefined && !["auto", "native", "text"].includes(String(flags.tools))) throw new Error("--tools must be auto, native, or text");
	const maxIterations = numberFlag(flags, "max-iterations", 1);
	const common = {
		cwd: process.cwd(),
		activityId: stringFlag(flags, "activity"),
		api: stringFlag(flags, "api"),
		modelOverride: stringFlag(flags, "model"),
		baseUrlOverride: stringFlag(flags, "base-url"),
		providerOverride: stringFlag(flags, "provider"),
		sshHostOverride: stringFlag(flags, "ssh"),
		toolsMode: (typeof flags.tools === "string" ? flags.tools : undefined) as "auto" | "native" | "text" | undefined,
		maxTurns: numberFlag(flags, "max-turns", 1),
		temperature: numberFlag(flags, "temperature", 0, false),
		contextWindow: numberFlag(flags, "context-window", 1),
		reserveTokens: numberFlag(flags, "reserve-tokens", 0),
		autoContext: flags["no-auto-context"] === true ? false : undefined,
		askTools: typeof flags.ask === "string" ? flags.ask.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
	};
	if (flags.visual === true) {
		if (_[0] && !("print" in flags || "p" in flags)) throw new Error("Use --visual with an interactive session or --print. The agent's meat tool appears in that session's activity view.");
		if (common.activityId) throw new Error("--visual creates its own activity ID; omit --activity.");
		const { launchVisual } = await import("./harness/activity/terminal.ts");
		process.exitCode = await launchVisual(argv, common.cwd); return;
	}
	if (_[0] === "watch" || _[0] === "canvas") {
		if (!_[1]) throw new Error(`Usage: rein ${_[0]} <activity-id>`);
		if (_[0] === "watch") { const { watchActivity } = await import("./harness/activity/terminal.ts"); await watchActivity(_[1]); return; }
		const { startCanvas, openCanvas } = await import("./harness/activity/server.ts");
		const canvas = await startCanvas(_[1]); console.log(canvas.url);
		if (flags.browser === true && flags["no-browser"] !== true) openCanvas(canvas.url);
		await new Promise<void>(resolve => {
			const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); void canvas.close().finally(resolve); };
			process.on("SIGINT", stop); process.on("SIGTERM", stop);
		}); return;
	}

	if (_[0] === "meat") {
		const { runMeatReview } = await import("./harness/meat/review.ts");
		const controller = new AbortController();
		let cancelledCode = 130;
		const cancel = (code: number) => { if (!controller.signal.aborted) cancelledCode = code; controller.abort(); };
		const signals = [["SIGINT", () => cancel(130)], ["SIGHUP", () => cancel(129)], ["SIGTERM", () => cancel(143)]] as const;
		for (const [signal, handler] of signals) process.on(signal, handler);
		try {
			const result = await runMeatReview({ ...common, refs: _.slice(1), staged: flags.staged === true, workingTree: flags["working-tree"] === true, signal: controller.signal,
				onProgress: text => { if (!flags.json) process.stderr.write(`[meat] ${text}\n`); } });
			console.log(flags.json ? JSON.stringify(result, null, 2) : `${result.summary}\n\nReading diff, not an applicable patch:\n${result.smart_diff}`);
		} catch (error) {
			if (!controller.signal.aborted) throw error;
			console.error("Meat review cancelled."); process.exitCode = cancelledCode;
		} finally { for (const [signal, handler] of signals) process.off(signal, handler); }
		return;
	}
	if (_[0] === "web") {
		const { webCommand } = await import("./harness/obscura/cli.ts");
		await webCommand(_.slice(1), flags); return;
	}
	if (_[0] === "tmux") {
		const { TmuxShells } = await import("./harness/tmux.ts");
		const shells = new TmuxShells(common.cwd, flags.view === true ? "visual" : "shell"); const action = _[1] ?? "list", id = _[2] ?? "";
		switch (action) {
			case "start": console.log(await shells.start(_.slice(2).join(" ") || undefined)); break;
			case "list": console.log(JSON.stringify(await shells.list(), null, 2)); break;
			case "capture": console.log(await shells.capture(id, numberFlag(flags, "lines", 1))); break;
			case "send": await shells.send(id, _.slice(3).join(" ")); console.log("Input sent."); break;
			case "interrupt": await shells.interrupt(id); console.log("Interrupted."); break;
			case "stop": await shells.stop(id); console.log("Stopped."); break;
			case "attach": process.exitCode = await shells.attach(id); break;
			default: throw new Error("Usage: rein tmux start|list|capture|send|interrupt|stop|attach [session ID] [text]");
		}
		return;
	}
	if (_[0] === "skills") {
		const { readSkill, skillRoster } = await import("./harness/skills.ts");
		console.log(_[1] ? readSkill(_[1], _[2]) : skillRoster());
		return;
	}
	if (_[0] === "debug") {
		if (!_[1]) throw new Error("Usage: rein debug <export folder> [--json]");
		const { analyzeDebugFolder, formatDebugReport } = await import("./harness/debug.ts");
		try {
			const report = await analyzeDebugFolder(_[1]);
			console.log(flags.json === true ? JSON.stringify(report, null, 2) : formatDebugReport(report));
		} catch (error) {
			console.error((error as Error).message);
			process.exitCode = 1;
		}
		return;
	}
	if (_[0] === "models" || _[0] === "model") {
		const { discoverServers, PROVIDER_PRESETS } = await import("./ai/models.ts");
		const { printDiscoverySummary } = await import("./harness/server-setup.ts");
		const options = discoveryFlags(flags);
		const report = await discoverServers({ network: options.discoverNetwork === true, hosts: options.discoverHosts, ports: options.discoverPorts });
		if (flags.json === true) { console.log(JSON.stringify(report, null, 2)); return; }
		printDiscoverySummary(report);
		if (!report.network) console.log("Use rein models --discover-network to include known LAN/mesh peers.");
		for (const s of report.servers) {
			console.log(`  ${s.provider.padEnd(10)} ${s.baseUrl} [${s.status}; ${s.source}]${s.sshHost ? ` via SSH ${s.sshHost}` : ""}`);
			for (const m of s.models ?? []) console.log(`     ${m}`);
		}
		console.log("\nprovider presets:");
		for (const [name, p] of Object.entries(PROVIDER_PRESETS)) {
			console.log(`  ${name.padEnd(12)} ${p.baseUrl}  (key: ${p.keyEnv})`);
		}
		console.log("\nsubscription CLIs (official sign-in):\n  codex        rein setup --provider codex\n  copilot      rein setup --provider copilot\n  grok         rein setup --provider grok (SuperGrok / X Premium+)");
		const config = loadConfig() ?? {};
		if (config.model || config.baseUrl) console.log(`\nconfig → ${JSON.stringify({ model: config.model, baseUrl: config.baseUrl, sshHost: config.sshHost })}`);
		await printHardwareSection();
		return;
	}
	if (_[0] === "hardware") {
		const { printHardwareReport } = await import("./hardware/report.ts");
		const { readOperatorProfile } = await import("./harness/operator-profile.ts");
		const focus = stringFlag(flags, "focus") ?? readOperatorProfile().profile?.operator_profile.focus;
		if (focus !== undefined && !["everyday", "coding", "ops", "research", "creative"].includes(focus)) throw new Error("--focus must be everyday, coding, ops, research, or creative.");
		return printHardwareReport({ json: flags.json === true, contextTokens: numberFlag(flags, "context", 1), focus: focus as "everyday" | "coding" | "ops" | "research" | "creative" | undefined });
	}

	if (_[0] === "learn") {
		const { runLearnCommand } = await import("./learn/command.ts");
		process.exitCode = await runLearnCommand(_.slice(1), flags);
		return;
	}

	if (_[0] === "export") {
		const { runExportCommand } = await import("./export/command.ts");
		process.exitCode = await runExportCommand(_.slice(1), flags, { tty: process.stdin.isTTY === true });
		return;
	}

	if (_[0] === "doctor") {
		const { runDoctor } = await import("./harness/doctor.ts");
		const r = await runDoctor({ fix: flags.fix === true, quiet: flags.json === true, silent: flags.silent !== false });
		if (flags.json === true) console.log(JSON.stringify(r, null, 2));
		process.exitCode = r.healthy === r.total ? 0 : 1;
		return;
	}

	if (_[0] === "autonomy") {
		const { runAutonomyCommand } = await import("./harness/autonomy/command.ts");
		await runAutonomyCommand(_.slice(1), flags);
		return;
	}

	if (_[0] === "heartbeat" || _[0] === "hb") {
		const { runHeartbeat } = await import("./harness/heartbeat.ts");
		// --improve [goal]: flag present turns it on; a string value is the goal
		const code = await runHeartbeat({
			...common,
			file: typeof flags.file === "string" ? flags.file : undefined,
			improve: "improve" in flags && flags.improve !== "false",
			maxIterations,
			improveGoal: typeof flags.improve === "string" ? flags.improve : undefined,
			init: flags.init === true || _[1] === "init",
			silent: flags.silent !== false,
		});
		process.exitCode = code;
		return;
	}

	if (_[0] === "login") {
		const provider = (_[1] ?? common.providerOverride)?.toLowerCase();
		if (provider !== "codex" && provider !== "copilot" && provider !== "grok") throw new Error("Use rein login codex, rein login copilot, or rein login grok. API-key providers are configured with rein setup.");
		if (flags.yes === true) throw new Error("Login requires browser interaction. Run rein login without --yes.");
		const { loginCli } = await import("./harness/auth.ts");
		const result = await loginCli(provider, { deviceAuth: flags["device-auth"] !== false, openBrowser: flags["no-browser"] !== true });
		console.log(result.detail);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}

	if (_[0] === "setup") {
		if (_.length !== 1) throw new Error("Usage: rein setup [profile|budgets] [--connection-only|--yes|--status]");
		const auth = stringFlag(flags, "auth");
		if (auth !== undefined && auth !== "api-key" && auth !== "cli") throw new Error("--auth must be api-key or cli");
		const cliProvider = stringFlag(flags, "cli-provider");
		if (cliProvider !== undefined && cliProvider !== "codex" && cliProvider !== "copilot" && cliProvider !== "grok") throw new Error("--cli-provider must be codex, copilot, or grok");
		const { runSetup } = await import("./harness/setup.ts");
		const { runOnboarding } = await import("./harness/onboarding.ts");
		const setup = flags["connection-only"] === true || flags.yes === true || flags.status === true ? runSetup : runOnboarding;
		const code = await setup({ ...discoveryFlags(flags), yes: flags.yes === true, status: flags.status === true,
			api: common.api, maxTurns: common.maxTurns, maxIterations,
			provider: common.providerOverride, baseUrl: common.baseUrlOverride, model: common.modelOverride,
			sshHost: common.sshHostOverride, auth, cliProvider, deviceAuth: flags["device-auth"] !== false, noBrowser: flags["no-browser"] === true });
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
			maxIterations: maxIterations,
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
	const saved = loadConfig() ?? {};
	if (process.stdin.isTTY && process.stdout.isTTY && !flags.resume &&
		!common.modelOverride && !common.baseUrlOverride && !common.providerOverride &&
		!process.env.REIN_BASE_URL && !process.env.REIN_MODEL && !saved.model) {
		const { runOnboarding } = await import("./harness/onboarding.ts");
		const code = await runOnboarding({ noBrowser: flags["no-browser"] === true });
		if (code !== 0) { process.exitCode = code; return; }
	}
	// The current terminal is the interactive surface, including inside NodeTerm.
	// Activity is local structured data; recording it opens no listener or app.
	if (!common.activityId) {
		const { newActivityId } = await import("./harness/activity/store.ts");
		common.activityId = newActivityId();
	}
	const { createRunner } = await import("./harness/runner.ts");
	const { startRepl } = await import("./harness/repl.ts");
	const runner = await createRunner({ ...common, tools: flags["no-tools"] === true ? [] : undefined, askTools: common.askTools });
	await startRepl({ runner, activityId: runner.activityId, resumeSessionId: typeof flags.resume === "string" ? flags.resume : undefined });
}

// (main is invoked by bin/rein.js; the export keeps it testable)
