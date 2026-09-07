/** rein export — keep personal files before a Dareecho OS replacement. */
import * as os from "node:os";
import { join, resolve } from "node:path";
import { exportFiles, formatBytes } from "./copy.ts";
import { existingPresets } from "./presets.ts";
import { runBrowser } from "./tui.ts";

export interface ExportCommandDeps {
	home?: () => string;
	platform?: string;
	tty?: boolean;
	now?: () => Date;
	log?: (text: string) => void;
	browse?: (options: { start?: string; target: string }) => Promise<number>;
}

function defaultTarget(home: string, now: Date): string {
	const date = now.toISOString().slice(0, 10);
	return join(home, `Dareecho-Export-${date}`);
}

export async function runExportCommand(args: string[], flags: Record<string, string | boolean> = {}, deps: ExportCommandDeps = {}): Promise<number> {
	const log = deps.log ?? console.log;
	const home = (deps.home ?? os.homedir)();
	const platform = deps.platform ?? process.platform;
	const action = args[0] ?? "browse";
	if (action === "browse" || action === "presets") {
		if (args.length > 1) throw new Error("Usage: rein export browse [--to DIR] | rein export <paths...> --to DIR | rein export presets [--to DIR] [--list]");
	} else if (args.length === 0) {
		throw new Error("Usage: rein export browse [--to DIR] | rein export <paths...> --to DIR | rein export presets [--to DIR] [--list]");
	}
	const allowed = action === "browse" ? ["to", "start", "json"] : ["to", "list", "json"];
	for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new Error(`Unsupported export option --${key}.`);

	if (action === "browse") {
		if (deps.tty === false && !(deps.browse)) throw new Error("Browse needs an interactive terminal. Use: rein export <paths...> --to <dir>");
		const target = typeof flags.to === "string" && flags.to.trim() ? resolve(flags.to) : defaultTarget(home, deps.now ? deps.now() : new Date());
		if (deps.browse) return deps.browse({ start: typeof flags.start === "string" ? flags.start : undefined, target });
		const result = await runBrowser(process.stdin, process.stdout, { start: typeof flags.start === "string" ? flags.start : undefined, target });
		log(result.lastNotice || "Browser closed. Nothing was exported or deleted.");
		return 0;
	}

	if (action === "presets") {
		const { presets, missing } = existingPresets(home, platform);
		if (flags.list === true || flags.json === true) {
			for (const preset of presets) log(`${preset.id}: ${preset.paths.join(", ")}`);
			if (missing.length) log(`not present, skipped: ${missing.join(", ")}`);
			return 0;
		}
		const target = typeof flags.to === "string" && flags.to.trim() ? resolve(flags.to) : defaultTarget(home, deps.now ? deps.now() : new Date());
		const sources = presets.flatMap(p => p.paths);
		if (sources.length === 0) { log("No personal data folders found in this home directory. Nothing to export."); return 0; }
		log(`Exporting ${presets.length} preset groups (${sources.length} folders) to ${target}`);
		const summary = await exportFiles(sources, target);
		log(`Exported ${summary.files} files (${formatBytes(summary.bytes)}) to ${target}. Sources are untouched — export copies, it never deletes.`);
		for (const skipped of summary.skipped) log(`  skipped: ${skipped}`);
		if (missing.length) log(`  not present, skipped: ${missing.join(", ")}`);
		return 0;
	}

	// rein export <paths...> --to DIR
	const sources = args;
	if (sources.length === 0) throw new Error("Choose at least one file or folder: rein export <paths...> --to <dir>");
	if (typeof flags.to !== "string" || !flags.to.trim()) throw new Error("--to <dir> is required (or use: rein export presets / rein export browse).");
	const target = resolve(flags.to);
	log(`Exporting ${sources.length} item(s) to ${target}`);
	const summary = await exportFiles(sources, target);
	log(`Exported ${summary.files} files (${formatBytes(summary.bytes)}) to ${target}. Sources are untouched — export copies, it never deletes.`);
	for (const skipped of summary.skipped) log(`  skipped: ${skipped}`);
	return 0;
}
