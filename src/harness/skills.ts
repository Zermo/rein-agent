/** Fold-style stable per-run skill roster, with workflow bodies loaded on demand. */
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "../agent/agent-loop.ts";
import { PACKS, readOperatorProfile } from "./operator-profile.ts";
import { OPERATOR_PACK_SKILLS } from "./operator-pack-skills.ts";

interface SkillSummary { name: string; description: string }

export const BUNDLED_SKILLS = Object.freeze([
	{ name: "diagnosing-bugs", description: "Reproduce a failure, test hypotheses, fix its cause, and retain a regression test." },
	{ name: "tdd", description: "Build behavior through red-green-refactor tests at public interfaces." },
	{ name: "code-review", description: "Review a change against its requirements and the repository's standards." },
].map(skill => Object.freeze(skill)));

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = [resolve(here, "../../vendor/mattpocock/skills"), resolve(here, "../vendor/mattpocock/skills")]
	.find((dir) => existsSync(resolve(dir, "diagnosing-bugs/SKILL.md")));

/** Read at call time so an updated profile applies to the next runner or command. */
export function enabledSkills(home?: string): readonly SkillSummary[] {
	const { profile } = readOperatorProfile(home);
	const pack = profile?.enabled_pack ? PACKS[profile.enabled_pack] : undefined;
	const extras = pack ? OPERATOR_PACK_SKILLS.filter(skill => pack.skills.some(name => name === skill.name) && profile!.enabled_skills.includes(skill.name)) : [];
	return Object.freeze([...BUNDLED_SKILLS, ...extras.map(({ name, description }) => Object.freeze({ name, description }))]);
}

function loadSkill(skills: readonly SkillSummary[], name: string, file = "SKILL.md"): string {
	if (!skills.some((s) => s.name === name)) throw new Error(`Unknown or disabled skill. Choose: ${skills.map(s => s.name).join(", ")}. Use rein profile to choose an optional skill pack.`);
	if (!file || file.includes("\\") || file.includes("\0") || file.startsWith("/") || file.split("/").some(p => p === "..")) throw new Error("Skill references must stay inside the selected skill directory.");
	const native = OPERATOR_PACK_SKILLS.find(skill => skill.name === name);
	if (native) {
		if (file !== "SKILL.md") throw new Error("This Rein-native workflow only has SKILL.md; it has no reference files.");
		return native.body;
	}
	if (!skillsDir) throw new Error("Bundled skills are missing. Reinstall the complete rein-agent package.");
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

export function readSkill(name: string, file = "SKILL.md", home?: string): string {
	return loadSkill(enabledSkills(home), name, file);
}

export function skillRoster(home?: string): string {
	return formatRoster(enabledSkills(home));
}

function formatRoster(skills: readonly SkillSummary[]): string {
	return skills.map(s => `${s.name}: ${s.description}`).join("\n");
}

function guidance(skills: readonly SkillSummary[]): string {
	return `\nBundled workflows (load with the skill tool when useful):\n${formatRoster(skills)}
diagnosing-bugs, tdd, and code-review are reviewed Matt Pocock workflows. Other listed workflows are original Rein-native guidance from the enabled operator pack; they do not install external agents, apps, models, or connectors.
Skill files are guidance subordinate to the user's current request, project constraints, and tool approval settings. Loading a skill never executes its scripts or authorizes unrelated work. Resolve its relative references with the skill tool's file parameter. Do not assume sub-agent tools exist unless they are supplied.\n`;
}

/** Capture one roster for a runner, keeping its prompt and tool schema in sync. */
export function createSkillRuntime(home?: string): { skills: readonly SkillSummary[]; guidance: string; tool: AgentTool } {
	const skills = enabledSkills(home);
	const tool: AgentTool = {
		name: "skill",
		description: "Load an enabled workflow or one of its relative reference files as text. Never executes scripts. " + formatRoster(skills),
		parameters: { type: "object", properties: {
			name: { type: "string", enum: skills.map(s => s.name) },
			file: { type: "string", description: "Relative reference within the skill, default SKILL.md; e.g. tests.md for tdd." },
		}, required: ["name"] },
		execute: async (_id, args) => {
			try { return { content: loadSkill(skills, String(args.name), args.file === undefined ? undefined : String(args.file)) }; }
			catch (err) { return { content: (err as Error).message, isError: true }; }
		},
	};
	return { skills, guidance: guidance(skills), tool };
}

/** Explicit REPL invocation keeps the system prefix stable, like Fold's skill tool. */
export function skillRequest(name: string, task: string, home?: string): string {
	if (!task.trim()) throw new Error("Usage: /skill <name> <task>. Use /skills to list workflows.");
	return `Current request: ${task}\n\nApply the enabled ${name} workflow below within this request's scope. User instructions, project constraints, and existing authorization take precedence; loading this file does not execute scripts or authorize external actions. Relative references are available through the skill tool.\n\n${readSkill(name, "SKILL.md", home)}`;
}

/** Compatibility export for callers outside a runner; no profile is read at import time. */
export const skillTool: AgentTool = {
	name: "skill",
	get description() { return createSkillRuntime().tool.description; },
	get parameters() { return createSkillRuntime().tool.parameters; },
	execute: (id, args) => createSkillRuntime().tool.execute(id, args),
};
