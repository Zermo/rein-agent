/** Exact download size plus catalog-based memory planning, never a benchmark. */
import { matchCatalog } from "../hardware/catalog.ts";
import { assessFit, type FitAssessment } from "../hardware/fit.ts";
import type { HardwareProfile } from "../hardware/profile.ts";
import type { ModelArtifact } from "./artifacts.ts";

export interface ArtifactPlan {
	artifact: ModelArtifact;
	scope: "current-machine";
	contextTokens: number;
	memory: FitAssessment | null;
	notes: string[];
}
export function planModelArtifact(artifact: ModelArtifact, profile: HardwareProfile, context = 4096): ArtifactPlan {
	if (!Number.isSafeInteger(context) || context < 256 || context > 131072) throw new Error("--context must be an integer from 256 to 131072.");
	if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) throw new Error("Artifact size must be a positive integer.");
	const model = matchCatalog(artifact.repo) ?? matchCatalog(artifact.file);
	const memory = model ? assessFit(profile, model, { label: "selected GGUF", bytesPerWeight: artifact.sizeBytes / (model.params * 1.05) }, { contextTokens: context }) : null;
	return {
		artifact, scope: "current-machine", contextTokens: memory?.contextTokens ?? context, memory,
		notes: [
			"Planning only. No model is downloaded, runtime started or connection changed.",
			"The download uses the exact pinned artifact size. Memory estimates also reserve KV cache, runtime overhead and OS headroom.",
			...(memory ? ["Architecture is matched to the curated catalog by name. Modified model geometry can differ; validate it in the actual runtime."] : ["This artifact has no known catalog geometry. Its weights size alone cannot establish a memory fit; runtime validation is required."]),
			"A memory fit does not establish model quality, tool support or serving speed. The serving command performs a separate preflight.",
			"This phase manages single-file GGUF models with llama.cpp. Existing Ollama, LM Studio and other servers remain available through rein setup.",
		],
	};
}

export function formatArtifactPlan(plan: ArtifactPlan): string {
	const a = plan.artifact, gib = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GiB`;
	return [
		`Model: ${a.repo} / ${a.file}`, `Revision: ${a.revision}`, `Artifact ID: ${a.id}`,
		`Download: ${gib(a.sizeBytes)} (${a.sizeBytes} bytes)`, `SHA256: ${a.sha256}`,
		`Context: ${plan.contextTokens} tokens`,
		plan.memory ? `Memory: ${plan.memory.verdict} estimate in ${plan.memory.placement}; ${gib(plan.memory.totalBytes)} + ${gib(plan.memory.reserveBytes)} reserve` : "Memory: unverified; model architecture is not in the catalog",
		...plan.notes,
		`Install: rein model install ${a.repo} --revision ${a.revision} --file '${a.file.replace(/'/g, "'\\''")}'`,
	].join("\n");
}
