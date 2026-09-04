/**
 * rein loop — an autonomous experiment loop, after karpathy/autoresearch:
 *
 *   fixed budget per iteration
 *   one metric, parsed from the metric command's output
 *   keep (better) / discard (not better) with git
 *   never stop — iterate until --max or the user hits Ctrl-C
 *
 * Setup in the project:
 *   TASK.md    — what to improve, written so an agent can act on it
 *   METRIC.md  — the exact command(s) that produce the metric, and how to parse it
 *
 * The metric line must print exactly: METRIC=<number>
 * (higher is better; for lower-is-better, print METRIC=<-number>)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { dim, gray, green, red, yellow, bold } from "../util/ansi.ts";
import { createRunner } from "./runner.ts";
import type { RunnerOptions } from "./runner.ts";

export interface LoopOptions extends RunnerOptions {
	taskFile?: string;
	metricFile?: string;
	maxIterations?: number;
}

function sh(cmd: string, cwd: string): string {
	return execFileSync("bash", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
}

export function gitAvailable(cwd: string): boolean {
	try {
		sh("git rev-parse --is-inside-work-tree", cwd);
		return true;
	} catch {
		return false;
	}
}

export function readMetric(output: string): number | undefined {
	const values = [...output.matchAll(/^METRIC=([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*$/gm)];
	if (values.length !== 1) return undefined;
	const metric = Number(values[0][1]);
	return Number.isFinite(metric) ? metric : undefined;
}

/** METRIC.md contents, not a filesystem path. */
export function readMetricCommand(text: string): string {
	const fenced = text.match(/^```(?:bash|sh|shell)?[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/m);
	if (fenced) return fenced[1].trim();
	if (text.includes("```")) throw new Error("METRIC.md needs a complete bash, sh, shell, or unlabelled fenced command");
	return text.trim().split("\n").filter(line => line.trim() && !line.trimStart().startsWith("#"))[0]?.trim() ?? "";
}

export function requireCleanGit(cwd: string): void {
	let root: string;
	try {
		root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd, stdio: "ignore" });
	} catch { throw new Error("Autonomous keep/discard requires a Git repository with an initial commit"); }
	if (realpathSync(root) !== realpathSync(resolve(cwd))) throw new Error("Run autonomous keep/discard from the Git repository root");
	if (execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" }).trim()) {
		throw new Error("Working tree is dirty; commit or stash existing work before autonomous keep/discard");
	}
}

/** Only use after clean-tree preflight and against the iteration's unchanged HEAD. */
export function discardIteration(cwd: string, expectedHead?: string): void {
	if (expectedHead && sh("git rev-parse HEAD", cwd) !== expectedHead) throw new Error("Git HEAD changed; refusing to discard a different iteration");
	execFileSync("git", ["reset", "--hard", "HEAD"], { cwd, stdio: "ignore" });
	execFileSync("git", ["clean", "-fd"], { cwd, stdio: "ignore" });
}

