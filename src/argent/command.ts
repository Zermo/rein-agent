/** rein argent — the Argent toolkit surface in the harness CLI. */
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { TmuxShells } from "../harness/tmux.ts";
import { argentReport, formatArgentReport, ARGENT_BASE } from "./inventory.ts";
import { parseFlow, replayFlow, formatFlowReport } from "./flows.ts";
import { decodePng, diffImages, encodePng } from "./png.ts";
import { TerminalProvider, providerStatus, providerDirectory } from "./providers.ts";

type Flags = Record<string, string | boolean>;

const HELP = `Argent — the agent device toolkit (rebuilt from software-mansion/argent, Apache-2.0)

  rein argent help                 this help
  rein argent status [--json]      which providers this machine actually has
  rein argent rebuild [--json]     upstream pin, component mapping, parity gates
  rein argent flow validate <file> check a flow file without running it
  rein argent flow run <file> [--pane <id> [--settle-ms n]]
                                   replay a flow on the terminal provider
  rein argent screenshot [--pane <id>] --out <file.png>
                                   capture a terminal pane as a PNG
  rein argent diff <baseline.png> <actual.png> [--threshold 0-255] [--json]
                                   visual regression: per-channel pixel diff

The terminal provider drives a persistent Rein tmux pane: type, key,
screenshot, capture-text. tap/swipe steps skip against it (no pointer
surface); iOS/Android/TV/desktop providers are parity gates — see rebuild.`;

export async function runArgentCommand(args: string[], flags: Flags = {}, deps: {
	log?: (text: string) => void;
	tmux?: () => TmuxShells;
} = {}): Promise<void> {
	const log = deps.log ?? console.log;
	const action = args[0] ?? "help";
	if (action === "help") { log(HELP); return; }
	if (action === "status") {
		for (const key of Object.keys(flags)) if (key !== "json") throw new Error("Unsupported argent option --" + key);
		const status = await providerStatus();
		log(flags.json === true ? JSON.stringify(status, null, 2) : [
			`Argent providers on this machine`,
			`  builtin   terminal ${status.builtin.ready ? "READY" : "unavailable"} — ${status.builtin.detail}`,
			...(status.external.length ? status.external.map(entry => `  external  ${entry.providerId} (${entry.devices} devices) — ${entry.path}`) : ["  external  none found in " + providerDirectory()]),
			`  upstream  ${ARGENT_BASE.package}@${ARGENT_BASE.version} @ ${ARGENT_BASE.commit}`,
		].join("\n"));
		return;
	}
	if (action === "rebuild") {
		for (const key of Object.keys(flags)) if (key !== "json") throw new Error("Unsupported argent option --" + key);
		const report = argentReport();
		log(flags.json === true ? JSON.stringify(report, null, 2) : formatArgentReport(report));
		return;
	}
	if (action === "flow") {
		const sub = args[1];
		if (sub === "validate") {
			const file = args[2];
			if (!file) throw new Error("Usage: rein argent flow validate <flow.json>");
			const flow = parseFlow(await readFile(pathOf(file), "utf8"), file);
			log(`Flow ${flow.name}: ${flow.steps.length} steps, provider ${flow.provider} — valid`);
			return;
		}
		if (sub === "run") {
			const file = args[2];
			if (!file) throw new Error("Usage: rein argent flow run <flow.json> [--pane <id>]");
			for (const key of Object.keys(flags)) if (!["pane", "settle-ms", "json"].includes(key)) throw new Error("Unsupported flow option --" + key);
			const flow = parseFlow(await readFile(pathOf(file), "utf8"), file);
			if (flow.provider !== "terminal") throw new Error(`Flow provider ${flow.provider} has no driver in this rebuild; run the flow with a matching provider upstream.`);
			const settleMs = flags["settle-ms"] === undefined ? undefined : Number(flags["settle-ms"]);
			if (settleMs !== undefined && (!Number.isFinite(settleMs) || settleMs < 0)) throw new Error("--settle-ms must be 0 or more.");
			const shells = (deps.tmux ?? (() => new TmuxShells()))();
			const provider = new TerminalProvider(shells, { paneId: typeof flags.pane === "string" ? flags.pane : undefined, settleMs });
			await provider.open();
			try {
				const report = await replayFlow(flow, provider);
				log(flags.json === true ? JSON.stringify(report, null, 2) : formatFlowReport(report));
				if (!report.ok) process.exitCode = 1;
			} finally {
				await provider.stop().catch(() => {});
			}
			return;
		}
		throw new Error("Usage: rein argent flow validate <flow.json> | rein argent flow run <flow.json>");
	}
	if (action === "screenshot") {
		for (const key of Object.keys(flags)) if (!["pane", "out", "cell-width", "cell-height"].includes(key)) throw new Error("Unsupported screenshot option --" + key);
		const out = flags.out;
		if (typeof out !== "string" || !out.trim()) throw new Error("Usage: rein argent screenshot --out <file.png> [--pane <id>]");
		const provider = new TerminalProvider((deps.tmux ?? (() => new TmuxShells()))(), { paneId: typeof flags.pane === "string" ? flags.pane : undefined });
		await provider.open();
		try {
			const image = await provider.screenshot();
			await writeFile(pathOf(out), encodePng(image));
			log(`Wrote ${pathOf(out)} (${image.width}x${image.height} px from the pane text).`);
		} finally {
			await provider.stop().catch(() => {});
		}
		return;
	}
	if (action === "diff") {
		const baseline = args[1], actual = args[2];
		if (!baseline || !actual) throw new Error("Usage: rein argent diff <baseline.png> <actual.png> [--threshold 0-255] [--json]");
		for (const key of Object.keys(flags)) if (!["threshold", "json"].includes(key)) throw new Error("Unsupported diff option --" + key);
		const threshold = flags.threshold === undefined ? 12 : Number(flags.threshold);
		if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) throw new Error("--threshold must be a number from 0 to 255.");
		const a = decodePng(await readFile(pathOf(baseline)));
		const b = decodePng(await readFile(pathOf(actual)));
		const result = diffImages(a, b, threshold);
		if (flags.json === true) { log(JSON.stringify(result, null, 2)); return; }
		log([
			result.identical ? "IDENTICAL (within threshold)" : "DIFFERENT",
			`  images:    ${result.width}x${result.height}`,
			`  threshold: ${threshold} per channel`,
			`  differing: ${(result.diffRatio * 100).toFixed(2)}% of pixels${result.bbox ? ` (bbox ${result.bbox.join(",")})` : ""}`,
			...(!result.identical ? [`  samples:   ${result.samples.map(sample => sample.join(",")).join("  ")}`] : []),
			result.identical ? "  gate:      visual regression passed" : "  gate:      review the region before accepting the change",
		].join("\n"));
		if (!result.identical) process.exitCode = 1;
		return;
	}
	throw new Error("Unknown argent action. Run rein argent help.");
}

function pathOf(path: string): string {
	return isAbsolute(path) ? path : resolve(process.cwd(), path);
}


