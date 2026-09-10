/** Deterministic starting recipes, not an auto-installer or a benchmark runner. */
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CATALOG, type CatalogModel } from "./catalog.ts";
import { assessFit, bestAssessment, planContext, type FitAssessment } from "./fit.ts";
import type { HardwareProfile } from "./profile.ts";

export type WorkFocus = "everyday" | "coding" | "ops" | "research" | "creative";
export interface ModelRecommendation { model: CatalogModel; assessment: FitAssessment; reason: string }
export interface ServingRecipe {
	engine: "ollama" | "lmstudio" | "llama.cpp" | "vllm";
	title: string;
	model: CatalogModel;
	assessment: FitAssessment;
	baseUrl: string;
	prerequisites: string[];
	commands: string[];
	checks: string[];
	notes: string[];
	sources: string[];
}
export interface ServingPlan {
	scope: "current-machine";
	focus: WorkFocus;
	contextTokens: number;
	recommendations: ModelRecommendation[];
	best?: ModelRecommendation;
	recipes: ServingRecipe[];
	notes: string[];
}
export interface ServingOptions { focus?: WorkFocus; contextTokens?: number }

const CODING_ORDER = ["qwen3-coder-30b-a3b", "gpt-oss-20b", "qwen3-8b", "qwen3-4b", "qwen3-30b-a3b", "gpt-oss-120b", "mistral-small-24b"];
const GENERAL_ORDER = ["gpt-oss-120b", "gpt-oss-20b", "qwen3-30b-a3b", "qwen3-8b", "qwen3-4b", "mistral-small-24b", "qwen3-coder-30b-a3b"];
function preference(id: string, focus: WorkFocus): number {
	const i = (focus === "coding" ? CODING_ORDER : GENERAL_ORDER).indexOf(id);
	return i < 0 ? 100 : i;
}
function rank(a: ModelRecommendation, b: ModelRecommendation, focus: WorkFocus): number {
	// A fully resident small model is a better interactive starting point than a
	// larger model spilling to CPU. CPU-only machines start with small tool models.
	const va = { fits: 0, tight: 1, no: 2 };
	return va[a.assessment.verdict] - va[b.assessment.verdict]
		|| Number(a.assessment.placement === "ram") - Number(b.assessment.placement === "ram")
		|| Number(!a.model.toolUse) - Number(!b.model.toolUse)
		|| (a.assessment.placement === "ram" && b.assessment.placement === "ram"
			? a.assessment.totalBytes - b.assessment.totalBytes : preference(a.model.id, focus) - preference(b.model.id, focus))
		|| a.assessment.totalBytes - b.assessment.totalBytes;
}
function reason(model: CatalogModel, assessment: FitAssessment, focus: WorkFocus): string {
	const task = focus === "coding" && model.focus === "coding" && model.toolUse ? "Tool-capable coding specialist" : model.toolUse ? "Tool-capable general assistant" : "Legacy option; verify tool support";
	const residency = assessment.placement === "ram" ? "CPU/RAM starting point; latency needs a real trial" : `${assessment.placement === "gpu" ? "one GPU" : "one shared memory pool"} with planned headroom`;
	return `${task}; ${residency}. Selected by task fit and memory, not by benchmark rank.`;
}
function commandEnv(values: Record<string, string>, command: string, windows: boolean): string[] {
	return windows ? [...Object.entries(values).map(([k, v]) => `$env:${k}='${v}'`), command]
		: [`${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(" ")} ${command}`];
}
function recipeBase(model: CatalogModel, assessment: FitAssessment, baseUrl: string) {
	return { model, assessment, baseUrl, checks: [`curl --fail ${baseUrl}/models`, "rein setup", "rein doctor"],
		notes: ["Run the server in one terminal, then use another terminal for Rein setup. Reuse an existing server instead of starting a second copy.",
			"The model ID must be returned by /v1/models. Test a short chat and a tool call before enabling autonomous jobs.",
			"Loopback serves this machine. For another machine, bind to its chosen LAN/mesh interface with access controls, or use an SSH tunnel; use that route in Rein setup."] };
}

