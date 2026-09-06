/**
 * rein improve — the harness improves itself.
 *
 * Karpathy's autoresearch loop, pointed at the harness's own repo:
 *
 *   read LESSONS.md ("## harness") + the goal
 *   → pick ONE concrete weakness
 *   → make the smallest change that fixes it
 *   → run the complete npm test suite
 *   → pass?  append the lesson, git commit, next weakness
 *     fail?  discard the experiment, commit its lesson, next weakness
 *   → until nothing left, or --max-iterations reached
 *
 * This is the "never stop, one metric, keep/discard" pattern from
 * karpathy/autoresearch with the harness as the target.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { dim, gray, green, red, yellow, bold } from "../util/ansi.ts";
import { requireCleanGit, discardIteration, recordLesson, incompleteRunReason, checkpointIncompleteRun } from "./loop.ts";
import type { IterationRunner } from "./loop.ts";
import { createRunner } from "./runner.ts";
import { buildImprovePrompt } from "./system-prompt.ts";
import type { RunnerOptions } from "./runner.ts";
import { loadConfig } from "../ai/models.ts";
import { resolveRunBudgets } from "./run-budgets.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Layout-agnostic repo root: <root>/src/harness when run from source, <root>/dist
// in the bundled CLI. Find the directory that actually holds test/smoke.ts.
const REIN_REPO =
	[here, resolve(here, ".."), resolve(here, "..", "..")].find((dir) => existsSync(join(dir, "test", "smoke.ts"))) ??
	resolve(here, "..", "..");

export interface ImproveOptions extends RunnerOptions {
	goal?: string;
	maxIterations?: number;
	dryRun?: boolean;
}
export interface ImproveDependencies {
	/** Test-only target override; never read from configuration or CLI flags. */
	repoDir?: string;
	createRunner?: (options: RunnerOptions) => Promise<IterationRunner>;
	runTests?: typeof runHarnessTests;
}

