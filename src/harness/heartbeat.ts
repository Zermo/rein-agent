/**
 * rein heartbeat — the self-sustaining loop.
 *
 * Every beat, in this order:
 *   1. SELF-HEAL   rein doctor --fix — detect & repair the environment
 *   2. TASKS       run each HEARTBEAT.md line as an agent prompt
 *   3. SELF-ADVANCE  one `rein improve` iteration, if a goal is set
 *   4. MEMORY      append a JSONL entry to ~/.rein/heartbeat.log
 *
 * HEARTBEAT.md is the openclaw/hermes pattern: a file of periodic tasks.
 * Empty (or comments only) = idle beat: self-heal only, no work.
 * A `# improve: <goal>` line turns on autonomous self-advancement —
 * the harness improving itself is the baseline for self-sustaining agents.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { bold, cyan, dim, green, red, yellow } from "../util/ansi.ts";
import { runDoctor } from "./doctor.ts";
import { createRunner } from "./runner.ts";
import type { RunnerOptions } from "./runner.ts";
import { runImproveLoop } from "./improve.ts";

export interface HeartbeatOptions extends RunnerOptions {
	file?: string;
	improve?: boolean;
	improveGoal?: string;
	init?: boolean;
	quiet?: boolean;
}

export const HEARTBEAT_TEMPLATE = `# HEARTBEAT.md — what the agent does on every \`rein heartbeat\`.
#
# Rules:
#   - one task per line (leading -, * or a number is fine)
#   - lines starting with # are comments — the agent never sees them
#   - empty or comments only → idle beat: self-heal + log, no work
#   - "# improve: <goal>" → after the tasks, run ONE self-improvement iteration with that goal
#
# Examples:
# - confirm the model server still answers (run: rein doctor)
# - scan ~/.rein/heartbeat.log for failed beats and summarize any pattern
# # improve: keep the harness local-first and fast
`;

export interface HeartbeatTask {
	line: string;
	ok: boolean;
	text: string;
	error?: string;
}

export interface HeartbeatResult {
	file: string;
	tasks: HeartbeatTask[];
	doctor: { healthy: number; total: number; fixed: string[] };
	improve: string | null;
	durationMs: number;
}

/** Parse a HEARTBEAT.md into tasks + an optional self-advance goal. */
export function parseHeartbeat(text: string): { tasks: string[]; improveGoal?: string } {
	const tasks: string[] = [];
	let improveGoal: string | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith("#")) {
			const m = line.match(/^#\s*improve\s*:\s*(.+)$/i);
			if (m) improveGoal = m[1].trim();
			continue; // everything else is a comment
		}
		tasks.push(line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, ""));
	}
	return { tasks, improveGoal };
}

function resolveHeartbeatFile(explicit?: string): string {
	if (explicit) return isAbsolute(explicit) ? explicit : resolve(explicit);
	const local = resolve(process.cwd(), "HEARTBEAT.md");
	if (existsSync(local)) return local;
	return join(homedir(), ".rein", "HEARTBEAT.md");
}

function logBeat(result: HeartbeatResult): string {
	const dir = join(homedir(), ".rein");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "heartbeat.log");
	appendFileSync(path, JSON.stringify({
		ts: new Date().toISOString(),
		file: result.file,
		doctor: result.doctor,
		tasks: result.tasks.map((t) => ({ ok: t.ok, line: t.line.slice(0, 120), text: t.text.slice(0, 400), error: t.error })),
		improve: result.improve,
		durationMs: result.durationMs,
	}) + "\n");
	return path;
}

