/** Magnitude-inspired memory planning: explicit pools, reserves and limitations.
 * No benchmarks, summed-GPU assumptions, or remote-hardware inference.
 */
import { CATALOG, type CatalogModel, type CatalogQuant } from "./catalog.ts";
import { gb, profileHardware, type HardwareProfile } from "./profile.ts";
const GiB = 1024 ** 3;
export const DEFAULT_PLAN_CONTEXT = 16_384;
export interface FitOptions { contextTokens?: number }
export interface FitAssessment {
	model: CatalogModel;
	quant: CatalogQuant;
	weightsBytes: number;
	kvBytes: number;
	runtimeBytes: number;
	totalBytes: number;
	contextTokens: number;
	placement: "gpu" | "unified" | "ram";
	gpuIndex?: number;
	verdict: "fits" | "tight" | "no";
	reserveBytes: number;
	availableBytes: number;
	capacityBytes: number;
	/** Low-confidence dense decode estimate only; never used to rank quality. */
	estTokS?: number;
	estimate: string;
	confidence: "planning-estimate";
	limitations: string[];
}
export function planContext(contextTokens?: number, maximum = DEFAULT_PLAN_CONTEXT): number {
	if (contextTokens == null) return Math.min(DEFAULT_PLAN_CONTEXT, maximum);
	if (!Number.isFinite(contextTokens) || contextTokens < 1) throw new Error("Context length must be a positive finite number.");
	return Math.min(Math.floor(contextTokens), maximum);
}
function reserveFor(capacity: number, gpu: boolean): number { return Math.max(capacity / 10, (gpu ? 1 : 2) * GiB); }
function finiteBytes(n: number | undefined): number { return n != null && Number.isFinite(n) && n > 0 ? n : 0; }

export function assessFit(profile: HardwareProfile, model: CatalogModel, quant: CatalogQuant, opts: FitOptions = {}): FitAssessment {
	const contextTokens = planContext(opts.contextTokens, model.contextLength);
	const weightsBytes = model.params * quant.bytesPerWeight * 1.05;
	// K and V, two bytes each. Unlike params-based estimates this accounts for GQA
	// and MoE layer geometry. Full context per layer conservatively covers SWA.
	const kvBytes = model.kv
		? 2 * 2 * model.kv.layers * model.kv.heads * model.kv.headDim * contextTokens
		: Math.max(0.5 * GiB, model.params * 0.18) * contextTokens / DEFAULT_PLAN_CONTEXT;
	const runtimeBytes = Math.max(0.5 * GiB, weightsBytes * 0.05);
	const totalBytes = weightsBytes + kvBytes + runtimeBytes;
	const limitations = ["One sequence, f16 KV; concurrent requests, vision, load-time buffers and runtime allocation limits can require more memory."];
	if (!model.kv) limitations.push("Architecture-specific KV geometry unavailable; conservative fallback estimate used.");
	if (model.activeParams) limitations.push("MoE keeps all weights resident. Expert routing and kernels make bandwidth-only speed estimates unreliable.");
	if (opts.contextTokens && opts.contextTokens > contextTokens) limitations.push(`Requested context was capped at the model's ${contextTokens}-token limit.`);
	type Pool = { placement: FitAssessment["placement"]; capacity: number; available: number; known: boolean; gpuIndex?: number };
	const ramTotal = finiteBytes(profile.ram.totalBytes), ramAvailable = Math.min(finiteBytes(profile.ram.availableBytes), ramTotal);
	const pools: Pool[] = profile.unifiedMemory
		? [{ placement: "unified", capacity: ramTotal, available: ramAvailable, known: true }]
		: [
			...profile.gpus.flatMap((g, gpuIndex) => g.vramTotalBytes && !g.sharedMemory ? [{ placement: "gpu" as const, capacity: finiteBytes(g.vramTotalBytes),
				available: Math.min(finiteBytes(g.vramFreeBytes), finiteBytes(g.vramTotalBytes)), known: g.vramFreeBytes != null, gpuIndex }] : []),
			{ placement: "ram", capacity: ramTotal, available: ramAvailable, known: true },
		];
	const candidates = pools.map(pool => {
		const reserve = reserveFor(pool.capacity, pool.placement === "gpu");
		const verdict = pool.known && totalBytes + reserve <= pool.available ? "fits" : totalBytes + reserve <= pool.capacity ? "tight" : "no";
		return { ...pool, reserve, verdict: verdict as FitAssessment["verdict"] };
	}).sort((a, b) => {
		const order = { fits: 0, tight: 1, no: 2 };
		return order[a.verdict] - order[b.verdict] || Number(a.placement === "ram") - Number(b.placement === "ram") || b.available - a.available;
	});
	const chosen = candidates[0];
	if (!chosen.known) limitations.push("Free memory in the selected GPU pool is unknown; fit requires a runtime check.");
	if (profile.gpus.length > 1) limitations.push("Each GPU is assessed separately. Multi-GPU sharding and CPU/GPU offload need an explicit engine plan.");
	if (chosen.placement === "ram") limitations.push("RAM placement means CPU inference; it does not establish GPU acceleration or interactive speed.");
	if (profile.unifiedMemory) limitations.push("Unified RAM is counted once; driver/Metal allocation limits may be lower than physical RAM.");
	const estTokS = !model.activeParams && chosen.verdict === "fits" && chosen.placement === "unified" && profile.os.startsWith("darwin") && profile.memBandwidthGBs
		? Math.max(1, Math.round(profile.memBandwidthGBs * 1e9 * 0.35 / (weightsBytes + kvBytes))) : undefined;
	if (estTokS) limitations.push("Decode speed is a low-confidence bandwidth estimate, not a measurement; prompt processing and kernel overhead are excluded.");
	return {
		model, quant, weightsBytes, kvBytes, runtimeBytes, totalBytes, contextTokens,
		placement: chosen.placement, gpuIndex: chosen.gpuIndex, verdict: chosen.verdict, reserveBytes: chosen.reserve,
		capacityBytes: chosen.capacity, availableBytes: chosen.available, estTokS,
		estimate: `weights ~${gb(weightsBytes, 1)} + KV ~${gb(kvBytes, 1)} + runtime ~${gb(runtimeBytes, 1)} @ ${contextTokens} ctx; ${gb(chosen.reserve, 1)} reserve`,
		confidence: "planning-estimate", limitations,
	};
}
export async function assessCatalog(opts: FitOptions = {}): Promise<{ profile: HardwareProfile; all: Array<{ model: CatalogModel; a: FitAssessment }> }> {
	const profile = await profileHardware();
	return { profile, all: CATALOG.map(model => ({ model, a: bestAssessment(profile, model, opts) })) };
}
/** Prefer fitting GPU/unified placement, then the smallest artifact with headroom. */
export function bestAssessment(profile: HardwareProfile, model: CatalogModel, opts: FitOptions = {}): FitAssessment {
	if (!model.quants.length) throw new Error(`No quantizations available for ${model.id}.`);
	return model.quants.map(q => assessFit(profile, model, q, opts)).sort((a, b) => {
		const order = { fits: 0, tight: 1, no: 2 };
		return order[a.verdict] - order[b.verdict] || Number(a.placement === "ram") - Number(b.placement === "ram") || a.totalBytes - b.totalBytes;
	})[0];
}
export function verdictMark(a: FitAssessment): string {
	return a.verdict === "fits" ? "✓ fits estimate" : a.verdict === "tight" ? "△ verify memory" : "✗ beyond estimate";
}
