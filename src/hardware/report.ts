/** Current-machine planning and serving steps, shared by CLI and onboarding. */
import { bold, dim, green, red, yellow } from "../util/ansi.ts";
import { verdictMark } from "./fit.ts";
import { gb, profileHardware, summarizeHardware, type HardwareProfile } from "./profile.ts";
import { probeServingTools, servingRecommendations, type ServingOptions, type ServingPlan } from "./recipes.ts";

export function hardwareReportLines(profile: HardwareProfile, plan: ServingPlan, tools: Awaited<ReturnType<typeof probeServingTools>>): string[] {
	const lines = [bold("rein hardware — this machine"), `  ${summarizeHardware(profile)}`, `  ${gb(profile.ram.availableBytes, 1)} system memory available now`,
		`  Plan: ${plan.contextTokens} context tokens, one concurrent request, f16 KV. Focus: ${plan.focus}.`, ""];
	for (const g of profile.gpus) {
		if (g.vramTotalBytes && !g.sharedMemory) lines.push(`  ${g.name}: ${gb(g.vramTotalBytes, 1)} VRAM, ${g.vramFreeBytes == null ? "free memory unknown" : gb(g.vramFreeBytes, 1) + " free"}`);
		else lines.push(`  ${g.name}: ${g.sharedMemory ? "shared system memory" : "VRAM unavailable"}`);
	}
	for (const note of profile.notes ?? []) lines.push(`  ${dim(note)}`);
	lines.push("", bold("model memory estimates"));
	for (const { model, assessment: a } of plan.recommendations) {
		const plain = verdictMark(a).padEnd(19);
		const mark = a.verdict === "fits" ? green(plain) : a.verdict === "tight" ? yellow(plain) : red(plain);
		lines.push(`  ${mark} ${model.name.padEnd(27)} ${a.quant.label.padEnd(7)} ${gb(a.totalBytes, 1).padStart(9)} ${a.placement}${a.gpuIndex == null ? "" : ` #${a.gpuIndex}`}`);
	}
	if (plan.best) {
		lines.push("", `suggested starting model: ${bold(plan.best.model.name)}`, `  ${plan.best.reason}`, `  ${plan.best.assessment.estimate}`);
		if (plan.best.assessment.estTokS) lines.push(`  Low-confidence decode estimate: ~${plan.best.assessment.estTokS} tok/s. This is not a benchmark.`);
	}
	lines.push("", bold("serving recipes — run only the one you choose"));
	if (!plan.recipes.length) lines.push("  No launch recipe has sufficient assessed memory headroom. The notes below describe the next step.");
	for (const recipe of plan.recipes) {
		lines.push("", `  ${bold(recipe.title)} (${tools[recipe.engine]?.onPath ? "CLI found on PATH; runtime unverified" : "CLI not found on PATH"})`,
			`  Model: ${recipe.model.name}, ${recipe.assessment.quant.label}, ${recipe.assessment.contextTokens} context tokens`,
			`  ${recipe.assessment.estimate}`, `  Chat Completions base URL: ${recipe.baseUrl}`);
		for (const prerequisite of recipe.prerequisites) lines.push(`    Before: ${prerequisite}`);
		for (const command of recipe.commands) lines.push(`    ${command}`);
		lines.push(`    Check: ${recipe.checks.join(" → ")}`);
		for (const note of recipe.notes) lines.push(`    ${dim(note)}`);
		lines.push(`    Docs: ${recipe.sources.join(" ")}`);
	}
	lines.push("", ...plan.notes.map(note => dim(note)));
	return lines;
}

export async function printHardwareReport(opts: ServingOptions & { json?: boolean; log?: (text: string) => void } = {}): Promise<number> {
	const log = opts.log ?? console.log;
	const [profile, tools] = await Promise.all([profileHardware(), probeServingTools()]);
	const plan = servingRecommendations(profile, opts);
	if (opts.json) {
		log(JSON.stringify({ scope: plan.scope, hardware: { ...profile, ram: { total: profile.ram.totalBytes, available: profile.ram.availableBytes } },
			contextTokens: plan.contextTokens, focus: plan.focus, tools,
			models: plan.recommendations.map(({ model, assessment: a, reason }) => ({ id: model.id, name: model.name, params: model.params,
				activeParams: model.activeParams, quant: a.quant.label, footprint: Math.round(a.totalBytes), weightsBytes: Math.round(a.weightsBytes),
				kvBytes: Math.round(a.kvBytes), runtimeBytes: Math.round(a.runtimeBytes), reserveBytes: Math.round(a.reserveBytes),
				contextTokens: a.contextTokens, placement: a.placement, gpuIndex: a.gpuIndex, verdict: a.verdict, estTokS: a.estTokS,
				confidence: a.confidence, limitations: a.limitations, ollama: a.quant.ollama, reason })),
			best: plan.best?.model.id, recipes: plan.recipes, notes: plan.notes }, null, 2));
	} else {
		for (const line of hardwareReportLines(profile, plan, tools)) log(line);
	}
	return 0;
}
