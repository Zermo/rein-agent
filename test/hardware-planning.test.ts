import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG, matchCatalog } from "../src/hardware/catalog.ts";
import { assessFit, bestAssessment } from "../src/hardware/fit.ts";
import { appleBandwidth, parseDarwinGpus, parseNvidiaSmi, parseVram, limitContainerMemory, type HardwareProfile } from "../src/hardware/profile.ts";
import { servingRecommendations } from "../src/hardware/recipes.ts";
import { hardwareReportLines } from "../src/hardware/report.ts";

const GiB = 2 ** 30;
const model = (id: string) => CATALOG.find(m => m.id === id)!;
const cpu: HardwareProfile["cpu"] = { name: "Synthetic CPU", cores: 8, physicalCores: 4, features: ["avx2"] };
function machine(ram = 32, available = ram - 2): HardwareProfile {
	return { os: "linux", arch: "x64", cpu, ram: { totalBytes: ram * GiB, availableBytes: available * GiB }, gpus: [], unifiedMemory: false };
}
function gpu(total: number, free = total - 1): HardwareProfile["gpus"][number] {
	return { name: "NVIDIA test device", vendor: "nvidia", computeCapability: 8.6, vramTotalBytes: total * GiB, vramFreeBytes: free * GiB };
}

test("catalog matching keeps sizes, model families and cloud suffixes separate", () => {
	assert.equal(matchCatalog("qwen2.5-coder:7b-instruct")?.id, "qwen2.5-coder-7b");
	assert.equal(matchCatalog("qwen2.5-coder:32b")?.id, "qwen2.5-coder-32b");
	assert.equal(matchCatalog("publisher/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf")?.id, "qwen3-coder-30b-a3b");
	assert.equal(matchCatalog("qwen3:8b")?.id, "qwen3-8b");
	for (const id of ["qwen2.5-coder", "qwen2.5-coder:70b", "qwen3:80b", "qwen3-coder-next", "gpt-oss:20b-cloud", "qwen"]) assert.equal(matchCatalog(id), undefined, id);
});
test("Mac discrete VRAM units and multiple nested adapters are parsed independently", () => {
	assert.equal(parseVram("8 GB"), 8 * GiB);
	assert.equal(parseVram("1536 MB"), 1.5 * GiB);
	assert.equal(parseVram("N/A"), undefined);
	const gpus = parseDarwinGpus({ SPDisplaysDataType: [{ _items: [{ sppci_model: "Intel integrated", spdisplays_vram: "1536 MB" }, { sppci_model: "AMD Radeon", spdisplays_vram: "8 GB" }] }] }, false);
	assert.equal(gpus.length, 2);
	assert.equal(gpus[1].vramTotalBytes, 8 * GiB);
	assert.equal(gpus.some(g => g.sharedMemory), false);
	assert.equal(parseDarwinGpus({ SPDisplaysDataType: [{ sppci_model: "Apple M4" }] }, true)[0].sharedMemory, true);
});
test("Apple Ultra and Max bins do not silently match base-chip bandwidth", () => {
	assert.equal(appleBandwidth("Apple M1 Ultra", 20).gbs, 800);
	assert.equal(appleBandwidth("Apple M3 Max", 14).gbs, 300);
	assert.equal(appleBandwidth("Apple M3 Max", 16).gbs, 400);
	assert.equal(appleBandwidth("Apple M3 Max").gbs, undefined);
	assert.equal(appleBandwidth("Apple M9 Ultra", 80).gbs, undefined);
	assert.equal(appleBandwidth("Intel Core i7", 8).gbs, undefined);
	assert.match(appleBandwidth("Apple M5 Max", 18).note!, /variant unverified/);
});
test("NVIDIA unknown free memory is not invented, and malformed CSV is ignored", () => {
	const parsed = parseNvidiaSmi("NVIDIA fixture, 24576, N/A, 8.6\nNVIDIA other, 8192, 12288, 7.5\nname, with comma, 24, 12, 9.0");
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0].vramTotalBytes, 24 * GiB);
	assert.equal(parsed[0].vramFreeBytes, undefined);
	assert.equal(parsed[1].vramFreeBytes, 8 * GiB);
	assert.equal(parsed[1].computeCapability, 7.5);
	const shared = parseNvidiaSmi("NVIDIA GB10, N/A, N/A, 12.1")[0];
	assert.equal(shared.sharedMemory, true);
	assert.equal(shared.vramTotalBytes, undefined);
});
test("container RAM uses its ceiling and current usage without counting swap", () => {
	assert.deepEqual(limitContainerMemory(64 * GiB, 50 * GiB, String(8 * GiB), String(3 * GiB)), { totalBytes: 8 * GiB, availableBytes: 5 * GiB });
	assert.deepEqual(limitContainerMemory(64 * GiB, 50 * GiB, "max", "1"), { totalBytes: 64 * GiB, availableBytes: 50 * GiB });
	assert.equal(limitContainerMemory(64 * GiB, 50 * GiB, String(8 * GiB)).availableBytes, 0);
});
test("GQA KV scales with context and architecture instead of total MoE parameters", () => {
	const coder = model("qwen3-coder-30b-a3b");
	const small = assessFit(machine(64), coder, coder.quants[0], { contextTokens: 8192 });
	const large = assessFit(machine(64), coder, coder.quants[0], { contextTokens: 32768 });
	assert.equal(small.kvBytes, 0.75 * GiB);
	assert.equal(large.kvBytes, 4 * small.kvBytes);
	assert.equal(large.weightsBytes, small.weightsBytes);
	assert.ok(small.runtimeBytes >= 0.5 * GiB);
	assert.equal(assessFit(machine(64), coder, coder.quants[0], { contextTokens: 999999 }).contextTokens, 262144);
	assert.throws(() => assessFit(machine(), coder, coder.quants[0], { contextTokens: NaN }), /positive finite/);
});
test("heterogeneous GPUs are assessed separately, not summed and not first-device-only", () => {
	const coder = model("qwen3-coder-30b-a3b");
	const p = { ...machine(8), gpus: [gpu(8), gpu(24)] };
	const result = bestAssessment(p, coder);
	assert.equal(result.placement, "gpu");
	assert.equal(result.gpuIndex, 1);
	assert.equal(result.verdict, "fits");
	const split = bestAssessment({ ...machine(8), gpus: [gpu(12), gpu(12)] }, coder);
	assert.equal(split.verdict, "no");
	assert.match(split.limitations.join(" "), /separately/);
});
test("unknown GPU free space requires verification; fitting RAM can still be used", () => {
	const unknown = { ...gpu(24), vramFreeBytes: undefined };
	const a = bestAssessment({ ...machine(8), gpus: [unknown] }, model("qwen3-coder-30b-a3b"));
	assert.equal(a.verdict, "tight");
	assert.match(a.limitations.join(" "), /unknown/);
	const b = bestAssessment({ ...machine(32), gpus: [unknown] }, model("qwen3-coder-30b-a3b"));
	assert.equal(b.verdict, "fits");
	assert.equal(b.placement, "ram");
});
test("physical UMA memory is counted once, including NVIDIA shared devices", () => {
	const shared = { ...machine(16), unifiedMemory: true, gpus: [{ name: "NVIDIA shared fixture", vendor: "nvidia" as const, sharedMemory: true, vramTotalBytes: 16 * GiB }] };
	const a = bestAssessment(shared, model("qwen3-coder-30b-a3b"));
	assert.equal(a.verdict, "no");
	assert.equal(a.capacityBytes, 16 * GiB);
	const fitted = bestAssessment({ ...shared, ram: machine(32).ram }, model("qwen3-coder-30b-a3b"));
	assert.equal(fitted.placement, "unified");
	assert.equal(fitted.verdict, "fits");
});
test("bandwidth does not fabricate MoE, CPU, or discrete GPU speed", () => {
	const p = { ...machine(64), memBandwidthGBs: 400 };
	assert.equal(bestAssessment(p, model("qwen3-8b")).estTokS, undefined);
	assert.equal(bestAssessment({ ...p, gpus: [gpu(24)] }, model("qwen3-8b")).estTokS, undefined);
	assert.equal(bestAssessment({ ...p, os: "darwin", unifiedMemory: true }, model("qwen3-coder-30b-a3b")).estTokS, undefined);
	const apple = bestAssessment({ ...p, os: "darwin", unifiedMemory: true }, model("qwen3-8b"));
	assert.ok(apple.estTokS);
	assert.match(apple.limitations.join(" "), /not a measurement/);
});
test("recommendations favor agent tool support, work focus and one resident GPU", () => {
	const p = { ...machine(128), gpus: [gpu(24)] };
	const coding = servingRecommendations(p);
	assert.equal(coding.best?.model.id, "qwen3-coder-30b-a3b");
	assert.equal(coding.best?.assessment.placement, "gpu");
	const research = servingRecommendations({ ...machine(128), os: "darwin", arch: "arm64", unifiedMemory: true }, { focus: "research" });
	assert.equal(research.best?.model.id, "gpt-oss-120b");
	const small = servingRecommendations(machine(8));
	assert.equal(small.contextTokens, 8192);
	assert.equal(small.best?.model.id, "qwen3-4b");
	assert.match(coding.notes.join(" "), /remote.*does not reveal/i);
});
test("occupied RAM never yields ready-to-serve recipes or an asserted best fit", () => {
	const plan = servingRecommendations(machine(32, 1));
	assert.equal(plan.best, undefined);
	assert.equal(plan.recipes.length, 0);
	assert.ok(plan.recommendations.some(r => r.assessment.verdict === "tight"));
});
test("vLLM re-assesses publisher precision and its 80 percent allocation budget", () => {
	const plan = servingRecommendations({ ...machine(64), gpus: [gpu(24)] });
	assert.equal(plan.best?.model.id, "qwen3-coder-30b-a3b");
	const vllm = plan.recipes.find(r => r.engine === "vllm")!;
	assert.equal(vllm.model.id, "qwen3-8b");
	assert.equal(vllm.assessment.quant.label, "BF16");
	assert.ok(vllm.assessment.totalBytes <= 24 * GiB * 0.8);
	assert.match(vllm.commands[0], /--max-num-seqs 1/);
	assert.match(vllm.commands[0], /--enable-auto-tool-choice/);
	assert.equal(servingRecommendations({ ...machine(64), gpus: [gpu(8)] }).recipes.some(r => r.engine === "vllm"), false);
	// The smaller model fits, but vLLM's startup reservation is 19.2 GiB and
	// cannot be made when this 24 GiB card has only 14 GiB currently free.
	assert.equal(servingRecommendations({ ...machine(64), gpus: [gpu(24, 14)] }).recipes.some(r => r.engine === "vllm"), false);
});
test("recipes preserve GPU selection and restrict vLLM to supported CUDA/Linux", () => {
	const p = { ...machine(32), gpus: [gpu(8), { ...gpu(24), uuid: "GPU-aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb" }] };
	const recipes = servingRecommendations(p).recipes;
	assert.match(recipes.find(r => r.engine === "llama.cpp")!.commands[0], /--device DEVICE_FROM_LLAMA_LIST --split-mode none --main-gpu 0/);
	assert.match(recipes.find(r => r.engine === "vllm")!.commands[0], /CUDA_VISIBLE_DEVICES=GPU-aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb/);
	for (const changed of [
		{ ...p, os: "win32" }, { ...p, os: "darwin", arch: "arm64", unifiedMemory: true },
		{ ...p, gpus: [{ ...gpu(24), vendor: "amd" as const }] },
		{ ...p, gpus: [{ ...gpu(24), computeCapability: undefined }] },
	]) assert.equal(servingRecommendations(changed).recipes.some(r => r.engine === "vllm"), false);
});
test("Intel Mac and unknown CPU support do not advertise unsupported LM Studio", () => {
	assert.equal(servingRecommendations({ ...machine(16), os: "darwin", arch: "x64" }).recipes.some(r => r.engine === "lmstudio"), false);
	assert.equal(servingRecommendations({ ...machine(16), cpu: { ...cpu, features: [] } }).recipes.some(r => r.engine === "lmstudio"), false);
	assert.equal(servingRecommendations({ ...machine(16), os: "darwin", arch: "arm64", unifiedMemory: true }).recipes.some(r => r.engine === "lmstudio"), true);
});
test("all generated recipes have explicit local bindings and real artifact prerequisites", () => {
	const plan = servingRecommendations({ ...machine(64), gpus: [gpu(24)] });
	for (const recipe of plan.recipes) {
		assert.match(recipe.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
		assert.match(recipe.commands.join(" "), /127\.0\.0\.1/);
		assert.match(recipe.prerequisites.join(" "), /[Dd]ownload|[Oo]btain/);
		assert.ok(recipe.sources.every(s => /^https:\/\//.test(s)));
		assert.equal(recipe.assessment.verdict, "fits");
	}
	assert.match(plan.recipes.find(r => r.engine === "lmstudio")!.commands.join(" "), /--estimate-only/);
	const windows = servingRecommendations({ ...machine(16), os: "win32" }).recipes.find(r => r.engine === "ollama")!;
	assert.match(windows.commands[0], /^\$env:OLLAMA_HOST=/);
});
test("hardware text marks host scope, provenance and no-runtime-check status", () => {
	const p = { ...machine(16), os: "darwin", arch: "arm64", unifiedMemory: true };
	const tools = { ollama: { onPath: true }, lmstudio: { onPath: false }, "llama.cpp": { onPath: false }, vllm: { onPath: false } };
	const text = hardwareReportLines(p, servingRecommendations(p), tools).join("\n");
	assert.match(text, /this machine/);
	assert.match(text, /CLI found on PATH; runtime unverified/);
	assert.match(text, /CLI not found on PATH/);
	assert.match(text, /not by benchmark rank/);
	assert.match(text, /Current|machine running Rein/);
});
