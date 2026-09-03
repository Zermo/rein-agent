#!/usr/bin/env node
/**
 * rein setup — interactive onboarding (openclaw `onboard` / hermes `setup` style).
 *
 *   rein setup              wizard: detect servers → pick provider + model
 *                           → optional API key → connection test → save config
 *   rein setup --yes        non-interactive: first local server (or existing
 *                           config) + preferred model; used by install.sh
 *   rein setup --status     show config, detected servers, test the connection
 *
 * Config lives at ~/.rein/config.json (env vars / flags still override it).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { PROVIDER_PRESETS, discoverLocalServers, loadConfig, pickDefaultModelId } from "../ai/models.ts";

export interface SetupOptions {
	yes?: boolean;
	status?: boolean;
}

const C = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function configPath(): string {
	return join(homedir(), ".rein", "config.json");
}

function saveConfig(patch: Record<string, unknown>): void {
	mkdirSync(join(homedir(), ".rein"), { recursive: true });
	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(configPath())) existing = JSON.parse(readFileSync(configPath(), "utf8"));
	} catch {
		// unreadable config: start fresh (this wizard is the repair path)
	}
	writeFileSync(configPath(), JSON.stringify({ ...existing, ...patch }, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Prompting on one persistent readline interface, with a line queue. A
 * per-question interface (or `rl.question`) silently kills the process when
 * piped stdin hits EOF, and readline read-aheads drop lines that arrive
 * between prompts — so every "line" is captured into a queue the moment it
 * arrives, and askLine either drains the queue or waits. EOF resolves the
 * current question with its default instead of hanging. Choices are 1-based.
 */
const lineQueue: string[] = [];
let lineWaiter: ((value: string) => void) | undefined;
let inputClosed = false;
let manualClose = false;
let rl: InstanceType<typeof readline.createInterface> | undefined;

function promptRl() {
	if (rl) return rl;
	const r = readline.createInterface({ input: stdin, output: stdout });
	rl = r;
	r.on("line", (line) => {
		const text = line.trim();
		if (lineWaiter) {
			const w = lineWaiter;
			lineWaiter = undefined;
			w(text);
		} else {
			lineQueue.push(text);
		}
	});
	r.on("close", () => {
		if (!manualClose) inputClosed = true; // manual close (secret prompt) keeps input open
		manualClose = false;
		if (lineWaiter) {
			const w = lineWaiter;
			lineWaiter = undefined;
			w("");
		}
	});
	return r;
}

async function askLine(prompt: string, def = ""): Promise<string> {
	promptRl();
	stdout.write(prompt);
	if (lineQueue.length > 0) return lineQueue.shift()! || def;
	if (inputClosed) return def; // EOF: fall back to the default
	return new Promise<string>((resolve) => {
		lineWaiter = (text) => resolve(text || def);
	});
}

async function askChoice(prompt: string, count: number, def = 1): Promise<number> {
	for (;;) {
		const answer = (await askLine(prompt)).trim();
		if (answer === "") return def - 1;
		const n = Number.parseInt(answer, 10);
		if (!Number.isNaN(n) && n >= 1 && n <= count) return n - 1;
		stdout.write(C.yellow("  pick a number from the list\n"));
	}
}

/** Masked secret input. TTY only — piped stdin returns undefined (env/config win there). */
async function askSecret(prompt: string): Promise<string | undefined> {
	if (!stdin.isTTY) return undefined;
	manualClose = true;
	rl?.close();
	rl = undefined; // hand stdin back to raw mode; next prompt recreates the interface
	const wasRaw = stdin.isRaw;
	stdin.setRawMode(true);
	stdin.resume();
	stdout.write(prompt);
	let value = "";
	await new Promise<void>((resolve) => {
		stdin.on("data", (chunk: Buffer) => {
			for (const ch of chunk.toString("utf8")) {
				if (ch === "\r" || ch === "\n") {
					stdin.pause();
					resolve();
				} else if (ch === "\u0003" || ch === "\u0004") {
					stdout.write("\n");
					process.exit(ch === "\u0003" ? 130 : 143);
				} else if (ch === "\u007f") {
					if (value.length > 0) {
						value = value.slice(0, -1);
						stdout.write("\b \b");
					}
				} else if (ch >= " ") {
					value += ch;
					stdout.write("*");
				}
			}
		});
	});
	stdout.write("\n");
	if (wasRaw !== undefined) stdin.setRawMode(wasRaw);
	return value;
}

