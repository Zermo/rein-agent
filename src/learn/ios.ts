/** Learn a USB-attached iOS device through libimobiledevice (read-only). */
import { defaultRun, type LearnDeps, type MachineLearn, type Probe, type ProbeResult } from "./profile.ts";

export async function learnIos(deps: LearnDeps = {}): Promise<{ learn: MachineLearn }> {
	const run = deps.run ?? defaultRun;
	const now = deps.now ?? (() => new Date());
	const probes: Probe[] = [];
	const notes: string[] = [];
	const record = (id: string, command: string, result: ProbeResult) => {
		const detail = result.ok ? firstLine(result.stdout) || "ok" : firstLine(result.stderr) || `exit ${result.exitCode}`;
		probes.push({ id, command, ok: result.ok, detail });
		if (!result.ok) notes.push(`probe ${id} unavailable: ${detail}`);
		return result;
	};

	const list = record("device-list", "idevice_id -l", await run("idevice_id", ["-l"]));
	if (!list.ok || !list.stdout.trim()) {
		return { learn: frame({
			notes: [...notes, "No iOS device attached (or libimobiledevice missing). On macOS: brew install libimobiledevice, then unlock the device and trust this computer."],
			gates: [{ id: "ios-tooling", status: "blocked", detail: list.ok ? "No device listed by idevice_id." : "idevice_id not on PATH; install libimobiledevice." }],
		}) };
	}
	const udids = list.stdout.trim().split("\n").map(u => u.trim()).filter(Boolean);
	const udid = deps.udid ? udids.find(u => u === deps.udid) ?? udids[0] : udids[0];
	const info = record(`ideviceinfo:${udid}`, `ideviceinfo -u ${udid}`, await run("ideviceinfo", ["-u", udid]));
	const kv = parseInfo(info.stdout);

	const machine = {
		os: "ios",
		release: kv["ProductVersion"] ?? kv["ProductType"] ?? "unknown",
		arch: kv["HardwarePlatform"] ?? kv["CPUArchitecture"] ?? (kv["HardwareModel"] ? guessArch(kv["HardwareModel"]) : "unknown"),
		hostname: kv["DeviceName"] ?? udid,
		model: kv["HardwareModel"] ?? kv["ProductType"] ?? "unknown",
		cpu: kv["DeviceClass"] ?? "iOS device",
		virtualized: "physical",
	};
	const jailbroken = kv["Jailbreak"] === "yes" || kv["JailbreakStatus"] === "jailed";
	const bootChain = [
		{ stage: "bootrom", trust: "immutable", notes: "Apple per-board ROM; the root of the iOS trust chain." },
		{ stage: "recovery", trust: "iBSS/iBEC", notes: "Recovery/DFU payload path; requires Apple host trust." },
		{ stage: "low-level-bootloader", trust: "apple-signed", notes: "AppleLL/LLB; validated against the secure boot chain." },
		{ stage: "kernel", trust: "apple-signed", evidence: "ideviceinfo", notes: `KernelCache for ${kv["ProductVersion"] ?? "unknown"} (${kv["BuildVersion"] ?? "build unknown"}).` },
		{ stage: "userland", trust: "launchd", evidence: "ideviceinfo", notes: jailbroken ? "Jailbreak indicators present." : "Jailbreak state not confirmed from the host; on-device probe needed." },
	];
	const gates = [
		{ id: "ios-tooling", status: "verified" as const, detail: `libimobiledevice enumerated ${udids.length} device(s).` },
		{ id: "jailbreak-state", status: jailbroken ? "verified" as const : "required" as const, detail: jailbroken ? "Jailbreak indicators present." : "Unknown from the host; use an on-device pass (Frida/Objection or the CyberStrike mobile agent)." },
		{ id: "backup", status: "required" as const, detail: "Take a backup and prepare recovery media before any injection or restore." },
	];
	notes.push("Probes are read-only. This pass changed nothing on the device.");
	const learn = frame({ machine, bootChain, probes, gates, notes });
	return { learn };

	function frame(extra: Partial<MachineLearn> & { notes: string[]; gates: MachineLearn["gates"] }): MachineLearn {
		return {
			schemaVersion: 1, learnedAt: now().toISOString(), kind: "ios",
			machine: extra.machine ?? { os: "ios", release: "unknown", arch: "unknown", hostname: "ios-device", model: "unknown", cpu: "unknown", virtualized: "physical" },
			bootChain: extra.bootChain ?? [],
			probes: extra.probes ?? [],
			gates: extra.gates,
			notes: extra.notes,
		};
	}
}

function parseInfo(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const idx = line.indexOf("\t");
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim(), value = line.slice(idx + 1).trim();
		if (key && value) out[key] = value;
	}
	return out;
}
function guessArch(model: string): string {
	return model.startsWith("iPhone") || model.startsWith("iPad") || model.startsWith("iPod") ? "arm64" : "unknown";
}
function firstLine(text: string): string | undefined {
	return text.split("\n").map(s => s.trim()).find(Boolean);
}
