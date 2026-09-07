import { profileHardware } from "../hardware/profile.ts";
import { planReinOS, formatReinOSPlan } from "./plan.ts";
import { prepareReinOS } from "./prepare.ts";

const HELP = `Rein OS development

  rein os plan [--mode host|image] [--json]   assess this machine and show installation gates
  rein os prepare --output <new-directory>  stage a pinned Omarchy VM overlay kit

Plan is read-only. Prepare writes only the chosen new kit directory. It does not
partition disks, install an operating system or enable a background service.
Use the kit's instructions on a disposable VM before testing physical hardware.`;
type Flags = Record<string, string | boolean>;
export async function runOSCommand(args: string[], flags: Flags = {}, deps: {
	log?: (text: string) => void; hardware?: typeof profileHardware;
	plan?: typeof planReinOS; prepare?: typeof prepareReinOS;
} = {}): Promise<void> {
	const log = deps.log ?? console.log, action = args[0] ?? "help";
	if (args.length > 1) throw new Error("Usage: rein os plan|prepare. Run rein os help.");
	if (action === "help") { if (Object.keys(flags).length) throw new Error("Usage: rein os help"); log(HELP); return; }
	const allowed = action === "plan" ? ["mode", "json"] : action === "prepare" ? ["output", "json"] : [];
	for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new Error(`Unsupported OS option --${key}.`);
	if (flags.json !== undefined && typeof flags.json !== "boolean") throw new Error("--json expects true or false.");
	if (action === "plan") {
		const mode = flags.mode ?? "host";
		if (mode !== "host" && mode !== "image") throw new Error("--mode must be host or image.");
		const plan = (deps.plan ?? planReinOS)(await (deps.hardware ?? profileHardware)(), { mode });
		log(flags.json === true ? JSON.stringify(plan, null, 2) : formatReinOSPlan(plan)); return;
	}
	if (action === "prepare") {
		if (typeof flags.output !== "string" || !flags.output.trim() || /[\x00-\x1f\x7f]/.test(flags.output)) throw new Error("--output requires a new directory path.");
		const kit = await (deps.prepare ?? prepareReinOS)({ output: flags.output });
		log(flags.json === true ? JSON.stringify(kit, null, 2) : `Prepared Rein OS VM kit: ${kit.output}\nFollow its README before booting or installing a VM. No operating system or service was changed.`); return;
	}
	throw new Error("Unknown OS action. Run rein os help.");
}