/** Map model ids → fit marks ("~45 tok/s" / "tight" / "won't fit") for the menu. Best-effort. */
async function fitMarks(ids: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	try {
		const { profileHardware } = await import("../hardware/profile.ts");
		const { matchCatalog } = await import("../hardware/catalog.ts");
		const { bestAssessment, verdictMark } = await import("../hardware/fit.ts");
		const profile = await profileHardware({ fast: true });
		for (const id of ids) {
			const cm = matchCatalog(id);
			if (cm) out.set(id, verdictMark(bestAssessment(profile, cm)));
		}
	} catch {
		// never block the wizard on the fit section
	}
	return out;
}

async function testConnection(baseUrl: string, model: string, apiKey?: string): Promise<{ ok: boolean; detail: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	const started = Date.now();
	try {
		const res = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", {
			method: "POST",
			signal: controller.signal,
			headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "Reply with the single word: ok" }],
				max_tokens: 8,
				temperature: 0,
			}),
		});
		if (!res.ok) {
			const body = (await res.text().catch(() => "")).slice(0, 160);
			return { ok: false, detail: `HTTP ${res.status}${body ? ` — ${body}` : ""}` };
		}
		const json = (await res.json().catch(() => ({}))) as any;
		const reply = json?.choices?.[0]?.message?.content?.trim() ?? "(empty)";
		return { ok: true, detail: `model answered "${reply}" in ${Date.now() - started}ms` };
	} catch (e) {
		return { ok: false, detail: e instanceof Error ? e.message : String(e) };
	} finally {
		clearTimeout(timer);
	}
}

async function printStatus(): Promise<void> {
	const config = loadConfig();
	const servers = await discoverLocalServers();
	console.log(`config: ${configPath()}`);
	if (config.baseUrl || config.model) {
		console.log(`  model:   ${config.model ?? "(unset)"}`);
		console.log(`  baseUrl: ${config.baseUrl ?? "(unset)"}`);
		console.log(`  apiKey:  ${config.apiKey ? `${config.apiKey.slice(0, 7)}…` : "(none)"}`);
	} else {
		console.log("  (no config yet — run `rein setup`)");
	}
	console.log("\nlocal servers:");
	if (servers.length === 0) console.log("  (none running)");
	for (const s of servers) console.log(`  ${s.provider.padEnd(10)} ${s.baseUrl}  ${s.models?.length ?? 0} model(s)`);
	if (config.baseUrl && config.model) {
		const r = await testConnection(config.baseUrl, config.model, config.apiKey);
		console.log(`\nconnection: ${r.ok ? C.green("✓ " + r.detail) : C.red("✗ " + r.detail)}`);
	}
}

interface Choice {
	label: string;
	baseUrl: string;
	model?: string;
	needsKey: boolean;
	keyEnv?: string;
}

