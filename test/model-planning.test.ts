import assert from "node:assert/strict";
import { test } from "node:test";
import { planModelArtifact } from "../src/models/planning.ts";
import type { ModelArtifact } from "../src/models/artifacts.ts";
import type { HardwareProfile } from "../src/hardware/profile.ts";
const GiB = 1024 ** 3;
const machine: HardwareProfile = { os: "linux", arch: "x64", cpu: { name: "Fixture CPU", cores: 8, physicalCores: 8, features: [] }, ram: { totalBytes: 32 * GiB, availableBytes: 24 * GiB }, gpus: [], unifiedMemory: false };
const artifact: ModelArtifact = { schemaVersion: 1, id: "a".repeat(64), repo: "fixture/Qwen3-8B-GGUF", revision: "b".repeat(40), file: "model.gguf", sha256: "c".repeat(64), sizeBytes: 5 * GiB, url: "https://huggingface.co/fixture/model" };

test("artifact planning uses exact downloaded weights and counts KV plus reserve", () => {
	const short = planModelArtifact(artifact, machine, 4096), long = planModelArtifact(artifact, machine, 32768);
	assert.equal(short.memory!.weightsBytes, artifact.sizeBytes);
	assert.ok(short.memory!.totalBytes > artifact.sizeBytes);
	assert.ok(long.memory!.kvBytes > short.memory!.kvBytes);
	assert.equal(short.memory!.placement, "ram");
	assert.equal(short.scope, "current-machine");
});
test("unknown artifacts never become asserted fits just because weights fit", () => {
	const plan = planModelArtifact({ ...artifact, repo: "fixture/new-family" }, machine);
	assert.equal(plan.memory, null);
	assert.match(plan.notes.join(" "), /cannot establish a memory fit/);
});
test("invalid context and artifact sizes fail instead of producing unusable plans", () => {
	for (const context of [0, 1, 1.5, NaN, Infinity, 131073]) assert.throws(() => planModelArtifact(artifact, machine, context));
	assert.throws(() => planModelArtifact({ ...artifact, sizeBytes: NaN }, machine));
});
test("occupied memory is never reported as ready and model context caps remain visible", () => {
	const plan = planModelArtifact(artifact, { ...machine, ram: { totalBytes: 32 * GiB, availableBytes: GiB } }, 131072);
	assert.equal(plan.memory!.verdict, "tight");
	assert.equal(plan.contextTokens, 40960);
	assert.match(plan.memory!.limitations.join(" "), /capped/);
});
