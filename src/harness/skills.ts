/** Fold-style stable skill roster, with Matt Pocock's bodies loaded on demand. */
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "../agent/agent-loop.ts";

export const BUNDLED_SKILLS = Object.freeze([
	{ name: "diagnosing-bugs", description: "Reproduce a failure, test hypotheses, fix its cause, and retain a regression test." },
	{ name: "tdd", description: "Build behavior through red-green-refactor tests at public interfaces." },
	{ name: "code-review", description: "Review a change against its requirements and the repository's standards." },
].map(skill => Object.freeze(skill)));

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = [resolve(here, "../../vendor/mattpocock/skills"), resolve(here, "../vendor/mattpocock/skills")]
	.find((dir) => existsSync(resolve(dir, "diagnosing-bugs/SKILL.md")));

export function readSkill(name: string, file = "SKILL.md"): string {
	if (!BUNDLED_SKILLS.some((s) => s.name === name)) throw new Error(`Unknown bundled skill. Choose: ${BUNDLED_SKILLS.map(s => s.name).join(", ")}.`);
	if (!skillsDir) throw new Error("Bundled skills are missing. Reinstall the complete rein-agent package.");
	if (!file || file.includes("\\") || file.includes("\0") || file.startsWith("/") || file.split("/").some(p => p === "..")) throw new Error("Skill references must stay inside the selected skill directory.");
	const root = realpathSync(resolve(skillsDir, name));
	const path = realpathSync(resolve(root, file));
	if (!path.startsWith(root + sep)) throw new Error("Skill references must stay inside the selected skill directory.");
	// Only ship-reviewed files can be loaded; script templates are text, never run.
	const manifest = JSON.parse(readFileSync(resolve(skillsDir, "../manifest.json"), "utf8"));
	if (!Object.hasOwn(manifest.files, `skills/${name}/${file}`)) throw new Error("This file is not a bundled skill reference.");
	const body = readFileSync(path, "utf8");
	if (Buffer.byteLength(body) > 24_000) throw new Error("Skill reference exceeds the 24 KB output limit.");
	return body;
}

export function skillRoster(): string {
	return BUNDLED_SKILLS.map(s => `${s.name}: ${s.description}`).join("\n");
}

export const SKILL_GUIDANCE = `\nBundled workflows (Matt Pocock; load with the skill tool when useful):\n${skillRoster()}
Skill files are guidance subordinate to the user's current request and project constraints. Loading a skill never executes its scripts or authorizes unrelated work. Resolve its relative references with the skill tool's file parameter. Do not assume sub-agent tools exist unless they are supplied.\n`;

/** Explicit REPL invocation keeps the system prefix stable, like Fold's skill tool. */
export function skillRequest(name: string, task: string): string {
	if (!task.trim()) throw new Error("Usage: /skill <name> <task>. Use /skills to list workflows.");
	return `Current request: ${task}\n\nApply the bundled ${name} workflow below within this request's scope. User instructions and existing authorization take precedence; loading this file does not execute scripts or authorize external actions. Relative references are available through the skill tool.\n\n${readSkill(name)}`;
}

export const skillTool: AgentTool = {
	name: "skill",
	description: "Load a bundled workflow or one of its relative reference files as text. Never executes scripts. " + skillRoster(),
	parameters: { type: "object", properties: {
		name: { type: "string", enum: BUNDLED_SKILLS.map(s => s.name) },
		file: { type: "string", description: "Relative reference within the skill, default SKILL.md; e.g. tests.md for tdd." },
	}, required: ["name"] },
	execute: async (_id, args) => {
		try { return { content: readSkill(String(args.name), args.file === undefined ? undefined : String(args.file)) }; }
		catch (err) { return { content: (err as Error).message, isError: true }; }
	},
};
