/** Dossier writer. Creates one new directory of files; never overwrites, never deletes. */
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MachineLearn } from "./profile.ts";

export interface DossierFiles { dir: string; json: string; markdown: string; evidence: string[] }

export async function dirExists(dir: string): Promise<boolean> {
	try { await stat(dir); return true; } catch { return false; }
}

/** Choose <base>/<host>-<stamp> that does not exist yet. Nothing is ever deleted to make room. */
export async function freshDossierDir(base: string, host: string, now = new Date()): Promise<string> {
	const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const safe = host.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
	for (let i = 0; i < 60; i++) {
		const dir = join(resolve(base), `${safe}-${stamp}${i === 0 ? "" : `-${i}`}`);
		if (!(await dirExists(dir))) return dir;
	}
	throw new Error(`Could not find a free directory under ${base}.`);
}

export function renderDossierMarkdown(learn: MachineLearn): string {
	const m = learn.machine;
	const lines = [
		`# Machine dossier — ${m.hostname}`,
		"",
		`Learned ${learn.learnedAt} · ${m.os}/${m.arch} · ${m.release} · ${m.model}`,
		m.ramBytes ? `RAM: ${(m.ramBytes / 2 ** 30).toFixed(1)} GiB · ${m.cpu}` : `CPU: ${m.cpu}`,
		m.virtualized ? `Virtualization: ${m.virtualized}` : "",
		"",
		"## Boot chain (the Colonel structure)",
		"",
	];
	for (const [i, stage] of learn.bootChain.entries()) {
		lines.push(`${i + 1}. **${stage.stage}** — ${stage.trust}${stage.evidence ? ` _(evidence: ${stage.evidence})_` : ""}${stage.notes ? ` — ${stage.notes}` : ""}`);
	}
	lines.push("", "## Gates", "");
	for (const gate of learn.gates) lines.push(`- [${gate.status}] **${gate.id}**: ${gate.detail}`);
	lines.push("", "## Probes", "");
	for (const probe of learn.probes) lines.push(`- ${probe.ok ? "ok" : "MISSING"} **${probe.id}** — \`${probe.command}\` — ${probe.detail}`);
	if (learn.notes.length) {
		lines.push("", "## Notes", "");
		for (const note of learn.notes) lines.push(`- ${note}`);
	}
	lines.push("", "This dossier was produced by a read-only pass. It changed nothing on the machine.");
	return lines.filter(line => line !== "").join("\n") + "\n";
}

export async function writeDossier(dir: string, learn: MachineLearn, evidence: Record<string, string> = {}): Promise<DossierFiles> {
	if (await dirExists(dir)) throw new Error(`Output directory already exists: ${dir}. Choose a new one; nothing is deleted.`);
	await mkdir(dir, { recursive: true });
	const jsonPath = join(dir, "dossier.json");
	await writeFile(jsonPath, JSON.stringify(learn, null, 2) + "\n");
	const markdownPath = join(dir, "dossier.md");
	await writeFile(markdownPath, renderDossierMarkdown(learn));
	const evidencePaths: string[] = [];
	for (const [id, text] of Object.entries(evidence)) {
		if (!/^[a-z0-9-]+$/i.test(id)) throw new Error(`Evidence id is not a safe filename: ${id}`);
		const path = join(dir, "evidence", `${id}.txt`);
		await mkdir(join(dir, "evidence"), { recursive: true });
		await writeFile(path, text.endsWith("\n") ? text : text + "\n");
		evidencePaths.push(path);
	}
	return { dir, json: jsonPath, markdown: markdownPath, evidence: evidencePaths };
}
