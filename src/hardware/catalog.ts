/** Small, curated catalog of serving artifacts. Fit is not a quality benchmark.
 * Architecture comes from each publisher's config.json. Quant sizes are estimates
 * unless an artifact size is supplied. Checked against official registries 2026-09-06.
 */
export interface CatalogQuant {
	label: string;
	bytesPerWeight: number;
	/** An exact tag, when verified; do not assume an Ollama default uses this quant. */
	ollama?: string;
}
export interface CatalogModel {
	id: string;
	name: string;
	params: number;
	activeParams?: number;
	contextLength: number;
	quants: CatalogQuant[];
	ollama?: string;
	huggingFace?: string;
	/** f16 GQA cache geometry; full context on every layer is conservative for SWA. */
	kv?: { layers: number; heads: number; headDim: number };
	/** Verified tool-oriented default; legacy coding-only entries remain available. */
	toolUse?: boolean;
	focus?: "coding" | "general";
	note?: string;
}
const Q4 = { label: "Q4_K_M", bytesPerWeight: 0.58 };
const Q6 = { label: "Q6_K", bytesPerWeight: 0.82 };
const Q8 = { label: "Q8_0", bytesPerWeight: 1.06 };
function quants(tag: string, variants: CatalogQuant[] = [Q4, Q8]): CatalogQuant[] {
	// Only the default Q4 artifact is a recipe target; other quants need an explicit
	// file/tag selected by the user. Never pull a default while estimating Q8.
	return variants.map(q => ({ ...q, ...(q.label === "Q4_K_M" ? { ollama: tag } : {}) }));
}
export const CATALOG: CatalogModel[] = [
	{ id: "qwen2.5-coder-7b", name: "Qwen2.5-Coder 7B", params: 7_618_414_080, contextLength: 32768,
		quants: quants("qwen2.5-coder:7b"), ollama: "qwen2.5-coder:7b", huggingFace: "Qwen/Qwen2.5-Coder-7B-Instruct",
		kv: { layers: 28, heads: 4, headDim: 128 }, focus: "coding", note: "Legacy coding option; tool-call support depends on the serving template." },
	{ id: "qwen3-4b", name: "Qwen3 4B", params: 4_022_468_096, contextLength: 40960,
		quants: quants("qwen3:4b"), ollama: "qwen3:4b", huggingFace: "Qwen/Qwen3-4B",
		kv: { layers: 36, heads: 8, headDim: 128 }, toolUse: true, focus: "general", note: "Small tool-capable starting point; validate edits with project checks." },
	{ id: "qwen3-8b", name: "Qwen3 8B", params: 8_172_701_696, contextLength: 40960,
		quants: quants("qwen3:8b"), ollama: "qwen3:8b", huggingFace: "Qwen/Qwen3-8B",
		kv: { layers: 36, heads: 8, headDim: 128 }, toolUse: true, focus: "general", note: "General tool use at a modest memory footprint." },
	{ id: "qwen2.5-coder-14b", name: "Qwen2.5-Coder 14B", params: 14_777_107_968, contextLength: 32768,
		quants: quants("qwen2.5-coder:14b"), ollama: "qwen2.5-coder:14b", huggingFace: "Qwen/Qwen2.5-Coder-14B-Instruct",
		kv: { layers: 48, heads: 8, headDim: 128 }, focus: "coding", note: "Legacy coding option; tool-call support depends on the serving template." },
	{ id: "deepseek-v2-lite-16b", name: "DeepSeek Coder V2 Lite 16B", params: 16_310_918_144, activeParams: 2_400_000_000, contextLength: 131072,
		quants: quants("deepseek-coder-v2:16b", [Q4, Q6]), ollama: "deepseek-coder-v2:16b", huggingFace: "deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct",
		focus: "coding", note: "Legacy MLA model; KV fallback is conservative and runtime-dependent." },
	{ id: "qwen3-30b-a3b", name: "Qwen3 30B-A3B", params: 30_532_672_512, activeParams: 3_276_819_456, contextLength: 40960,
		quants: quants("qwen3:30b-a3b", [Q4]), ollama: "qwen3:30b-a3b", huggingFace: "Qwen/Qwen3-30B-A3B",
		kv: { layers: 48, heads: 4, headDim: 128 }, toolUse: true, focus: "general", note: "All 30B weights need memory even though only about 3B activate per token." },
	{ id: "qwen3-coder-30b-a3b", name: "Qwen3-Coder 30B-A3B", params: 30_532_672_512, activeParams: 3_276_819_456, contextLength: 262144,
		quants: quants("qwen3-coder:30b", [Q4]), ollama: "qwen3-coder:30b", huggingFace: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
		kv: { layers: 48, heads: 4, headDim: 128 }, toolUse: true, focus: "coding", note: "Agentic coding specialist; start with the assessed context instead of allocating the full 256k window." },
	{ id: "gpt-oss-20b", name: "GPT-OSS 20B", params: 21_263_125_504, activeParams: 3_558_896_128, contextLength: 131072,
		quants: [{ label: "MXFP4", bytesPerWeight: 0.65, ollama: "gpt-oss:20b" }], ollama: "gpt-oss:20b", huggingFace: "openai/gpt-oss-20b",
		kv: { layers: 24, heads: 8, headDim: 64 }, toolUse: true, focus: "general", note: "Native mixed-precision weights; requires Harmony-aware serving and tool parsing." },
	{ id: "qwen2.5-coder-32b", name: "Qwen2.5-Coder 32B", params: 32_768_210_432, contextLength: 32768,
		quants: quants("qwen2.5-coder:32b", [Q4, Q6, Q8]), ollama: "qwen2.5-coder:32b", huggingFace: "Qwen/Qwen2.5-Coder-32B-Instruct",
		kv: { layers: 64, heads: 8, headDim: 128 }, focus: "coding", note: "Larger dense legacy coder; memory capacity alone does not establish latency or tool support." },
	{ id: "mistral-small-24b", name: "Mistral Small 3.2 24B", params: 24_333_378_048, contextLength: 131072,
		quants: quants("mistral-small3.2:24b", [Q4, Q6]), ollama: "mistral-small3.2:24b", huggingFace: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
		kv: { layers: 40, heads: 8, headDim: 128 }, toolUse: true, focus: "general", note: "General text/tool model; this estimate excludes vision processing." },
	{ id: "gemma3-27b", name: "Gemma 3 27B", params: 27_396_375_040, contextLength: 131072,
		quants: quants("gemma3:27b", [Q4, Q6]), ollama: "gemma3:27b", huggingFace: "google/gemma-3-27b-it",
		focus: "general", note: "Text fit only; gated publisher download and vision overhead require separate checks." },
	{ id: "gpt-oss-120b", name: "GPT-OSS 120B", params: 117_172_437_504, activeParams: 5_104_399_616, contextLength: 131072,
		quants: [{ label: "MXFP4", bytesPerWeight: 0.56, ollama: "gpt-oss:120b" }], ollama: "gpt-oss:120b", huggingFace: "openai/gpt-oss-120b",
		kv: { layers: 36, heads: 8, headDim: 64 }, toolUse: true, focus: "general", note: "Large mixed-precision tool model; runtime, context and concurrency still need headroom." },
];

/** Match full family AND parameter size; a truncated family prefix is ambiguous. */
export function matchCatalog(modelId: string): CatalogModel | undefined {
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	const input = norm(modelId);
	const matches = CATALOG.filter(model => [model.id, model.ollama, model.huggingFace].filter(Boolean).some(alias => {
		const a = norm(alias!.split("/").pop()!);
		// Publisher namespace and quant suffix are allowed; digits immediately after
		// the size are not (7B must not match 70B or a different family release).
		const index = input.indexOf(a);
		if (index < 0) return false;
		const suffix = input.slice(index + a.length);
		return !suffix || /^(?:instruct|gguf|q\d|iq\d|fp\d|bf\d|mxfp|udq|uncensored|abliterated)/.test(suffix);
	}));
	return matches.length === 1 ? matches[0] : undefined;
}