export function recordLesson(cwd: string, text: string, commitMessage: string): void {
	appendFileSync(join(cwd, "LESSONS.md"), `\n${text}\n`);
	execFileSync("git", ["add", "--", "LESSONS.md"], { cwd, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", commitMessage], { cwd, stdio: "ignore" });
}

export async function runExperimentLoop(opts: LoopOptions): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const taskFile = opts.taskFile ?? "TASK.md";
	const metricFile = opts.metricFile ?? "METRIC.md";
	const taskPath = join(cwd, taskFile);
	const metricPath = join(cwd, metricFile);

	if (!existsSync(taskPath)) {
		throw new Error(`No ${taskFile} in ${cwd} — write what to improve, then re-run.`);
	}
	if (!existsSync(metricPath)) {
		throw new Error(`No ${metricFile} in ${cwd} — put the metric command in a fenced code block (three backticks) and what METRIC= means, then re-run.`);
	}

	const task = readFileSync(taskPath, "utf8");
	const metricDoc = readFileSync(metricPath, "utf8");
	const metricCmd = readMetricCommand(metricDoc);
	if (!metricCmd) throw new Error("METRIC.md has no metric command");
	requireCleanGit(cwd);
	const useGit = true;
	const maxIters = opts.maxIterations ?? 10;

	// Baseline metric
	const runMetric = (): number | undefined => {
		try {
			const out = execFileSync("bash", ["-c", metricCmd], { cwd, encoding: "utf8", timeout: 300_000 });
			return readMetric(out);
		} catch (err: any) {
			console.log(dim(`metric run failed: ${err.stderr ?? err.message}`.slice(0, 300)));
			return undefined;
		}
	};

	const runner = await createRunner({ ...opts, cwd, maxTurns: 40 });
	let best = runMetric();
	console.log(
		gray(
			`rein loop · ${cwd}\nmodel: ${runner.model.provider}/${runner.model.id}\nbaseline METRIC=${best ?? "n/a"} · max ${maxIters} iterations · ${useGit ? "git keep/discard" : "no git"}\n`,
		),
	);

	const prompt = `
You are in an autonomous experiment loop. Read the task below, make ONE concrete improvement, then stop so the metric can be measured.

TASK:
${task.slice(0, 4_000)}

METRIC (how success is measured — you cannot see the metric yourself; the loop runs it):
${metricDoc.slice(0, 2_000)}

Rules:
- One improvement per iteration. Smallest change with a plausible metric impact.
- Do not change the metric command or its parsing.
- Do not commit, reset, stage, or switch Git branches; the harness owns keep/discard.
- Do not read this file again — act on it.
`.trim();

	let kept = 0;
	let discarded = 0;
	let stale = 0;
	for (let i = 0; i < maxIters; i++) {
		const head = sh("git rev-parse HEAD", cwd);
		const tag = randomUUID().slice(0, 8);
		console.log(`\n${bold(`iteration ${i + 1}/${maxIters}`)} ${dim(tag)}`);
		try {
			await runner.run({ role: "user", content: i === 0 ? prompt : "Next iteration: one more improvement, different angle. If nothing better is plausible, say RESULT: no-change and stop.", timestamp: Date.now() });
		} catch (err) {
			console.log(red(`run failed: ${(err as Error).message}`));
		}

		if (sh("git rev-parse HEAD", cwd) !== head) throw new Error("Agent changed Git HEAD; stopping without discarding or committing additional work");
		const dirty = useGit ? sh("git status --porcelain", cwd) : "";
		if (!dirty) {
			console.log(gray(`${dim(tag)}: no changes made`));
			if (++stale >= 3) {
				console.log(gray("three iterations without changes — stopping"));
				break;
			}
			continue;
		}

		stale = 0;
		const metric = runMetric();
		if (sh("git rev-parse HEAD", cwd) !== head) throw new Error("Metric command changed Git HEAD; stopping without further changes");
		if (metric === undefined) {
			console.log(yellow(`${dim(tag)}: metric could not be parsed — discarding`));
			if (useGit) discardIteration(cwd, head);
			discarded++;
			continue;
		}

		if (best === undefined || metric > best) {
			best = metric;
			if (useGit) sh(`git add -A && git commit -m "loop: ${tag} METRIC=${metric}"`, cwd);
			kept++;
			console.log(green(`${dim(tag)}: METRIC ${metric} (new best) — kept${useGit ? " · committed" : ""}`));
		} else {
			if (useGit) discardIteration(cwd, head);
			discarded++;
			console.log(gray(`${dim(tag)}: METRIC ${metric} (best was ${best}) — discarded`));
		}
	}

	const summary = `\nloop complete: best METRIC=${best ?? "n/a"} · ${kept} kept · ${discarded} discarded`;
	console.log(bold(summary));
	recordLesson(cwd, `- [loop ${new Date().toISOString().slice(0, 10)}] ${summary.trim()}`, "loop: record experiment results");
}
