/** Fixed work-style questions and private, inspectable operator configuration. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const AXES = {
	focus: ["coding", "ops", "research", "creative"],
	density: ["terse", "normal", "walkthrough"],
	autonomy: ["ask", "plan", "yolo"],
	surface: ["cli", "chat", "voice"],
} as const;
export type Axis = keyof typeof AXES;
export type OperatorVector = { [A in Axis]: (typeof AXES)[A][number] };
export type OperatorAnswers = Record<"q1" | "q2" | "q3" | "q4", string>;
export type OperatorTallies = Record<Axis, Record<string, number>>;
export interface OperatorChoice { id: string; label: string; weights: Partial<{ [A in Axis]: readonly [(typeof AXES)[A][number], number] }> }
export interface OperatorItem { id: keyof OperatorAnswers; prompt: string; choices: readonly OperatorChoice[] }

// The choice IDs and weights are fixed. Future wording polls may change labels only.
export const ITEMS: readonly OperatorItem[] = [
	{ id: "q1", prompt: "When the agent talks, I want…", choices: [
		{ id: "a", label: "Bullets, then stop", weights: { density: ["terse", 2] } },
		{ id: "b", label: "Short paragraphs", weights: { density: ["normal", 2] } },
		{ id: "c", label: "Step by step, with why", weights: { density: ["walkthrough", 2] } },
	] },
	{ id: "q2", prompt: "Most days I will use this for…", choices: [
		{ id: "a", label: "Shipping code", weights: { focus: ["coding", 2] } },
		{ id: "b", label: "Keeping machines and services running", weights: { focus: ["ops", 2] } },
		{ id: "c", label: "Reading, writing, and research", weights: { focus: ["research", 2] } },
		{ id: "d", label: "Images, video, and design", weights: { focus: ["creative", 2] } },
	] },
	{ id: "q3", prompt: "When a change is risky, the agent should…", choices: [
		{ id: "a", label: "Ask first", weights: { autonomy: ["ask", 2] } },
		{ id: "b", label: "Show a plan, then do it", weights: { autonomy: ["plan", 2] } },
		{ id: "c", label: "Do it, tell me after", weights: { autonomy: ["yolo", 2] } },
	] },
	{ id: "q4", prompt: "I will mostly talk to it from…", choices: [
		{ id: "a", label: "Terminal", weights: { surface: ["cli", 2] } },
		{ id: "b", label: "Slack or chat", weights: { surface: ["chat", 2] } },
		{ id: "c", label: "Voice or phone", weights: { surface: ["voice", 2] } },
	] },
];

export const PACKS = {
	ship: { rule: { focus: "coding", density: "terse", autonomy: "yolo" }, skills: ["github-pr-workflow", "tdd", "caveman"] },
	ops: { rule: { focus: "ops", density: "terse", autonomy: "plan" }, skills: ["hermes-agent", "fleet-command-ops", "execution-discipline"] },
	study: { rule: { focus: "research", density: "walkthrough", autonomy: "ask" }, skills: ["grounded-citations", "plan"] },
	studio: { rule: { focus: "creative", density: "normal", autonomy: "ask" }, skills: ["claude-design", "comfyui"] },
} as const;
export type PackId = keyof typeof PACKS;
export interface OperatorScore { operator_profile: OperatorVector; recommended_pack: PackId; answers: OperatorAnswers; tallies: OperatorTallies }
export interface OperatorProfileDocument extends OperatorScore { version: 1; enabled_pack: PackId | null; enabled_skills: string[] }
export interface OperatorProfileRead { profile?: OperatorProfileDocument; diagnostic?: string }
export type OperatorFileName = "SOUL.md" | "USER.md" | "AGENTS.md" | "profile.yaml";
export type OperatorFiles = Record<OperatorFileName, string>;
export const OPERATOR_FILES: readonly OperatorFileName[] = ["SOUL.md", "USER.md", "AGENTS.md", "profile.yaml"];
const DEFAULTS: OperatorVector = { focus: "ops", density: "terse", autonomy: "plan", surface: "cli" };
const START = "<!-- rein:operator-profile:start -->";
const END = "<!-- rein:operator-profile:end -->";
const MAX_FILE_BYTES = 256 * 1024;
const profileHome = (home?: string) => home ?? (process.env.REIN_HOME || join(homedir(), ".rein"));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(value).length !== keys.length || keys.some(key => !own(value, key))) throw new Error(`${label} must contain exactly ${keys.join(", ")}.`);
}

export function scoreOperatorProfile(answers: Record<string, string>): OperatorScore {
	if (!record(answers)) throw new Error("Operator answers must be an object.");
	exactKeys(answers, ITEMS.map(item => item.id), "Operator answers");
	const tallies: OperatorTallies = { focus: {}, density: {}, autonomy: {}, surface: {} };
	for (const item of ITEMS) {
		const choice = item.choices.find(candidate => candidate.id === answers[item.id]);
		if (!choice) throw new Error(`Invalid answer for ${item.id}; choose ${item.choices.map(candidate => candidate.id).join(", ")}.`);
		for (const axis of Object.keys(choice.weights) as Axis[]) {
			const [label, weight] = choice.weights[axis]!;
			tallies[axis][label] = (tallies[axis][label] ?? 0) + weight;
		}
	}
	const operator_profile = { ...DEFAULTS };
	let tied = false;
	for (const axis of Object.keys(AXES) as Axis[]) {
		const maximum = Math.max(0, ...Object.values(tallies[axis]));
		const winners = AXES[axis].filter(label => (tallies[axis][label] ?? 0) === maximum);
		if (winners.length === 1) (operator_profile as Record<Axis, string>)[axis] = winners[0];
		else tied = true;
	}
	const recommended_pack = (tied ? undefined : (Object.keys(PACKS) as PackId[]).find(name => Object.entries(PACKS[name].rule).every(([axis, value]) => operator_profile[axis as Axis] === value))) ?? "ops";
	return { operator_profile, recommended_pack, answers: { q1: answers.q1, q2: answers.q2, q3: answers.q3, q4: answers.q4 }, tallies };
}

export function createOperatorProfile(answers: Record<string, string>, enabledPack: PackId | null): OperatorProfileDocument {
	if (enabledPack !== null && !own(PACKS, enabledPack)) throw new Error("Enabled pack must be ship, ops, study, studio, or null.");
	return { version: 1, ...scoreOperatorProfile(answers), enabled_pack: enabledPack, enabled_skills: enabledPack === null ? [] : [...PACKS[enabledPack].skills] };
}

function sameValues(actual: unknown, expected: unknown): boolean {
	if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => sameValues(actual[index], value));
	if (record(expected)) return record(actual) && Object.keys(actual).length === Object.keys(expected).length && Object.keys(expected).every(key => own(actual, key) && sameValues(actual[key], expected[key]));
	return actual === expected;
}
function validateProfile(value: unknown): OperatorProfileDocument {
	if (!record(value)) throw new Error("Profile must be a mapping.");
	exactKeys(value, ["version", "operator_profile", "recommended_pack", "enabled_pack", "enabled_skills", "answers", "tallies"], "Profile");
	if (value.version !== 1) throw new Error("Unsupported profile version; expected 1.");
	if (!record(value.answers)) throw new Error("Profile answers are missing.");
	const expected = createOperatorProfile(value.answers as Record<string, string>, value.enabled_pack as PackId | null);
	if (!sameValues(value, expected)) throw new Error("Profile values do not match its fixed answers and pack skills.");
	return expected;
}

function yamlScalar(value: string | number | null | string[]): string { return JSON.stringify(value); }
function profileYaml(profile: OperatorProfileDocument): string {
	const lines = ["# Private Rein operator profile. Rerun rein setup profile to change these preferences.", "version: 1", "operator_profile:"];
	for (const axis of Object.keys(AXES) as Axis[]) lines.push(`  ${axis}: ${yamlScalar(profile.operator_profile[axis])}`);
	lines.push(`recommended_pack: ${yamlScalar(profile.recommended_pack)}`, `enabled_pack: ${yamlScalar(profile.enabled_pack)}`, `enabled_skills: ${yamlScalar(profile.enabled_skills)}`, "answers:");
	for (const item of ITEMS) lines.push(`  ${item.id}: ${yamlScalar(profile.answers[item.id])}`);
	lines.push("tallies:");
	for (const axis of Object.keys(AXES) as Axis[]) {
		lines.push(`  ${axis}:`);
		for (const [label, value] of Object.entries(profile.tallies[axis])) lines.push(`    ${label}: ${value}`);
	}
	return lines.join("\n") + "\n";
}

/** Read the small mapping/scalar YAML subset written above; never execute YAML tags. */
function parseProfileYaml(text: string): unknown {
	const result: Record<string, unknown> = {};
	const parents: { indent: number; value: Record<string, unknown> }[] = [{ indent: -2, value: result }];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (/^\s*(?:#.*)?$/.test(line)) continue;
		const match = /^( *)([a-z][a-z0-9_]*):(?: +(.*))?$/.exec(line);
		if (!match || match[1].length % 2) throw new Error(`Unsupported YAML on line ${index + 1}.`);
		const indent = match[1].length, key = match[2], raw = match[3]?.trim();
		while (parents.length > 1 && parents[parents.length - 1].indent >= indent) parents.pop();
		const parent = parents[parents.length - 1];
		if (indent !== parent.indent + 2 || own(parent.value, key) || key === "__proto__" || key === "constructor" || key === "prototype") throw new Error(`Invalid YAML mapping on line ${index + 1}.`);
		if (!raw) {
			const child: Record<string, unknown> = {};
			parent.value[key] = child; parents.push({ indent, value: child });
		} else {
			try { parent.value[key] = JSON.parse(raw); }
			catch { if (/^[a-z][a-z0-9_-]*$/.test(raw)) parent.value[key] = raw; else throw new Error(`Unsupported YAML value on line ${index + 1}.`); }
		}
	}
	return result;
}

function readOptionalFile(path: string): string | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path} must be a regular file, not a link or directory.`);
		if (stat.size > MAX_FILE_BYTES) throw new Error(`${path} is too large; keep operator files below ${MAX_FILE_BYTES / 1024} KiB.`);
		return readFileSync(path, "utf8");
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
interface OperatorSnapshot { files: Record<OperatorFileName, string | undefined>; fingerprint: string }

function assertNoProfileSave(home: string): void {
	const lock = join(home, ".operator-profile.lock");
	try { lstatSync(lock); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	throw new Error(`Operator-profile save is in progress or was interrupted. Wait for setup to finish. If it stopped, check ${join(home, ".operator-profile-backups")} and restore a consistent set of original files if needed. Remove ${lock} only after confirming no setup is running, then rerun rein setup profile.`);
}

/** The writer uses this only while holding its own save lock. */
function readOperatorSnapshot(home: string): OperatorSnapshot {
	const files = {} as OperatorSnapshot["files"], digest = createHash("sha256");
	for (const name of OPERATOR_FILES) {
		const text = readOptionalFile(join(home, name));
		files[name] = text;
		// Hash the encoded pair to distinguish absent, empty, and arbitrary file text.
		digest.update(JSON.stringify([name, text ?? null]));
	}
	return { files, fingerprint: digest.digest("hex") };
}

/** A completed save between reads must not produce mixed old/new preferences. */
function readStableOperatorSnapshot(home: string): OperatorSnapshot {
	assertNoProfileSave(home);
	const snapshot = readOperatorSnapshot(home);
	assertNoProfileSave(home);
	const after = readOperatorSnapshot(home);
	assertNoProfileSave(home);
	if (snapshot.fingerprint !== after.fingerprint) throw new Error("Operator files changed while being read. Retry after the edit or setup finishes.");
	return snapshot;
}

/** Capture before rendering a preview, then pass to save as expectedFingerprint. */
export function operatorFilesFingerprint(home?: string): string {
	return readStableOperatorSnapshot(profileHome(home)).fingerprint;
}

export function readOperatorProfile(home?: string): OperatorProfileRead {
	const dir = profileHome(home), path = join(dir, "profile.yaml");
	try {
		const text = readStableOperatorSnapshot(dir).files["profile.yaml"];
		return text === undefined ? {} : { profile: validateProfile(parseProfileYaml(text)) };
	} catch (error) {
		return { diagnostic: `Could not load ${path}: ${error instanceof Error ? error.message : String(error)} Run rein setup profile to review and recreate it; original files are preserved until you save.` };
	}
}

function mergeManaged(existing: string | undefined, body: string, name: string): string {
	const block = `${START}\n${body.trim()}\n${END}`;
	if (!existing) return `${block}\n`;
	const starts = existing.split(START).length - 1, ends = existing.split(END).length - 1;
	if (!starts && !ends) return `${existing}${existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n"}${block}\n`;
	if (starts !== 1 || ends !== 1 || existing.indexOf(START) >= existing.indexOf(END)) throw new Error(`${name} has incomplete or duplicate Rein managed markers. Repair those markers before saving; your file was not changed.`);
	return existing.slice(0, existing.indexOf(START)) + block + existing.slice(existing.indexOf(END) + END.length);
}

