/**
 * rein improve — the harness improves itself.
 *
 * Karpathy's autoresearch loop, pointed at the harness's own repo:
 *
 *   read LESSONS.md ("## harness") + the goal
 *   → pick ONE concrete weakness
 *   → make the smallest change that fixes it
 *   → run the smoke test (node --experimental-strip-types test/smoke.ts)
 *   → pass?  git commit, append the lesson, next weakness
 *     fail?  git checkout ., note what went wrong, next weakness
 *   → until nothing left, or --max-iterations reached
 *
 * This is the "never stop, one metric, keep/discard" pattern from
 * karpathy/autoresearch with the harness as the target.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { cyan, dim, gray, green, red, yellow, bold } from "../util/ansi.ts";
import { createRunner } from "./runner.ts";
import type { Runner } from "./runner.ts";
import { buildImprovePrompt } from "./system-prompt.ts";
import type { RunnerOptions } from "./runner.ts";

const REIN_REPO = dirname(dirname(fileURLToPath(import.meta.url)));

export interface ImproveOptions extends RunnerOptions {
	goal?: string;
	maxIterations?: number;
	dryRun?: boolean;
}

function sh(cmd: string, cwd: string): string {
	return execFileSync("bash", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
}

function gitAvailable(cwd: string): boolean {
	try {
		sh("git rev-parse --is-inside-work-tree", cwd);
		return true;
	} catch {
		return false;
	}
}

function runSmokeTest(repoDir: string): { pass: boolean; output: string } {
	try {
		const out = execFileSync("node", ["--experimental-strip-types", "test/smoke.ts"], {
			cwd: repoDir,
			encoding: "utf8",
			timeout: 120_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { pass: true, output: out };
	} catch (err: any) {
		return { pass: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
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

export async function runImproveLoop(opts: ImproveOptions): Promise<void> {
	const repoDir = REIN_REPO;
	const maxIters = opts.maxIterations ?? 5;
	const goal = opts.goal ?? "";
	const useGit = gitAvailable(repoDir);

	if (!useGit) {
		console.log(yellow(`not a git repo (${repoDir}) — running without keep/discard; review changes manually`));
	}

	const runner = await createRunner({
		...opts,
		cwd: repoDir,
		systemPrompt: buildImprovePrompt(repoDir),
		maxTurns: 40,
	});

	console.log(
		gray(
			`rein improve · target: ${repoDir}\nmodel: ${runner.model.provider}/${runner.model.id} · max ${maxIters} iterations · ${useGit ? "git keep/discard" : "no git"}\n`,
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

	while (iterations < maxIters) {
		iterations++;
		const tag = randomUUID().slice(0, 8);
		console.log(`\n${bold(`iteration ${iterations}/${maxIters}`)} ${dim(tag)}`);

		const prompt =
			iterations === 1
				? queueText + "\n\nPick the single most concrete weakness and fix it with the smallest change that works. Then run the smoke test and report the result as: RESULT: improved | no-change | failed"
				: "Continue: pick the next concrete weakness (not the one you just fixed). Same rules. Report as: RESULT: improved | no-change | failed";

		let outcome: "improved" | "no-change" | "failed" = "failed";
		let report = "";
		try {
			const messages = await runner.run({ role: "user", content: prompt, timestamp: Date.now() });
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
			console.log(red(`run failed: ${(err as Error).message}`));
			outcome = "failed";
		}

		// Verify independently of what the model claims (autoresearch's rule:
		// trust the metric, not the model).
		const dirty = useGit ? sh("git status --porcelain", repoDir) : "unknown";
		if (outcome === "improved") {
			if (!useGit || (dirty && dirty.length > 0)) {
				const test = runSmokeTest(repoDir);
				if (test.pass) {
					if (useGit) {
						sh(`git add -A && git commit -m "rein improve: ${tag} (auto)"`, repoDir);
					}
					appendFileSync(join(repoDir, "LESSONS.md"), `\n- [improve ${tag}] fixed: ${firstLine(report)}\n`);
					improved++;
					console.log(green(`kept ${dim(tag)} — smoke test passed${useGit ? " · committed" : ""}`));
				} else {
					if (useGit) sh("git checkout . && git clean -fd", repoDir);
					console.log(red(`discarded ${dim(tag)} — smoke test failed`));
					console.log(dim(test.output.slice(-600)));
					appendFileSync(join(repoDir, "LESSONS.md"), `\n- [improve ${tag}] tried and failed: ${firstLine(report)}\n`);
				}
			} else {
				console.log(yellow(`${dim(tag)} claimed improved but the tree is clean — counting as no-change`));
				outcome = "no-change";
			}
		} else if (outcome === "no-change") {
			if (useGit && dirty) sh("git checkout . && git clean -fd", repoDir);
			console.log(gray(`${dim(tag)}: no change worth making — ${firstLine(report) || "no report"}`));
		} else {
			if (useGit) sh("git checkout . && git clean -fd", repoDir);
			console.log(red(`${dim(tag)}: failed — ${firstLine(report) || (report ? report.slice(0, 120) : "no report")}`));
		}

		if (outcome === "no-change") {
			console.log(gray("agent found nothing more to improve — stopping"));
			break;
		}
	}

	console.log(`\n${bold("done")}: ${improved} improvement(s) kept out of ${iterations} iteration(s)`);
}

function firstLine(text: string): string {
	return (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim().slice(0, 160);
}