export async function runSetup(opts: SetupOptions): Promise<number> {
	if (opts.status) {
		await printStatus();
		return 0;
	}

	console.log(C.bold("rein setup") + " — configure your model\n");
	try {
		const { profileHardware, summarizeHardware } = await import("../hardware/profile.ts");
		console.log(C.dim(`machine: ${summarizeHardware(await profileHardware({ fast: true }))}`) + "\n");
	} catch {
		// best-effort
	}
	const servers = await discoverLocalServers();
	if (servers.length > 0) {
		console.log("local servers detected:");
		servers.forEach((s, i) => {
			const models = (s.models ?? []).slice(0, 4).join(", ") + ((s.models ?? []).length > 4 ? ", …" : "");
			console.log(`  ${C.green(String(i + 1))}. ${s.provider.padEnd(10)} ${C.dim(s.baseUrl)}  ${C.dim(models)}`);
		});
	} else {
		console.log(C.yellow("no local AI servers detected") + C.dim(" (ollama / LM Studio / llama.cpp / vLLM)"));
	}
	console.log("");

	const choices: Choice[] = [];
	for (const s of servers) {
		choices.push({ label: `${s.provider} (local)`, baseUrl: s.baseUrl, model: pickDefaultModelId(s.models ?? []), needsKey: false });
	}
	for (const [name, p] of Object.entries(PROVIDER_PRESETS).slice(4)) {
		choices.push({ label: `${name} (cloud)`, baseUrl: p.baseUrl, needsKey: true, keyEnv: p.keyEnv });
	}
	choices.push({ label: "custom OpenAI-compatible endpoint", baseUrl: "", needsKey: true });

	const customIndex = choices.length - 1;
	let pick: Choice;
	if (opts.yes) {
		const config = loadConfig();
		pick = servers.length > 0
			? choices[0]
			: config.baseUrl && config.model
				? { label: "existing config", baseUrl: config.baseUrl, model: config.model, needsKey: false }
				: choices[customIndex];
		console.log(C.dim(`  (--yes) picked: ${pick.label}`));
	} else {
		console.log(choices.map((c, i) => `  ${i + 1}. ${c.label}`).join("\n") + "\n");
		const defIdx = servers.length > 0 ? 0 : customIndex;
		const idx = await askChoice(`choose provider [${defIdx + 1}]: `, choices.length, defIdx + 1);
		pick = choices[idx];
	}

	let baseUrl = pick.baseUrl ?? "";
	let model = pick.model;
	let apiKey: string | undefined;

	if (baseUrl === "") {
		baseUrl = (await askLine("base URL (OpenAI-compatible, e.g. http://localhost:11434/v1): ")).replace(/\/$/, "");
	}
	if (!baseUrl) {
		console.log(C.red("no base URL — nothing to configure"));
		return 1;
	}

	if (!model) {
		try {
			const res = await fetch(baseUrl + "/models", { signal: AbortSignal.timeout(3000) });
			if (res.ok) {
				const json = (await res.json()) as any;
				const ids: string[] = (json?.data ?? []).map((m: any) => m.id).filter(Boolean);
				if (ids.length > 0) {
					const marks = await fitMarks(ids);
					console.log(`models on ${baseUrl}  ${C.dim("(fit marks from your hardware)")}:`);
					ids.slice(0, 20).forEach((id, i) => console.log(`  ${i + 1}. ${id}${marks.get(id) ? C.dim(marks.get(id)!) : ""}`));
					const preferred = pickDefaultModelId(ids);
					const defIdx = Math.max(0, ids.indexOf(preferred ?? ""));
					if (!opts.yes) {
						const n = await askChoice(`choose model [${defIdx + 1}]: `, ids.length, defIdx + 1);
						model = ids[n];
					} else {
						model = ids[defIdx];
					}
				}
			}
		} catch {
			// unreachable /models — fall through to manual entry
		}
		if (!model && !opts.yes) model = await askLine("model id: ");
	}
	if (!model) {
		console.log(C.red("no model id available — start a server or pick one manually, then re-run `rein setup`"));
		return 1;
	}

	if (pick.needsKey) {
		const envKey = pick.keyEnv ? process.env[pick.keyEnv] : undefined;
		if (envKey) {
			apiKey = envKey;
			console.log(C.dim(`  using ${pick.keyEnv} from environment`));
		} else if (!opts.yes) {
			const secret = await askSecret("API key (Enter to skip): ");
			if (secret) apiKey = secret;
		}
	}

	console.log(`\nmodel:   ${model}`);
	console.log(`baseURL: ${baseUrl}`);
	if (apiKey) console.log(`apiKey:  ${apiKey.slice(0, 7)}…`);
	const test = await testConnection(baseUrl, model, apiKey);
	if (test.ok) {
		console.log(C.green(`✓ connection test passed — ${test.detail}`));
	} else {
		console.log(C.yellow(`⚠ connection test failed — ${test.detail}`));
		if (!opts.yes) {
			const keep = await askLine("save the config anyway? [y/N]: ");
			if (!/^y(es)?$/i.test(keep)) {
				console.log("not saved. Fix the endpoint and run `rein setup` again.");
				return 1;
			}
		}
	}

	saveConfig({ baseUrl, model, ...(apiKey ? { apiKey } : {}) });
	console.log(`\n${C.green("✓ config saved to " + configPath())}`);
	console.log(`\ntry it:`);
	console.log(`  rein -p "hello, what model are you?"`);
	console.log(`  rein            # interactive session in this directory`);
	return 0;
}
