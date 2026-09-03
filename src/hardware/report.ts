/**
 * `rein hardware` — profile the machine, then show what it can run.
 * The "scan your hardware and give you what you can run" feature, stolen
 * from Magnitude and rebuilt as three small zero-dependency modules.
 */
import { bold, dim, green, red, yellow } from "../util/ansi.ts";
import { assessCatalog, verdictMark } from "./fit.ts";
import { gb, summarizeHardware } from "./profile.ts";

export async function printHardwareReport(opts: { json?: boolean } = {}): Promise<number> {
	const { profile, all: assessments } = await assessCatalog();
	const fits = assessments.filter((x) => x.a.verdict === "fits");
	const tight = assessments.filter((x) => x.a.verdict === "tight");
	const no = assessments.filter((x) => x.a.verdict === "no");

	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					hardware: {
						os: profile.os,
						cpu: profile.cpu,
						ram: { total: profile.ram.totalBytes, available: profile.ram.availableBytes },
						gpus: profile.gpus,
						unifiedMemory: profile.unifiedMemory,
						memBandwidthGBs: profile.memBandwidthGBs,
						bandwidthNote: profile.bandwidthNote,
					},
					models: assessments.map((x) => ({
						id: x.model.id,
						name: x.model.name,
						params: x.model.params,
						activeParams: x.model.activeParams,
						quant: x.a.quant.label,
						footprint: Math.round(x.a.totalBytes),
						placement: x.a.placement,
						verdict: x.a.verdict,
						estTokS: x.a.estTokS,
						ollama: x.model.ollama,
					})),
				},
				null,
				2,
			),
		);
		return 0;
	}

	console.log(bold("rein hardware"));
	console.log(`  ${profile.cpu.name} · ${profile.cpu.cores} cores${profile.cpu.features.length ? ` (${profile.cpu.features.join(", ")})` : ""}`);
	const bwLine = profile.memBandwidthGBs ? ` · ~${profile.memBandwidthGBs} GB/s${profile.bandwidthNote === "estimate" ? " (est)" : ""}` : "";
	console.log(
		profile.unifiedMemory
			? `  ${gb(profile.ram.totalBytes)} unified memory (${gb(profile.ram.availableBytes)} available)${bwLine}`
			: `  ${gb(profile.ram.totalBytes)} RAM (${gb(profile.ram.availableBytes)} available)${bwLine}`,
	);
	for (const g of profile.gpus) {
		if (g.vramTotalBytes) console.log(`  ${g.name} · ${gb(g.vramTotalBytes)} VRAM${g.vramFreeBytes != null ? ` (${gb(g.vramFreeBytes)} free)` : ""}`);
		else if (!profile.unifiedMemory) console.log(`  ${g.name} (no VRAM reported)`);
	}
	console.log("");

	const row = (x: (typeof assessments)[number]) => {
		const m = x.model;
		const moe = m.activeParams ? ` · ${Math.round(m.activeParams / 1e9)}B active` : "";
		// Pad the plain text, then color — escape codes after padding keep columns aligned.
		const markPlain = verdictMark(x.a).padEnd(14);
		const mark = x.a.verdict === "fits" ? green(markPlain) : x.a.verdict === "tight" ? yellow(markPlain) : red(markPlain);
		const get = m.ollama ? `  ${dim("ollama pull " + m.ollama)}` : "";
		console.log(`  ${mark} ${m.name.padEnd(26)} ${Math.round(m.params / 1e9)}B${moe.padEnd(16)} ${x.a.quant.label.padEnd(8)} ${dim(x.a.placement)}${get}`);
	};

	if (fits.length > 0) {
		console.log(bold(`what you can run (${fits.length})`));
		fits
			.sort((a, b) => (b.a.estTokS ?? 0) - (a.a.estTokS ?? 0) || b.model.params - a.model.params)
			.forEach(row);
	}
	if (tight.length > 0) {
		console.log("");
		console.log(bold("tight — fits only if other memory hogs are closed"));
		tight.forEach(row);
	}
	if (no.length > 0) {
		console.log("");
		console.log(dim(`out of reach: ${no.map((x) => x.model.name).join(", ")}`));
	}
	if (fits.length > 0) {
		const best = fits[0];
		console.log("");
		console.log(`best pick: ${bold(best.model.name)}`);
		if (best.model.ollama) console.log(`  ollama pull ${best.model.ollama}`);
		console.log(`  ${dim(best.a.estimate)}`);
	}
	console.log("");
	console.log(dim("estimates: footprint = weights + KV @ 16k ctx, 10%/2GiB reserve; tok/s = bandwidth × efficiency — directional, not a benchmark"));
	console.log(dim(`summary: ${summarizeHardware(profile)}`));
	return 0;
}
