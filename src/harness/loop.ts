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
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cyan, dim, gray, green, red, yellow, bold } from "../util/ansi.ts";
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

function readMetric(output: string): number | undefined {
	const m = output.match(/METRIC=(-?\d+(?:\.\d+)?)/);
	return m ? parseFloat(m[1]) : undefined;
}

function readMetricCommand(metricFile: string): string {
	const text = readFileSync(metricFile, "utf8");
	const m = text.match(/```\n([^\n`]+)\n```/);
	if (m) return m[1].trim();
	return text.trim().split("\n").filter((l) => l.trim() && !l.startsWith("#"))[0] ?? "";
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
		throw new Error(`No ${metricFile} in ${cwd} — put the metric command in a ``` fence and what METRIC= means, then re-run.`);
	}

	const task = readFileSync(taskPath, "utf8");
	const metricDoc = readFileSync(metricPath, "utf8");
	const metricCmd = readMetricCommand(metricDoc);
	const useGit = gitAvailable(cwd);
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
- Do not read this file again — act on it.
`.trim();

	let kept = 0;
	let discarded = 0;
	let stale = 0;
	for (let i = 0; i < maxIters; i++) {
		const tag = randomUUID().slice(0, 8);
		console.log(`\n${bold(`iteration ${i + 1}/${maxIters}`)} ${dim(tag)}`);
		try {
			await runner.run({ role: "user", content: i === 0 ? prompt : "Next iteration: one more improvement, different angle. If nothing better is plausible, say RESULT: no-change and stop.", timestamp: Date.now() });
		} catch (err) {
			console.log(red(`run failed: ${(err as Error).message}`));
		}

		const dirty = useGit ? sh("git status --porcelain", cwd) : "";
		if (!dirty) {
			console.log(gray(`${dim(tag)}: no changes made`));
			if (++stale >= 3) {
				console.log(gray("three iterations without changes — stopping"));
				break;
			}
			continue;
		}

		const metric = runMetric();
		if (metric === undefined) {
			console.log(yellow(`${dim(tag)}: metric could not be parsed — discarding`));
			if (useGit) sh("git checkout . && git clean -fd", cwd);
			discarded++;
			continue;
		}

		if (best === undefined || metric > best) {
			best = metric;
			if (useGit) sh(`git add -A && git commit -m "loop: ${tag} METRIC=${metric}"`, cwd);
			kept++;
			console.log(green(`${dim(tag)}: METRIC ${metric} (new best) — kept${useGit ? " · committed" : ""}`));
		} else {
			if (useGit) sh("git checkout . && git clean -fd", cwd);
			discarded++;
			console.log(gray(`${dim(tag)}: METRIC ${metric} (best was ${best}) — discarded`));
		}
	}

	const summary = `\nloop complete: best METRIC=${best ?? "n/a"} · ${kept} kept · ${discarded} discarded`;
	console.log(bold(summary));
	appendFileSync(join(cwd, "LESSONS.md"), `\n- [loop ${new Date().toISOString().slice(0, 10)}] ${summary}\n`);
}
