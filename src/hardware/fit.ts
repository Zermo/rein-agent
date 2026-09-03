/**
 * Fit assessment — will this model run on this machine, and roughly how fast?
 *
 * Stolen concepts from Magnitude's icn-hardware (Apache-2.0):
 *  - per-domain reserves before a model may claim memory
 *    (CapacityPolicy.reserve_bytes_per_domain, system_memory_thresholds)
 *  - a model "Fits" only with a headroom breakdown, not a boolean
 *
 * rein's version is pure arithmetic (no native planner):
 *   footprint = weights(params × bytesPerWeight) + KV estimate
 *   verdict   = footprint vs the memory pool(s), after reserves
 *   speed     = bandwidth / bytes-per-token (MoE: active params only)
 */
import { CATALOG, type CatalogModel, type CatalogQuant } from "./catalog.ts";
import { gb, profileHardware, type HardwareProfile } from "./profile.ts";

const GiB = 1024 ** 3;
/** Context we plan against (agent sessions, not 128k novels). */
const PLAN_CONTEXT = 16_384;
/** KV cache bytes per parameter at PLAN_CONTEXT, f16-ish entries. Rough. */
const KV_PER_PARAM = 0.045;
/** Bandwidth utilization for the tok/s estimate (memory-bound decoding). */
const EFFICIENCY = 0.55;

export interface FitAssessment {
	model: CatalogModel;
	quant: CatalogQuant;
	weightsBytes: number;
	kvBytes: number;
	totalBytes: number;
	/** Where it would live. */
	placement: "gpu" | "unified" | "ram";
	verdict: "fits" | "tight" | "no";
	estTokS?: number;
	estimate: string;
}

/**
 * Magnitude-style reserves: a model must leave room for the OS, the
 * runtime, and KV growth. max(pool/10, 2 GiB) for assessment.
 */
function reserveFor(poolBytes: number): number {
	return Math.max(poolBytes / 10, 2 * GiB);
}

export function assessFit(profile: HardwareProfile, model: CatalogModel, quant: CatalogQuant): FitAssessment {
	const active = model.activeParams ?? model.params;
	const weightsBytes = model.params * quant.bytesPerWeight * 1.05; // +5% embeddings/layers overhead
	// KV scales with layers, not total params — using total params over-counts MoE by
	// 3-5× (conservative: costs headroom, flips fits→tight). Deliberate.
	const kvBytes = model.params * KV_PER_PARAM * (PLAN_CONTEXT / 4096);
	const totalBytes = weightsBytes + kvBytes;

	const pools: Array<{ name: "gpu" | "unified" | "ram"; capacity: number; available: number }> = [];
	if (profile.unifiedMemory) {
		pools.push({ name: "unified", capacity: profile.ram.totalBytes, available: Math.min(profile.ram.availableBytes, profile.ram.totalBytes) });
	} else {
		for (const g of profile.gpus) {
			if (g.vramTotalBytes) pools.push({ name: "gpu", capacity: g.vramTotalBytes, available: Math.min(g.vramFreeBytes ?? g.vramTotalBytes, g.vramTotalBytes) });
		}
		pools.push({ name: "ram", capacity: profile.ram.totalBytes, available: Math.min(profile.ram.availableBytes, profile.ram.totalBytes) });
	}

	let verdict: FitAssessment["verdict"] = "no";
	let placement: FitAssessment["placement"] = "ram";
	let usedReserve = 0; // the reserve of the pool that decided the verdict (for the estimate line)
	for (const pool of pools) {
		const reserve = reserveFor(pool.capacity);
		if (totalBytes + reserve <= pool.available) {
			verdict = "fits"; // a later pool that fits overrides an earlier "tight" (e.g. VRAM tight, RAM fine)
			placement = pool.name;
			usedReserve = reserve;
			if (pool.name === "gpu" || pool.name === "unified") break; // GPU-resident wins; stop looking
		} else if (verdict === "no" && totalBytes + reserve <= pool.capacity * 0.95) {
			verdict = "tight"; // fits only if you close other memory hogs
			placement = pool.name;
			usedReserve = reserve;
		}
	}

	const estTokS =
		profile.memBandwidthGBs && verdict !== "no"
			? Math.round(((profile.memBandwidthGBs * 1e9) / (active * quant.bytesPerWeight)) * EFFICIENCY)
			: undefined;

	const estimate = `weights ${gb(totalBytes - kvBytes)} + KV ~${gb(kvBytes)} @ ${PLAN_CONTEXT / 1024}k ctx, after ${gb(usedReserve || reserveFor(8 * GiB))} reserve`;

	return {
		model,
		quant,
		weightsBytes,
		kvBytes,
		totalBytes,
		placement,
		verdict,
		estTokS,
		estimate,
	};
}

/** Profile the machine and assess every catalog model against it (shared by
 * `rein hardware` and the `rein models` section). */
export async function assessCatalog(): Promise<{
	profile: HardwareProfile;
	all: Array<{ model: CatalogModel; a: FitAssessment }>;
}> {
	const profile = await profileHardware();
	return { profile, all: CATALOG.map((m) => ({ model: m, a: bestAssessment(profile, m) })) };
}

/** Rank a model's quants best-first for this machine (smallest that fits). */
export function bestAssessment(profile: HardwareProfile, model: CatalogModel): FitAssessment {
	const ranked = model.quants
		.map((q) => assessFit(profile, model, q))
		.sort((a, b) => {
			const order = { fits: 0, tight: 1, no: 2 } as const;
			if (order[a.verdict] !== order[b.verdict]) return order[a.verdict] - order[b.verdict];
			return a.totalBytes - b.totalBytes;
		});
	return ranked[0];
}

export function verdictMark(a: FitAssessment): string {
	if (a.verdict === "fits") return a.estTokS ? `✓ ~${a.estTokS} tok/s` : "✓ fits";
	if (a.verdict === "tight") return "△ tight";
	return "✗ won't fit";
}
