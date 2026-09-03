/**
 * Curated local-model catalog for agent workloads.
 *
 * Structure stolen from Magnitude's inference catalog (models.json,
 * Apache-2.0): parameterization incl. MoE activeParameters, quant
 * variants, contextLength. rein's entries
 * are the models you can actually `ollama pull` for an agent harness,
 * with an approximate bytes-per-weight for each quant so the fit
 * assessor can reason about them.
 *
 * bytesPerWeight is GGUF-class averages:
 *   Q4_K_M ≈ 0.55–0.60, Q5_K_M ≈ 0.70, Q6_K ≈ 0.82, Q8_0 ≈ 1.06, BF16 ≈ 2.0
 */
export interface CatalogQuant {
	label: string;
	bytesPerWeight: number;
}

export interface CatalogModel {
	id: string;
	name: string;
	/** Total parameters. */
	params: number;
	/** MoE: parameters active per token (drives speed, not footprint). */
	activeParams?: number;
	contextLength: number;
	quants: CatalogQuant[];
	/** How to get it: `ollama pull <tag>` / LM Studio search term. */
	ollama?: string;
	note?: string;
}

const QUANTS = {
	q4: { label: "Q4_K_M", bytesPerWeight: 0.58 },
	q6: { label: "Q6_K", bytesPerWeight: 0.82 },
	q8: { label: "Q8_0", bytesPerWeight: 1.06 },
} as const;

export const CATALOG: CatalogModel[] = [
	{
		id: "qwen2.5-coder-7b",
		name: "Qwen2.5-Coder 7B",
		params: 7_618_414_080,
		contextLength: 32_768,
		quants: [QUANTS.q4, QUANTS.q8],
		ollama: "qwen2.5-coder:7b",
		note: "The default local coder. Fast on anything with 8 GB.",
	},
	{
		id: "qwen3-8b",
		name: "Qwen3 8B",
		params: 8_172_701_696,
		contextLength: 40_960,
		quants: [QUANTS.q4, QUANTS.q8],
		ollama: "qwen3:8b",
		note: "Thinking-mode toggle; strong general tool use.",
	},
	{
		id: "qwen2.5-coder-14b",
		name: "Qwen2.5-Coder 14B",
		params: 14_777_107_968,
		contextLength: 32_768,
		quants: [QUANTS.q4, QUANTS.q8],
		ollama: "qwen2.5-coder:14b",
		note: "The 16–24 GB sweet spot for coding agents.",
	},
	{
		id: "deepseek-v2-lite-16b",
		name: "DeepSeek Coder V2 Lite 16B",
		params: 16_310_918_144,
		contextLength: 131_072,
		quants: [QUANTS.q4, QUANTS.q6],
		activeParams: 2_400_000_000,
		ollama: "deepseek-coder-v2:16b",
		note: "128k context; MoE (16.3B total, ~2.4B active) — fast for its size.",
	},
	{
		id: "qwen3-30b-a3b",
		name: "Qwen3 30B-A3B (MoE)",
		params: 30_532_672_512,
		activeParams: 3_276_819_456,
		contextLength: 40_960,
		quants: [QUANTS.q4],
		ollama: "qwen3:30b-a3b",
		note: "30B brain, 3B per token — near-14B speed if you have 20 GB.",
	},
	{
		id: "gpt-oss-20b",
		name: "GPT-OSS 20B (MoE)",
		params: 21_263_125_504,
		activeParams: 3_558_896_128,
		contextLength: 131_072,
		quants: [QUANTS.q4, { label: "MXFP4", bytesPerWeight: 0.52 }],
		ollama: "gpt-oss:20b",
		note: "Open-weight 20B; 128k context, very fast (3.6B active).",
	},
	{
		id: "qwen2.5-coder-32b",
		name: "Qwen2.5-Coder 32B",
		params: 32_768_210_432,
		contextLength: 32_768,
		quants: [QUANTS.q4, QUANTS.q6, QUANTS.q8],
		ollama: "qwen2.5-coder:32b",
		note: "The 32–48 GB workhorse; best dense coder in class.",
	},
	{
		id: "mistral-small-24b",
		name: "Mistral Small 3.2 24B",
		params: 24_333_378_048,
		contextLength: 131_072,
		quants: [QUANTS.q4, QUANTS.q6],
		ollama: "mistral-small3.2:24b",
		note: "128k context; solid generalist tool caller.",
	},
	{
		id: "gemma3-27b",
		name: "Gemma 3 27B",
		params: 27_396_375_040,
		contextLength: 131_072,
		quants: [QUANTS.q4, QUANTS.q6],
		ollama: "gemma3:27b",
		note: "128k context, vision-capable in some builds.",
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B (MoE)",
		params: 117_172_437_504,
		activeParams: 5_104_399_616,
		contextLength: 131_072,
		quants: [QUANTS.q4, { label: "MXFP4", bytesPerWeight: 0.52 }],
		ollama: "gpt-oss:120b",
		note: "Frontier-class in a 60–70 GB footprint; 5B active per token.",
	},
];

/** Match a running server's model id (e.g. "qwen2.5-coder:7b") to a catalog entry. */
export function matchCatalog(modelId: string): CatalogModel | undefined {
	const id = modelId.toLowerCase();
	for (const m of CATALOG) {
		if (m.ollama && id === m.ollama.toLowerCase()) return m;
	}
	// Fuzzy: "qwen2.5-coder:7b-instruct" ~ "qwen2.5-coder-7b"
	const norm = (s: string) => s.toLowerCase().replace(/[:.-]/g, "");
	for (const m of CATALOG) {
		if (m.ollama && norm(m.ollama).startsWith(norm(id).slice(0, 8))) return m;
	}
	return undefined;
}