export function servingRecommendations(profile: HardwareProfile, opts: ServingOptions = {}): ServingPlan {
	const focus = opts.focus ?? "coding";
	const largestPool = Math.max(profile.ram.totalBytes, ...profile.gpus.map(g => g.vramTotalBytes ?? 0));
	const contextTokens = planContext(opts.contextTokens ?? (largestPool <= 12 * 1024 ** 3 ? 8192 : 16384), 262144);
	const recommendations = CATALOG.map(model => {
		const assessment = bestAssessment(profile, model, { contextTokens });
		return { model, assessment, reason: reason(model, assessment, focus) };
	}).sort((a, b) => rank(a, b, focus));
	// Tight fits remain visible for troubleshooting, but are never advertised as
	// ready to serve, and no recipe is created when memory is already occupied.
	const best = recommendations.find(r => r.assessment.verdict === "fits" && r.model.toolUse);
	const notes = [
		"This profile describes the machine running Rein. A remote API, SSH tunnel, container gateway or cloud model does not reveal the serving host's hardware. Run rein hardware on that host too.",
		"Recipes are suggestions. No models are downloaded, no services are started, and no existing server configuration is changed.",
		"Memory fit does not establish model quality, tool-call correctness, installed weights, disk space, or engine/driver support. Confirm all of these before serving.",
	];
	if (!best) notes.push("No tool-capable catalog model has measured memory headroom at this context. Close unused model loads, lower context, or use a discovered remote/cloud server.");
	if (profile.gpus.length > 1) notes.push("VRAM is not added across cards. A multi-GPU recipe needs compatible devices, partitioning and runtime tests.");
	const recipes: ServingRecipe[] = [];
	const darwin = profile.os.startsWith("darwin"), linux = profile.os.startsWith("linux"), windows = profile.os.startsWith("win32");
	if (best) {
		const { model, assessment } = best;
		if (model.ollama && assessment.quant.ollama && (darwin || linux || windows)) {
			recipes.push({ ...recipeBase(model, assessment, "http://127.0.0.1:11434/v1"), engine: "ollama", title: "Ollama — managed local model server",
				prerequisites: ["Install or update Ollama from https://ollama.com/download for this OS/architecture; confirm the GPU is supported.",
					`Download the ${assessment.quant.label} artifact and check available disk space. Inspect ollama show before relying on a mutable tag.`,
					"If Ollama is already running as an app/service, apply these environment values to that service and restart it deliberately; do not run a duplicate server."],
				commands: [...commandEnv({ OLLAMA_HOST: "127.0.0.1:11434", OLLAMA_CONTEXT_LENGTH: String(assessment.contextTokens), OLLAMA_NUM_PARALLEL: "1" }, "ollama serve", windows), `ollama pull ${assessment.quant.ollama}`],
				checks: ["ollama --version", `ollama show ${assessment.quant.ollama}`, "ollama ps", ...recipeBase(model, assessment, "http://127.0.0.1:11434/v1").checks],
				sources: ["https://docs.ollama.com/faq", "https://docs.ollama.com/api/openai-compatibility", `https://ollama.com/library/${model.ollama}`],
			});
		}
		// LM Studio's native Mac build requires Apple Silicon; Linux ARM64 and
		// unknown x86 instruction sets get the portable-server path instead.
		const lmSupported = (darwin && profile.arch === "arm64")
			|| ((linux || windows) && profile.arch === "x64" && profile.cpu.features.includes("avx2"));
		if (lmSupported) {
			const base = recipeBase(model, assessment, "http://127.0.0.1:1234/v1");
			recipes.push({ ...base, engine: "lmstudio", title: "LM Studio — guided download and native server",
				prerequisites: ["Install the supported native LM Studio app and enable the lms CLI. Use its supported GPU runtime.",
					`Search for ${model.name}; download the assessed ${assessment.quant.label} GGUF artifact. Select its actual model key from lms ls.`,
					"The placeholder MODEL_KEY_FROM_LMS_LS below must be replaced with the downloaded key. Weights and runtime are not assumed installed."],
				commands: ["lms ls", `lms load MODEL_KEY_FROM_LMS_LS --estimate-only --context-length ${assessment.contextTokens}`, `lms load MODEL_KEY_FROM_LMS_LS --context-length ${assessment.contextTokens} --identifier rein-local`, "lms server start --port 1234 --bind 127.0.0.1"],
				checks: ["lms server status", "lms ps", ...base.checks],
				sources: ["https://lmstudio.ai/docs/app/system-requirements", "https://lmstudio.ai/docs/cli/local-models/load", "https://lmstudio.ai/docs/cli/serve/server-start"],
			});
		}
		const base = recipeBase(model, assessment, "http://127.0.0.1:8080/v1");
		recipes.push({ ...base, engine: "llama.cpp", title: "llama.cpp — explicit portable GGUF server",
			prerequisites: ["Install/build llama-server with the backend for this machine: Metal on Apple Silicon, CUDA for supported NVIDIA, Vulkan/HIP for supported AMD, or CPU.",
				`Download a compatible ${model.name} ${assessment.quant.label} GGUF with its chat/tool template. Replace MODEL_FILE.gguf with its path; no artifact is auto-selected or downloaded.`,
				...(assessment.placement === "gpu" ? [`Use llama-server --list-devices to find ${profile.gpus[assessment.gpuIndex ?? 0]?.name ?? "the assessed GPU"}; replace DEVICE_FROM_LLAMA_LIST with its backend device ID. System inventory ordinals may differ.`] : []),
				"Verify the server build supports this architecture, quantization and tool parser before running. The example uses one sequence."],
			commands: [`llama-server --model MODEL_FILE.gguf --ctx-size ${assessment.contextTokens} --parallel 1 --n-gpu-layers ${assessment.placement === "ram" ? 0 : 999}${assessment.placement === "gpu" ? " --device DEVICE_FROM_LLAMA_LIST --split-mode none --main-gpu 0" : ""} --jinja --host 127.0.0.1 --port 8080`],
			checks: ["llama-server --version", "llama-server --list-devices", ...base.checks],
			sources: ["https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md", "https://github.com/ggml-org/llama.cpp/tree/master/tools/server"],
		});
	}
	// vLLM's standard publisher weights are FP16/BF16, NOT the Q4 GGUF used above.
	// Re-assess that exact precision on a single supported CUDA device. Do not
	// infer multi-GPU capability from the sum of unrelated VRAM pools.
	const cuda = profile.gpus.map((gpu, index) => ({ gpu, index })).filter(({ gpu }) => gpu.vendor === "nvidia" && (gpu.computeCapability ?? 0) >= 7.5);
	if (linux && cuda.length) {
		const vllmPicks = CATALOG.filter(m => m.huggingFace?.startsWith("Qwen/Qwen3") && m.toolUse).flatMap(model => cuda.map(({ gpu, index }) => {
			const assessment = assessFit({ ...profile, gpus: [gpu], unifiedMemory: Boolean(gpu.sharedMemory) }, model, { label: (gpu.computeCapability ?? 0) >= 8 ? "BF16" : "FP16", bytesPerWeight: 2 }, { contextTokens });
			assessment.gpuIndex = index;
			return { model, assessment, reason: reason(model, assessment, focus) };
		})).filter(r => r.assessment.verdict === "fits" && r.assessment.placement !== "ram"
			&& r.assessment.totalBytes <= r.assessment.capacityBytes * 0.8
			// vLLM checks its full allocation budget at startup, even if this
			// particular model's planned footprint is smaller than that budget.
			&& r.assessment.availableBytes >= r.assessment.capacityBytes * 0.8).sort((a, b) => rank(a, b, focus));
		const pick = vllmPicks[0];
		if (pick) {
			const base = recipeBase(pick.model, pick.assessment, "http://127.0.0.1:8000/v1");
			const parser = pick.model.id === "qwen3-coder-30b-a3b" ? "qwen3_xml" : "hermes";
			recipes.push({ ...base, engine: "vllm", title: `vLLM — single CUDA GPU, publisher ${pick.assessment.quant.label} weights`,
				prerequisites: ["Linux, a supported Python version, NVIDIA driver/CUDA and vLLM build for this GPU and CPU architecture. Check upstream requirements; a detected GPU is not a validated build.",
					`Obtain ${pick.model.huggingFace} weights and check disk space. This recipe needs ${pick.assessment.quant.label} memory, independently assessed from GGUF/Q4.`,
					...(profile.gpus[pick.assessment.gpuIndex ?? 0]?.uuid ? [] : ["The GPU UUID was not reported; replace CUDA_DEVICE_ID_FROM_NVIDIA_SMI with the assessed GPU UUID from nvidia-smi -L. Do not assume its ordinal matches CUDA ordering."]),
					"Use one GPU and one sequence first. Only add tensor parallelism after validating compatible devices and the runtime."],
				commands: [`CUDA_VISIBLE_DEVICES=${profile.gpus[pick.assessment.gpuIndex ?? 0]?.uuid ?? "CUDA_DEVICE_ID_FROM_NVIDIA_SMI"} vllm serve ${pick.model.huggingFace} --dtype ${pick.assessment.quant.label === "BF16" ? "bfloat16" : "float16"} --host 127.0.0.1 --port 8000 --max-model-len ${pick.assessment.contextTokens} --max-num-seqs 1 --gpu-memory-utilization 0.8 --enforce-eager --enable-auto-tool-choice --tool-call-parser ${parser}`],
				checks: ["nvidia-smi", "vllm --version", ...base.checks],
				sources: ["https://docs.vllm.ai/en/stable/getting_started/installation/gpu/", "https://docs.vllm.ai/en/stable/features/tool_calling/", `https://huggingface.co/${pick.model.huggingFace}`],
			});
		} else notes.push("No single supported CUDA device fits the checked publisher FP16/BF16 vLLM recipes. A fitting GGUF does not imply these weights fit.");
	} else if (linux && profile.gpus.some(g => g.vendor === "nvidia")) {
		notes.push("CUDA compute capability was unavailable or below the current vLLM minimum; no unverified vLLM launch recipe was generated.");
	}
	return { scope: "current-machine", focus, contextTokens, recommendations, best, recipes, notes };
}

/** PATH and executable-name evidence only; never reads process arguments or starts servers. */
export async function probeServingTools(): Promise<Record<ServingRecipe["engine"], { onPath: boolean; running?: boolean }>> {
	const names = { ollama: "ollama", lmstudio: "lms", "llama.cpp": "llama-server", vllm: "vllm" };
	let processes: string[] = [];
	if (process.platform !== "win32") {
		try { processes = (await promisify(execFile)("ps", ["-e", "-o", "comm="], { timeout: 1200, maxBuffer: 1024 * 1024 })).stdout.split(/\r?\n/).map(value => value.trim().split("/").pop() ?? ""); } catch { /* Process visibility is optional. */ }
	}
	return Object.fromEntries(await Promise.all(Object.entries(names).map(async ([engine, binary]) => {
		const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
		const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
		const candidates = await Promise.all(paths.flatMap(dir => suffixes.map(async ext => {
			try { await access(join(dir, binary + ext), constants.X_OK); return true; } catch { return false; }
		})));
		return [engine, { onPath: candidates.some(Boolean), running: processes.some(name => name === binary || engine === "vllm" && name.startsWith("VLLM::")) }];
	}))) as Record<ServingRecipe["engine"], { onPath: boolean; running?: boolean }>;
}
