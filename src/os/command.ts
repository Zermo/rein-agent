import { readFile } from "node:fs/promises";
import { profileHardware } from "../hardware/profile.ts";
import { planReinOS, formatReinOSPlan } from "./plan.ts";
import { prepareReinOS } from "./prepare.ts";
import { previewRain } from "./rain.ts";

const HELP = `Dareecho development

  rein os plan [--mode host|image] [--json]   assess this machine and show installation gates
  rein os prepare --output <new-directory> [--target omarchy|chromeos]
                                           stage a pinned Omarchy VM overlay kit, or the
                                           ChromeOS userland kit (default target: omarchy)
  rein os rain [--static | --animate]        preview the rain motif in this terminal

Plan is read-only. Prepare writes only the chosen new kit directory. It does not
partition disks, install an operating system or enable a background service.
Rain is static by default; --animate requires a TTY. q or Ctrl-C restores the screen.
REIN_REDUCED_MOTION=1 keeps the preview still. No desktop theme is activated.
Use the kit's instructions on a disposable VM before testing physical hardware.`;
type Flags = Record<string, string | boolean>;
export function isChromeOSRelease(contents: string): boolean {
	return contents.split(/\r?\n/).some(line => {
		const match = /^\s*([A-Z0-9_]+)\s*=\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/i.exec(line);
		return match !== null && (match[1].toUpperCase().startsWith("CROS_RELEASE") ||
			(match[1].toUpperCase() === "ID" && match[2].toLowerCase() === "chromeos"));
	});
}
export async function runOSCommand(args: string[], flags: Flags = {}, deps: {
	log?: (text: string) => void; hardware?: typeof profileHardware;
	plan?: typeof planReinOS; prepare?: typeof prepareReinOS; rain?: typeof previewRain;
} = {}): Promise<void> {
	const log = deps.log ?? console.log, action = args[0] ?? "help";
	if (args.length > 1) throw new Error("Usage: rein os plan|prepare|rain. Run rein os help.");
	if (action === "help") { if (Object.keys(flags).length) throw new Error("Usage: rein os help"); log(HELP); return; }
	const allowed = action === "plan" ? ["mode", "json"] : action === "prepare" ? ["output", "json", "target"] : action === "rain" ? ["animate", "static"] : [];
	for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new Error(`Unsupported OS option --${key}.`);
	if (flags.json !== undefined && typeof flags.json !== "boolean") throw new Error("--json expects true or false.");
	if (action === "rain") {
		const boolean = (name: "animate" | "static") => {
			const value = flags[name];
			if (value === undefined) return undefined;
			if (value === true || value === "true") return true;
			if (value === false || value === "false") return false;
			throw new Error(`--${name} expects true or false.`);
		};
		const animate = boolean("animate"), still = boolean("static");
		if (animate && still) throw new Error("Choose --animate or --static, not both.");
		await (deps.rain ?? previewRain)({ animate, static: still }); return;
	}
	if (action === "plan") {
		const mode = flags.mode ?? "host";
		if (mode !== "host" && mode !== "image") throw new Error("--mode must be host or image.");
		const hardware = await (deps.hardware ?? profileHardware)();
		let chromeos = false;
		if (mode === "host" && hardware.os === "linux") {
			try { chromeos = isChromeOSRelease(await readFile("/etc/os-release", "utf8")); } catch { /* not ChromeOS */ }
		}
		const plan = (deps.plan ?? planReinOS)(hardware, { mode, chromeos });
		log(flags.json === true ? JSON.stringify(plan, null, 2) : formatReinOSPlan(plan)); return;
	}
	if (action === "prepare") {
		if (typeof flags.output !== "string" || !flags.output.trim() || /[\x00-\x1f\x7f]/.test(flags.output)) throw new Error("--output requires a new directory path.");
		if (flags.target !== undefined && flags.target !== "omarchy" && flags.target !== "chromeos") throw new Error("--target must be omarchy or chromeos.");
		const kit = await (deps.prepare ?? prepareReinOS)({ output: flags.output, target: flags.target as "omarchy" | "chromeos" | undefined });
		log(flags.json === true ? JSON.stringify(kit, null, 2) : kit.manifest.target === "chromeos"
			? `Prepared Dareecho ChromeOS kit: ${kit.output}\nFollow its README in an arc shell as the chronos user. The verified root and A/B partitions are not touched.`
			: `Prepared Dareecho VM kit: ${kit.output}\nFollow its README before booting or installing a VM. No operating system or service was changed.`); return;
	}
	throw new Error("Unknown OS action. Run rein os help.");
}