function documentBodies(profile: OperatorProfileDocument): Record<"SOUL.md" | "USER.md" | "AGENTS.md", string> {
	const vector = profile.operator_profile;
	const density = {
		terse: "Use concise bullets and stop when the answer is complete. Give critical context before optional detail.",
		normal: "Use short, connected paragraphs. Explain the result and the next useful step.",
		walkthrough: "Guide the operator step by step. Explain why each step matters and how to confirm it worked.",
	}[vector.density];
	const autonomy = {
		ask: "Ask before consequential changes. Do read-only investigation and prepare a concrete proposal while waiting.",
		plan: "Present a short plan, then carry out work already authorized by the operator. Pause at any required approval.",
		yolo: "Within the operator's authorized scope, carry out routine reversible work and report the result. Required approvals still apply.",
	}[vector.autonomy];
	return {
		"SOUL.md": `# Rein voice\n\nBe direct, curious, and practical. Address the operator as a collaborator.\n${density}\nDescribe observed results and uncertainty accurately. Never claim work or learning that has not happened.`,
		"USER.md": `# Operator work preferences\n\nThese are the operator's explicit work-style choices and can be revised at any time.\n- Main focus: ${vector.focus}.\n- Response density: ${vector.density}.\n- Working autonomy: ${vector.autonomy}.\n- Preferred surface: ${vector.surface}.\n\n${density}\n${autonomy}\nFor long tasks, give progress checkpoints and make the next action easy to find. Ask about pacing when needed; do not infer the operator's ability from these choices.`,
		"AGENTS.md": `# Rein operating brief\n\nUse this private profile alongside the current project's instructions.\n${autonomy}\n\n- Investigate the task, perform authorized work, and verify the outcome.\n- Suggest useful follow-ups from relevant history; let the operator accept, edit, or skip them.\n- Keep durable notes grounded in confirmed decisions. Review proposed changes to this profile with the operator.\n- This profile does not grant tool permissions, start background services, install external software, or connect chat or voice accounts.\n- Existing approval rules and project constraints continue to apply.\n- Recommended skill pack: ${profile.recommended_pack}. Enabled pack: ${profile.enabled_pack ?? "none (skipped)"}.\n- Enabled pack skills: ${profile.enabled_skills.length ? profile.enabled_skills.join(", ") : "none"}.`,
	};
}