export async function runHeartbeat(opts: HeartbeatOptions = {}): Promise<number> {
	const started = Date.now();
	const say = (s: string) => { if (!opts.quiet) console.log(s); };

	// --init: seed a template and stop (always a concrete file — cwd or --file)
	if (opts.init) {
		const path = opts.file ? (isAbsolute(opts.file) ? opts.file : resolve(opts.file)) : resolve(process.cwd(), "HEARTBEAT.md");
		writeFileSync(path, HEARTBEAT_TEMPLATE);
		say(green(`wrote ${path} — edit it, then run: rein heartbeat`));
		return 0;
	}

	const file = resolveHeartbeatFile(opts.file);
	if (!existsSync(file)) {
		say(red(`no HEARTBEAT.md (looked in cwd and ~/.rein)`));
		say(dim(`create one: rein heartbeat --init --file ${file}`));
		return 1;
	}
	const { tasks, improveGoal } = parseHeartbeat(readFileSync(file, "utf8"));
	say(bold(`heartbeat · ${file}`) + dim(` · ${new Date().toISOString()}`));

	// 1. SELF-HEAL — detect & repair before doing any work
	say(`\n${bold("1/4 self-heal")}`);
	const doctor = await runDoctor({ fix: true, quiet: opts.quiet });
	say(dim(`   doctor: ${doctor.healthy}/${doctor.total} healthy${doctor.fixed.length ? ` (${doctor.fixed.length} repaired)` : ""}`));

	// 2. TASKS — the periodic work
	say(`\n${bold("2/4 tasks")}`);
	const results: HeartbeatTask[] = [];
	if (tasks.length === 0) {
		say(yellow("   idle — HEARTBEAT.md has no tasks (self-heal only)"));
	} else if (!opts.model && !process.env.REIN_BASE_URL && !existsSync(join(homedir(), ".rein", "config.json"))) {
		say(red(`   ${tasks.length} task(s) queued but no model configured — run: rein setup`));
		for (const line of tasks) results.push({ line, ok: false, text: "", error: "no model configured" });
	} else {
		const runner = await createRunner({ ...opts, cwd: process.cwd() });
		for (let i = 0; i < tasks.length; i++) {
			const line = tasks[i];
			say(`   ${i + 1}/${tasks.length} ${dim(line.slice(0, 80))}`);
			try {
				const messages = await runner.run({ role: "user", content: line, timestamp: Date.now() });
				const last = messages.filter((m) => m.role === "assistant").at(-1) as any;
				const text = (last?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
				const ok = !last || last.stopReason !== "error";
				results.push({ line, ok, text: text.slice(0, 500), error: last?.stopReason === "error" ? last.errorMessage : undefined });
				say(ok ? green(`   ✓ ${text.slice(0, 100)}`) : red(`   ✗ ${last?.errorMessage ?? "error"}`));
			} catch (e: any) {
				results.push({ line, ok: false, text: "", error: e.message?.slice(0, 200) });
				say(red(`   ✗ ${e.message?.slice(0, 100)}`));
			}
		}
	}

	// 3. SELF-ADVANCE — autonomous self-improvement (the unique part)
	say(`\n${bold("3/4 self-advance")}`);
	const goal = opts.improveGoal ?? (opts.improve ? "pick the weakest part of the harness and improve it" : improveGoal);
	let improveNote: string | null = null;
	if (goal) {
		say(dim(`   goal: ${goal}`));
		try {
			await runImproveLoop({ ...opts, cwd: process.cwd(), goal, maxIterations: 1, dryRun: false });
			improveNote = goal;
		} catch (e: any) {
			improveNote = `${goal} (failed: ${e.message?.slice(0, 80)})`;
			say(red(`   self-advance failed: ${e.message?.slice(0, 100)}`));
		}
	} else {
		say(yellow("   skipped — set a goal with `# improve: <goal>` in HEARTBEAT.md or --improve"));
	}

	// 4. MEMORY
	const logPath = logBeat({
		file,
		tasks: results,
		doctor: { healthy: doctor.healthy, total: doctor.total, fixed: doctor.fixed },
		improve: improveNote,
		durationMs: Date.now() - started,
	});
	say(`\n${bold("4/4 memory")}` + dim(`   beat logged → ${logPath}`));

	const failed = results.filter((t) => !t.ok).length;
	say(`\n${failed === 0 ? green("beat complete") : red(`beat complete — ${failed} task(s) failed`)} ${dim(`(${((Date.now() - started) / 1000).toFixed(1)}s)`)}`);
	return failed === 0 ? 0 : 1;
}
