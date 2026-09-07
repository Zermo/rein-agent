import assert from "node:assert/strict";
import test from "node:test";
import { formatReinOSPlan, OMARCHY_BASE, planReinOS } from "../src/os/plan.ts";
import type { HardwareProfile } from "../src/hardware/profile.ts";

function profile(os: string, arch: string): HardwareProfile {
	return { os, arch, cpu: { name: "fixture", cores: 4, physicalCores: 4, features: [] }, ram: { totalBytes: 16 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 }, gpus: [], unifiedMemory: false };
}

test("Apple Silicon keeps the native model path and gates the separate Linux port", () => {
	const hardware = profile("darwin", "arm64");
	const native = planReinOS(hardware);
	assert.equal(native.adapter, "macos-native");
	assert.ok(native.runtimes.includes("MLX"));
	const image = planReinOS(hardware, { mode: "image" });
	assert.equal(image.status, "unsupported");
	assert.ok(image.gates.some(gate => gate.id === "architecture" && gate.status === "blocked"));
	assert.ok(image.sources.some(url => url.includes("asahilinux.org")));
});

test("x86 image plans require hardware, media, VM and migration evidence", () => {
	for (const os of ["linux", "darwin", "win32"]) {
		const plan = planReinOS(profile(os, "x64"), { mode: "image" });
		assert.equal(plan.status, "candidate");
		assert.deepEqual(plan.gates.map(gate => gate.id), ["hardware", "media", "vm", "migration"]);
		assert.ok(plan.gates.every(gate => gate.status === "required"));
		assert.match(formatReinOSPlan(plan), /does not build a bootable ISO/);
	}
	assert.match(planReinOS(profile("darwin", "x64"), { mode: "image" }).facts.join(" "), /do not infer dual-boot/);
});

test("Windows planning requires validation inside WSL2", () => {
	for (const arch of ["x64", "arm64"]) {
		const plan = planReinOS(profile("win32", arch));
		assert.equal(plan.adapter, "windows-with-wsl2");
		assert.ok(plan.gates.some(gate => gate.id === "wsl2" && gate.status === "required"));
	}
});

test("unknown platforms are unsupported and Linux ARM is host-only", () => {
	for (const [os, arch] of [["freebsd", "x64"], ["linux", "riscv64"], ["darwin", "ia32"]]) {
		assert.equal(planReinOS(profile(os, arch)).status, "unsupported");
		assert.equal(planReinOS(profile(os, arch), { mode: "image" }).status, "unsupported");
	}
	assert.equal(planReinOS(profile("linux", "arm64")).status, "candidate");
	assert.equal(planReinOS(profile("linux", "arm64"), { mode: "image" }).status, "unsupported");
});

test("planner validates input and preserves its caller's data", () => {
	const hardware = profile("linux", "x64");
	const before = structuredClone(hardware);
	planReinOS(hardware);
	assert.deepEqual(hardware, before);
	assert.throws(() => planReinOS(hardware, { mode: "wipe" as any }), /host or image/);
	assert.throws(() => planReinOS(null as any), /hardware profile/);
	assert.throws(() => planReinOS({ ...hardware, gpus: [null] } as any), /hardware profile/);
	assert.match(OMARCHY_BASE.commit, /^[a-f0-9]{40}$/);
});