/** Produces the exact preview without writing anything. Unmanaged Markdown stays intact. */
export function renderOperatorFiles(profile: OperatorProfileDocument, home?: string): OperatorFiles {
	const checked = validateProfile(profile), dir = profileHome(home), bodies = documentBodies(checked);
	return {
		"SOUL.md": mergeManaged(readOptionalFile(join(dir, "SOUL.md")), bodies["SOUL.md"], "SOUL.md"),
		"USER.md": mergeManaged(readOptionalFile(join(dir, "USER.md")), bodies["USER.md"], "USER.md"),
		"AGENTS.md": mergeManaged(readOptionalFile(join(dir, "AGENTS.md")), bodies["AGENTS.md"], "AGENTS.md"),
		"profile.yaml": profileYaml(checked),
	};
}

export function saveOperatorProfile(profile: OperatorProfileDocument, options: { home?: string; expectedFingerprint?: string } = {}): { paths: string[]; changed: OperatorFileName[]; backupDirectory?: string } {
	validateProfile(profile);
	const home = profileHome(options.home);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const lock = join(home, ".operator-profile.lock");
	let lockFd: number;
	try { lockFd = openSync(lock, "wx", 0o600); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another operator-profile save is in progress. Retry after it finishes; if it crashed, remove .operator-profile.lock after confirming no setup is running."); throw error; }
	const originals = new Map<OperatorFileName, string | undefined>(), staged = new Map<OperatorFileName, string>(), written: OperatorFileName[] = [];
	let backupDirectory: string | undefined;
	try {
		const snapshot = readOperatorSnapshot(home);
		if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== snapshot.fingerprint) throw new Error("Operator files changed after the preview. Nothing was saved. Restart the profile preview with rein setup profile and review the new contents.");
		for (const name of OPERATOR_FILES) originals.set(name, snapshot.files[name]);
		const rendered = renderOperatorFiles(profile, home);
		const changed = OPERATOR_FILES.filter(name => originals.get(name) !== rendered[name]);
		const existing = changed.filter(name => originals.get(name) !== undefined);
		if (existing.length) {
			backupDirectory = join(home, ".operator-profile-backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
			mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
			for (const name of existing) writeFileSync(join(backupDirectory, name), originals.get(name)!, { flag: "wx", mode: 0o600 });
		}
		for (const name of changed) {
			const temp = join(home, `.${name}.${randomUUID()}.tmp`);
			writeFileSync(temp, rendered[name], { flag: "wx", mode: 0o600 }); staged.set(name, temp);
		}
		// Check every target before replacing any file. profile.yaml is committed last.
		for (const name of OPERATOR_FILES) if (readOptionalFile(join(home, name)) !== originals.get(name)) throw new Error(`${name} changed during setup. Nothing was saved; review the new contents and try again.`);
		for (const name of changed) { renameSync(staged.get(name)!, join(home, name)); staged.delete(name); written.push(name); }
		return { paths: OPERATOR_FILES.map(name => join(home, name)), changed, ...(backupDirectory ? { backupDirectory } : {}) };
	} catch (error) {
		for (const name of written.reverse()) {
			const original = originals.get(name), target = join(home, name);
			try {
				if (original === undefined) unlinkSync(target);
				else { const temp = join(home, `.${name}.${randomUUID()}.restore`); writeFileSync(temp, original, { flag: "wx", mode: 0o600 }); renameSync(temp, target); }
			} catch { throw new Error(`Operator-profile save could not be restored completely. Recover the original files from ${backupDirectory ?? home}.`); }
		}
		throw error;
	} finally {
		for (const temp of staged.values()) { try { unlinkSync(temp); } catch {} }
		closeSync(lockFd); unlinkSync(lock);
	}
}

/** The current saved choices must fit before a long pre-existing notes section. */
function prioritizeManagedGuidance(content: string, name: string): string {
	const starts = content.split(START).length - 1, ends = content.split(END).length - 1;
	if (!starts && !ends) return content;
	const start = content.indexOf(START), end = content.indexOf(END);
	if (starts !== 1 || ends !== 1 || start >= end) throw new Error(`${name} has incomplete or duplicate Rein managed markers. Repair those markers before loading operator guidance.`);
	const managed = content.slice(start, end + END.length);
	const notes = (content.slice(0, start) + content.slice(end + END.length)).trim();
	return notes ? `${managed}\n\nAdditional operator notes:\n${notes}` : managed;
}

/** Include private guidance only when the machine-readable profile validates. */
export function readOperatorGuidance(home?: string, maxCharacters = 6000): { text: string; diagnostic?: string } {
	const limit = Number.isFinite(maxCharacters) ? Math.max(0, Math.min(12_000, Math.floor(maxCharacters))) : 6000;
	const perFile = Math.max(0, Math.floor(limit / 3) - 24);
	try {
		const snapshot = readStableOperatorSnapshot(profileHome(home));
		if (snapshot.files["profile.yaml"] === undefined) return { text: "" };
		validateProfile(parseProfileYaml(snapshot.files["profile.yaml"]));
		const sections = (["SOUL.md", "USER.md", "AGENTS.md"] as const).flatMap(name => {
			const content = snapshot.files[name];
			if (!content) return [];
			const prioritized = prioritizeManagedGuidance(content, name);
			return [`## ${name}\n${prioritized.slice(0, perFile)}${prioritized.length > perFile ? "\n[truncated]" : ""}`];
		});
		return { text: sections.join("\n\n").slice(0, limit) };
	} catch (error) { return { text: "", diagnostic: `Could not load operator guidance: ${error instanceof Error ? error.message : String(error)} Run rein setup profile to review your private Rein files.` }; }
}
