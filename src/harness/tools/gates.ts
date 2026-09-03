/**
 * gates — unlazy (Leonxlnx/unlazy, MIT) as a harness tool.
 *
 * Completion discipline backed by runnable oracles: write an acceptance ledger
 * (GATES.md) BEFORE the work, lint it, run approved checks, reverify evidence
 * before reporting. The vendored checker at vendor/unlazy/scripts/gate-check.mjs
 * is zero-dependency Node — the same philosophy as rein itself.
 *
 * Workflow this tool supports (see vendor/unlazy/SKILL.md for the full method):
 *   1. gates {mode: "lint"}     — catch an oracle that cannot fail, before working
 *   2. gates {mode: "status"}   — report only; never executes (safe to read anytime)
 *   3. gates {mode: "approve"}  — approve each exact pending CHECK/EXPECT/CWD oracle, then run it
 *   4. gates {mode: "reverify"} — re-run every runnable gate; demote stale "met"
 *
 * Approval is the trust boundary: a CHECK line that has not been approved (and
 * shown to you as a resolved command) is NOT run. Approvals bind the exact
 * command, expectation, working directory, shell, and PATH — change any of
 * those and approval is required again.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "../../agent/agent-loop.ts";
import { truncateLines } from "../../util/truncate.ts";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
// Layout-agnostic: the vendored checker lives at <root>/vendor/unlazy. `here` is
// <root>/src/harness/tools when run from source, <root>/dist in the bundled CLI.
const UNLAZY_CANDIDATES = [
	resolve(here, "..", "..", "..", "vendor", "unlazy"),
	resolve(here, "..", "vendor", "unlazy"),
];
const UNLAZY_DIR =
	UNLAZY_CANDIDATES.find((dir) => existsSync(join(dir, "scripts", "gate-check.mjs"))) ?? UNLAZY_CANDIDATES[1];

const MODES = new Set(["status", "approve", "reverify", "lint"]);

const gatesTool: AgentTool = {
	name: "gates",
	description:
		"unlazy completion gates: run the acceptance ledger (GATES.md). " +
		"mode=lint checks the ledger for oracles that cannot fail; " +
		"mode=status reports met/unmet without executing anything; " +
		"mode=approve approves each exact pending CHECK/EXPECT/CWD oracle and runs it; " +
		"mode=reverify re-runs every runnable gate and demotes stale evidence. " +
		"For substantial work, write GATES.md from vendor/unlazy/templates/gates-leaf.md BEFORE implementing, lint it, then work, then reverify before reporting done. " +
		"Untested claims are not evidence — a checked box without EVIDENCE counts as unmet.",
	parameters: {
		type: "object",
		properties: {
			mode: { type: "string", enum: ["status", "approve", "reverify", "lint"], description: "What to do with the ledger" },
			file: { type: "string", description: "Ledger file (default GATES.md). Absolute or relative to root." },
			root: { type: "string", description: "Working directory for the checker (default: current working directory)" },
		},
		required: ["mode"],
	},
	execute: async (_id, args, signal) => {
		const mode = args.mode as string;
		if (!MODES.has(mode)) return { content: `Unknown mode: ${mode}. Use one of: status, approve, reverify, lint.`, isError: true };
		const file = args.file ? String(args.file) : "GATES.md";
		const root = args.root ? resolve(String(args.root)) : process.cwd();
		const ledgerPath = isAbsolute(file) ? file : join(root, file);
		if (!existsSync(ledgerPath)) {
			return { content: `Ledger not found: ${ledgerPath}. Write it first (template: vendor/unlazy/templates/gates-leaf.md), then run gates with mode=lint.`, isError: true };
		}
		const scriptPath = join(UNLAZY_DIR, "scripts", mode === "lint" ? "gate-lint.mjs" : "gate-check.mjs");
		const cmdArgs = mode === "lint" ? [scriptPath, ledgerPath] : [scriptPath, `--${mode}`, ledgerPath];

		let stdout = "";
		let stderr = "";
		let code = 0;
		try {
			const result = await execFileAsync(process.execPath, cmdArgs, {
				cwd: root,
				timeout: 600_000,
				maxBuffer: 8 * 1024 * 1024,
				signal,
			});
			stdout = result.stdout;
			stderr = result.stderr;
		} catch (err) {
			const e = err as any;
			stdout = e.stdout ?? "";
			stderr = e.stderr ?? e.message ?? "";
			code = typeof e.code === "number" ? e.code : 1;
		}

		const output = [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
		const truncated = truncateLines(output, 200);
		const tail = ` [gates:${mode} exit ${code}]`;
		// exit 1 from --status just means "unmet gates" — that's a report, not an error.
		// exit 2 = usage/parse/infrastructure; 3 = lease conflict. Those are real errors in every mode.
		const isError = code === 0 ? false : mode === "status" ? code >= 2 : true;
		return {
			content: truncated.text + (truncated.truncated ? " …[truncated]" : "") + tail,
			isError,
			details: { mode, exitCode: code },
		};
	},
};

export default gatesTool;
