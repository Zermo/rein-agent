import { readFile } from "node:fs/promises";
import { profileHardware } from "../hardware/profile.ts";
import { planReinOS, formatReinOSPlan } from "./plan.ts";
import { prepareReinOS } from "./prepare.ts";
import { previewRain } from "./rain.ts";
import { rainmeterReport, formatRainmeterReport } from "./rainmeter.ts";
import { renderSkinFile, animateSkin } from "./skin/engine.ts";
import { installSkin, listSkins, skinDirectoryDefault } from "./skin/install.ts";
import { runFactoryCommand } from "./factory.ts";

const HELP = `Dareecho development

  rein os plan [--mode host|image] [--json]   assess this machine and show installation gates
  rein os prepare --output <new-directory> [--target omarchy|chromeos]
                                           stage a pinned Omarchy VM overlay kit, or the
                                           ChromeOS userland kit (default target: omarchy)
  rein os factory setup|start|stop|status|open
                                           Mastra Factory on this machine: install once,
                                           then drive the shared server (run rein os factory help)
  rein os rain [--static | --animate]        preview the rain motif in this terminal
  rein os rainmeter [--json]                 Rainmeter rebuild report: pin, mapping, gates
  rein os skin render <file|dir> [--frames n]
                                           render a Rainmeter-model skin (static by default;
                                           --frames animates on the alternate screen)
  rein os skin install <dir> [--dir <target>]
                                           stage a skin directory (refuses to overwrite)
  rein os skin list [--dir <target>]         list installed skins

Plan is read-only. Prepare writes only the chosen new kit directory. It does not
partition disks, install an operating system or enable a background service.
Rain is static by default; --animate requires a TTY. q or Ctrl-C restores the screen.
Skin render is static by default; --frames needs a TTY. REIN_REDUCED_MOTION=1
keeps previews and skins still. No desktop theme is activated.
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
	rainmeter?: () => ReturnType<typeof rainmeterReport>; factory?: typeof runFactoryCommand;
	skinRender?: typeof renderSkinFile; skinAnimate?: typeof animateSkin;
	skinInstall?: typeof installSkin; skinList?: typeof listSkins;
} = {}): Promise<void> {
	const log = deps.log ?? console.log, action = args[0] ?? "help";
	if (args.length > 3) throw new Error("Usage: rein os plan|prepare|rain|rainmeter|skin. Run rein os help.");
	if (action === "help") { if (Object.keys(flags).length) throw new Error("Usage: rein os help"); log(HELP); return; }
	if (["plan", "prepare", "rain", "rainmeter"].includes(action) && args.length > 1) throw new Error("Usage: rein os plan|prepare|rain|rainmeter|skin. Run rein os help.");
	if (action === "skin") {
		const sub = args[1];
		if (!sub) throw new Error("Usage: rein os skin render|install|list. Run rein os help.");
		if (sub === "render") {
			const target = args[2];
			if (!target) throw new Error("Usage: rein os skin render <file|dir> [--frames n]");
			for (const key of Object.keys(flags)) if (!["frames"].includes(key)) throw new Error("Unsupported skin option --" + key);
			const frames = flags.frames === undefined ? undefined : Number(flags.frames);
			if (frames !== undefined && (!Number.isSafeInteger(frames) || frames! < 1)) throw new Error("--frames must be a whole number of 1 or more.");
			if (frames === undefined) { log(await (deps.skinRender ?? renderSkinFile)(target)); return; }
			await (deps.skinAnimate ?? animateSkin)(target, { frames });
			return;
		}
		if (sub === "install") {
			const source = args[2];
			if (!source) throw new Error("Usage: rein os skin install <dir> [--dir <target>]");
			for (const key of Object.keys(flags)) if (!["dir"].includes(key)) throw new Error("Unsupported skin option --" + key);
			const result = await (deps.skinInstall ?? installSkin)({ source, target: typeof flags.dir === "string" ? flags.dir : skinDirectoryDefault() });
			log(`Installed skin ${result.target} (${result.files.length} files). Render it with: rein os skin render ${result.target}/*.ini`);
			return;
		}
		if (sub === "list") {
			for (const key of Object.keys(flags)) if (!["dir"].includes(key)) throw new Error("Unsupported skin option --" + key);
			const dir = typeof flags.dir === "string" ? flags.dir : skinDirectoryDefault();
			const skins = await (deps.skinList ?? listSkins)(dir);
			if (!skins.length) { log(`No skins installed in ${dir}. Stage one with: rein os skin install <skin-directory>`); return; }
			for (const skin of skins) log(`${skin.name}${skin.title ? ` — ${skin.title}` : ""}\n  ${skin.path}`);
			return;
		}
		throw new Error("Usage: rein os skin render|install|list. Run rein os help.");
	}
	if (action === "rainmeter") {
		for (const key of Object.keys(flags)) if (!["json"].includes(key)) throw new Error("Unsupported rainmeter option --" + key);
		const report = (deps.rainmeter ?? rainmeterReport)();
		log(flags.json === true ? JSON.stringify(report, null, 2) : formatRainmeterReport(report));
		return;
	}
	if (action === "factory") {
		const factory = deps.factory ?? runFactoryCommand;
		await factory(args.slice(1), flags, { log });
		return;
	}
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