function sh(cmd: string, cwd: string): string {
	return execFileSync("bash", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
}

export function runHarnessTests(repoDir: string): { pass: boolean; output: string } {
	// Node cannot strip types below node_modules; test a scratch source copy there.
	const dir = repoDir.split(/[\\/]/).includes("node_modules") ? mkdtempSync(join(tmpdir(), "rein-validation-")) : repoDir;
	try {
		if (dir !== repoDir) for (const name of ["src", "test", "vendor", "package.json", "scripts"]) {
			if (existsSync(join(repoDir, name))) cpSync(join(repoDir, name), join(dir, name), { recursive: true });
		}
		const output = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], {
			cwd: dir, encoding: "utf8", timeout: 300_000, stdio: ["ignore", "pipe", "pipe"],
		});
		return { pass: true, output };
	} catch (err: any) {
		return { pass: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}` };
	} finally {
		if (dir !== repoDir) rmSync(dir, { recursive: true, force: true });
	}
}

/** Extract the "## harness" section of LESSONS.md (the self-improvement queue). */
function harnessLessons(repoDir: string): string {
	const path = join(repoDir, "LESSONS.md");
	if (!existsSync(path)) return "";
	const text = readFileSync(path, "utf8");
	const m = text.match(/## harness\s*\n([\s\S]*?)(?=\n## |$)/);
	return m?.[1]?.trim() ?? "";
}

export async function runImproveLoop(opts: ImproveOptions, dependencies: ImproveDependencies = {}): Promise<void> {
	const repoDir = dependencies.repoDir ?? REIN_REPO;
	const { maxTurns, maxIterations: maxIters } = resolveRunBudgets(loadConfig(), opts);
	const goal = opts.goal ?? "";
	if (opts.dryRun) { console.log(`rein improve dry run: target ${repoDir}, up to ${maxIters} iterations and ${maxTurns} model turns per iteration; no changes made`); return; }
	requireCleanGit(repoDir);
	const useGit = true;

	const runner = await (dependencies.createRunner ?? createRunner)({
		...opts,
		cwd: repoDir,
		systemPrompt: buildImprovePrompt(repoDir),
		maxTurns,
	});

	console.log(
		gray(
			`rein improve · target: ${repoDir}\nmodel: ${runner.model.provider}/${runner.model.id} · max ${maxIters} iterations, ${maxTurns} model turns per iteration · ${useGit ? "git keep/discard" : "no git"}\n`,
		),
	);

	const lessons = harnessLessons(repoDir);
	const queueText = [
		goal ? `The user's goal this run: ${goal}` : "No explicit goal. Work through the harness weaknesses below.",
		"",
		lessons ? `Known harness weaknesses (from LESSONS.md):\n${lessons}` : "(no harness lessons recorded yet — look for the weakest part of the harness by reading the code)",
	].join("\n");

	let iterations = 0;
	let improved = 0;
	let stop = "iteration limit reached; goal completion is unverified";
	let feedback = "";

	while (iterations < maxIters) {
		iterations++;
		const head = sh("git rev-parse HEAD", repoDir);
		const tag = randomUUID().slice(0, 8);
		console.log(`\n${bold(`iteration ${iterations}/${maxIters}`)} ${dim(tag)}`);

		const prompt =
			iterations === 1
				? queueText + "\n\nDo not commit, reset, stage, or switch Git branches; the harness owns keep/discard. Pick the single most concrete weakness and fix it with the smallest change that works. Then run npm test and report the result as: RESULT: improved | no-change | failed"
				: `${feedback}\nCurrent goal: ${goal.slice(0, 1000) || "Work through concrete harness weaknesses in LESSONS.md."}\nContinue: pick the next concrete weakness. Inspect current files; discarded edits are no longer present. Do not commit, reset, stage, or switch Git branches. Report as: RESULT: improved | no-change | failed`;

		let outcome: "improved" | "no-change" | "failed" = "failed";
		let report = "";
		try {
			const messages = await runner.run({ role: "user", content: prompt, timestamp: Date.now() });
			const incomplete = incompleteRunReason(messages);
			if (incomplete) throw new Error(incomplete);
			const lastText = messages
				.filter((m) => m.role === "assistant")
				.at(-1)
				?.content.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join("");
			report = lastText ?? "";
			if (/RESULT:\s*improved/i.test(report)) outcome = "improved";
			else if (/RESULT:\s*no-change/i.test(report)) outcome = "no-change";
		} catch (err) {
			throw new Error(`Improvement paused: ${(err as Error).message}. Current work was preserved without keep/discard or a success commit. ${checkpointIncompleteRun(runner)}`);
		}

		// Verify independently of what the model claims (autoresearch's rule:
		// trust the metric, not the model).
		if (sh("git rev-parse HEAD", repoDir) !== head) throw new Error("Agent changed Git HEAD; stopping without discarding or committing additional work");
		const dirty = useGit ? sh("git status --porcelain", repoDir) : "unknown";
		if (outcome === "improved") {
			if (!useGit || (dirty && dirty.length > 0)) {
				const test = (dependencies.runTests ?? runHarnessTests)(repoDir);
				if (sh("git rev-parse HEAD", repoDir) !== head) throw new Error("Test command changed Git HEAD; stopping without further changes");
				if (test.pass) {
					appendFileSync(join(repoDir, "LESSONS.md"), `\n- [improve ${tag}] fixed: ${firstLine(report)}\n`);
					if (useGit) sh(`git add -A && git commit -m "rein improve: ${tag} (auto)"`, repoDir);
					improved++;
					feedback = "Harness verification: the complete test suite passed; the previous improvement was kept and committed.";
					console.log(green(`kept ${dim(tag)} — test suite passed${useGit ? " · committed" : ""}`));
				} else {
					feedback = `Harness verification: the complete test suite failed; the previous experiment was discarded and its edits are absent. Last test output: ${test.output.slice(-600)}`;
					if (useGit) discardIteration(repoDir, head);
					console.log(red(`discarded ${dim(tag)} — test suite failed`));
					console.log(dim(test.output.slice(-600)));
					recordLesson(repoDir, `- [improve ${tag}] tried and failed: ${firstLine(report)}`, `rein improve: ${tag} failed experiment lesson`);
				}
			} else {
				console.log(yellow(`${dim(tag)} claimed improved but the tree is clean — counting as no-change`));
				outcome = "no-change";
			}
		} else if (outcome === "no-change") {
			feedback = "Harness verification: no change was kept.";
			if (useGit && dirty) discardIteration(repoDir, head);
			console.log(gray(`${dim(tag)}: no change worth making — ${firstLine(report) || "no report"}`));
		} else {
			feedback = "Harness verification: the previous experiment failed and was discarded; its edits are absent.";
			if (useGit) discardIteration(repoDir, head);
			console.log(red(`${dim(tag)}: failed — ${firstLine(report) || (report ? report.slice(0, 120) : "no report")}`));
		}

		if (outcome === "no-change") {
			console.log(gray("agent found nothing more to improve — stopping"));
			stop = "agent reported no further improvement; goal completion is unverified";
			break;
		}
	}

	console.log(`\n${bold("improve stopped")}: ${stop}; ${improved} improvement(s) kept out of ${iterations} iteration(s)`);
}

function firstLine(text: string): string {
	return (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim().slice(0, 160);
}
