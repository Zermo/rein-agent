import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDossierDir, renderDossierMarkdown, writeDossier } from "../src/learn/dossier.ts";
import type { MachineLearn } from "../src/learn/profile.ts";

const fixture: MachineLearn = {
	schemaVersion: 1,
	learnedAt: "2026-01-01T00:00:00.000Z",
	kind: "host",
	machine: { os: "macos", release: "26.6.2", arch: "arm64", hostname: "host-a", model: "Mac16,10", kernel: "25.6.0", cpu: "10 cores, Apple Silicon", ramBytes: 25769803776, virtualized: "physical" },
	bootChain: [
		{ stage: "bootrom", trust: "immutable", notes: "Apple per-board ROM." },
		{ stage: "secure-boot", trust: "SIP disabled", evidence: "csrutil" },
		{ stage: "kernel", trust: "amfi-signed", evidence: "sysctl", notes: "25.6.0." },
	],
	probes: [{ id: "sip", command: "csrutil status", ok: true, detail: "System Integrity Protection status: disabled." }],
	gates: [{ id: "secure-boot", status: "verified", detail: "SIP disabled; state read." }],
	notes: ["Read-only pass."],
};

test("dossier writes json, markdown, and evidence into one new directory", async () => {
	const base = await mkdtemp(join(tmpdir(), "learn-dossier-"));
	const dir = await freshDossierDir(base, "host-a", new Date("2026-01-01T00:00:00Z"));
	const files = await writeDossier(dir, fixture, { sip: "System Integrity Protection status: disabled." });
	assert.ok(files.dir.startsWith(base));
	const parsed = JSON.parse(await readFile(join(dir, "dossier.json"), "utf8")) as MachineLearn;
	assert.equal(parsed.machine.hostname, "host-a");
	assert.equal(parsed.bootChain.length, 3);
	const md = await readFile(join(dir, "dossier.md"), "utf8");
	assert.match(md, /Colonel structure/);
	assert.match(md, /host-a/);
	assert.equal((await readdir(join(dir, "evidence"))).length, 1);
});

test("writing into an existing directory refuses instead of overwriting or deleting", async () => {
	const base = await mkdtemp(join(tmpdir(), "learn-dossier-"));
	const dir = await freshDossierDir(base, "host-a", new Date("2026-01-01T00:00:00Z"));
	await writeDossier(dir, fixture);
	await assert.rejects(() => writeDossier(dir, fixture), /already exists/);
	const sibling = join(base, "keep-me.txt");
	await writeFile(sibling, "do not delete");
	assert.equal(await readFile(sibling, "utf8"), "do not delete");
});

test("freshDossierDir steps to the next free name and never touches existing ones", async () => {
	const base = await mkdtemp(join(tmpdir(), "learn-dossier-"));
	const now = new Date("2026-01-01T00:00:00Z");
	const first = await freshDossierDir(base, "host-a", now);
	await mkdir(first, { recursive: true });
	const second = await freshDossierDir(base, "host-a", now);
	assert.notEqual(first, second);
	assert.match(second, /-1$/);
	assert.equal(await readFile(join(first, "dossier.json"), "utf8").then(() => "present").catch(() => "absent"), "absent");
});

test("markdown rendering is deterministic for the same dossier", async () => {
	assert.equal(renderDossierMarkdown(fixture), renderDossierMarkdown(fixture));
});
