/** rein learn — a read-only pass on this machine or an attached iOS device. */
import * as os from "node:os";
import { join, resolve } from "node:path";
import { defaultRun, learnMachine, type ProbeResult } from "./profile.ts";
import { learnIos } from "./ios.ts";
import { dirExists, freshDossierDir, writeDossier, type DossierFiles } from "./dossier.ts";

export interface LearnCommandDeps {
	platform?: string;
	udid?: string;
	hostname?: () => string;
	home?: () => string;
	run?: (command: string, args: string[]) => Promise<import("./profile.ts").ProbeResult>;
	read?: (path: string) => Promise<string | undefined>;
	now?: () => Date;
	log?: (text: string) => void;
}

export async function runLearnCommand(args: string[], flags: Record<string, string | boolean> = {}, deps: LearnCommandDeps = {}): Promise<number> {
	const log = deps.log ?? console.log;
	const action = args[0] ?? "host";
	if (args.length > 1) throw new Error("Usage: rein learn [--json] | rein learn ios [--udid U] [--json]");
	const allowed = action === "host" ? ["json", "output"] : ["json", "output", "udid"];
	for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new Error(`Unsupported learn option --${key}.`);
	if (action !== "host" && action !== "ios") throw new Error(`Unknown learn target "${action}". Use rein learn or rein learn ios.`);

	const base = typeof flags.output === "string" && flags.output.trim() ? resolve(String(flags.output)) : join((deps.home ?? os.homedir)(), ".rein", "redteam");
	const hostKey = action === "ios" ? "ios-device" : "host";
	const dir = typeof flags.output === "string" && flags.output.trim()
		? base
		: await freshDossierDir(base, hostKey, deps.now ? deps.now() : new Date());
	if (await dirExists(dir)) throw new Error(`Output directory already exists: ${dir}. Choose a new one; nothing is deleted.`);

	const evidence: Record<string, string> = {};
	const baseRun = deps.run ?? defaultRun;
	const learnDeps = {
		platform: action === "ios" ? undefined : deps.platform,
		udid: action === "ios" ? (typeof flags.udid === "string" ? flags.udid : deps.udid) : undefined,
		hostname: deps.hostname,
		now: deps.now,
		read: deps.read,
		run: async (command: string, args: string[]): Promise<ProbeResult> => {
			const result = await baseRun(command, args);
			evidence[`${command.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40)}-${Object.keys(evidence).length}`] = result.ok ? result.stdout : result.stderr;
			return result;
		},
	};
	const { learn } = action === "ios" ? await learnIos(learnDeps) : await learnMachine(learnDeps);
	const files: DossierFiles = await writeDossier(dir, learn, evidence);

	if (flags.json === true) {
		log(JSON.stringify({ dossier: files.dir, learn }, null, 2));
	} else {
		const m = learn.machine;
		log(`Dareecho learn — ${m.hostname} (${m.os}/${m.arch})`);
		log(`  ${m.release} · ${m.model}${m.ramBytes ? ` · ${(m.ramBytes / 2 ** 30).toFixed(1)} GiB RAM` : ""} · ${m.virtualized ?? "physical"}`);
		log("");
		log("  Boot chain (the Colonel structure):");
		learn.bootChain.forEach((stage, i) => log(`    ${i + 1}. ${stage.stage} — ${stage.trust}${stage.notes ? ` — ${stage.notes}` : ""}`));
		log("");
		for (const gate of learn.gates) log(`  [${gate.status}] ${gate.id}: ${gate.detail}`);
		for (const note of learn.notes) log(`  note: ${note}`);
		log("");
		log(`Dossier: ${files.dir}`);
		log("Read-only pass. Nothing on the machine was changed or deleted.");
	}
	return 0;
}
