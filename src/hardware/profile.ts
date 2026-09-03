/**
 * Hardware profiling — cross-platform, zero dependencies.
 *
 * Stolen concept from Magnitude (magnitudedev/magnitude, Apache-2.0):
 * profile the chip, memory, and bandwidth, so the harness can tell you
 * what you can run instead of guessing. rein's version is portable JS
 * (sysctl/vm_stat on macOS, /proc on Linux) and knows about unified
 * memory (Apple Silicon: RAM and GPU share one pool).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface GpuInfo {
	name: string;
	/** undefined for unified-memory GPUs (the pool is reported on `ram`). */
	vramTotalBytes?: number;
	vramFreeBytes?: number;
}

export interface HardwareProfile {
	os: string;
	arch: string;
	cpu: { name: string; cores: number; physicalCores: number; features: string[] };
	/** One memory pool for Apple Silicon (unified); system RAM otherwise. */
	ram: { totalBytes: number; availableBytes: number };
	gpus: GpuInfo[];
	/** true when the GPU shares the RAM pool (Apple Silicon). */
	unifiedMemory: boolean;
	/** Rough peak memory bandwidth, GB/s. Estimate where sourced from chip tables. */
	memBandwidthGBs?: number;
	/** How the bandwidth number was derived (shown to the user). */
	bandwidthNote?: string;
}

const GiB = 1024 ** 3;

function sh(cmd: string, args: string[]): Promise<string> {
	return execFileP(cmd, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout.trim());
}

function num(s: string | undefined): number | undefined {
	if (!s) return undefined;
	const n = Number.parseFloat(s.replace(/,/g, ""));
	return Number.isFinite(n) ? n : undefined;
}

/** Apple Silicon peak bandwidth (GB/s) from published specs; M5* are estimates. */
const APPLE_BANDWIDTH: Array<[RegExp, number, string]> = [
	[/M1 Pro/, 200, "spec"],
	[/M1 Max/, 400, "spec"],
	[/M1\b/, 68, "spec"],
	[/M2 Pro/, 200, "spec"],
	[/M2 Max/, 400, "spec"],
	[/M2\b/, 100, "spec"],
	[/M3 Pro/, 150, "spec"],
	[/M3 Max/, 300, "spec"],
	[/M3\b/, 100, "spec"],
	[/M4 Pro/, 273, "spec"],
	[/M4 Max/, 546, "spec"],
	[/M4\b/, 120, "spec"],
	[/M5 Pro/, 307, "estimate"],
	[/M5 Max/, 614, "estimate"],
	[/M5\b/, 153, "estimate"],
];

function appleBandwidth(cpuName: string): { gbs?: number; note?: string } {
	for (const [re, gbs, kind] of APPLE_BANDWIDTH) {
		if (re.test(cpuName)) return { gbs, note: kind === "estimate" ? "estimate" : "spec" };
	}
	return {};
}

function parseSysctlKV(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return out;
}

async function profileDarwin(): Promise<HardwareProfile> {
	// `sysctl -n k1 k2…` prints values in order, one per line — but one missing
	// oid makes the whole call exit non-zero and reject. Run each key separately.
	const key = async (k: string): Promise<string | undefined> => {
		try {
			return (await sh("sysctl", ["-n", k])).trim();
		} catch {
			return undefined;
		}
	};
	const [memsize, ncpu, physicalcpu, cpuNameRaw] = await Promise.all([
		key("hw.memsize"),
		key("hw.ncpu"),
		key("hw.physicalcpu"),
		key("machdep.cpu.brand_string"),
	]);
	const cpuName = cpuNameRaw || "Apple CPU";
	const cores = num(ncpu) ?? 0;
	const physical = num(physicalcpu) ?? cores;
	const total = num(memsize) ?? 0;

	// macOS reports CPU features as a token string ("AVX2 AVX FMA …"), not the
	// Linux-style hw.optional.* oids — parse that (arm chips simply don't list AVX).
	const features: string[] = [];
	const cpuFeatures = (await key("machdep.cpu.features")) ?? "";
	if (/\bAVX2\b/i.test(cpuFeatures)) features.push("avx2");
	if (/\bAVX512F\b/i.test(cpuFeatures)) features.push("avx512");

	// Available RAM: free + inactive + speculative pages (the reclaimable pool)
	let available = total;
	try {
		const vmText = await sh("vm_stat", []);
		const page = Number(/page size of (\d+)/.exec(vmText)?.[1]) || 16384;
		const vm = parseSysctlKV(vmText);
		const free = num(vm["Pages free"]) ?? 0;
		const inactive = num(vm["Pages inactive"]) ?? 0;
		const spec = num(vm["Pages speculative"]) ?? 0;
		available = (free + inactive + spec) * page;
	} catch {
		// keep the conservative fallback (total)
	}

	const gpus: GpuInfo[] = [];
	let unified = true; // Apple Silicon defaults: built-in GPU on a shared pool
	let bw: { gbs?: number; note?: string } = {};
	try {
		const text = await sh("system_profiler", ["SPDisplaysDataType", "-json"]);
			const json = JSON.parse(text) as any;
			const items = json?.SPDisplaysDataType ?? [];
			for (const item of items) {
				// macOS JSON shape varies: some versions nest the GPU under _items[0],
				// others put the detail keys directly on the group object.
				const gpu = item._items?.[0] ?? item;
				if (!gpu) continue;
				const name = gpu["_name"] ?? gpu["chipset-model"] ?? gpu["chip-model"] ?? "Apple GPU";
				const vram = num(gpu["vram-total"]) ?? num(gpu["spdisplays_vram"]);
				if (vram) {
					gpus.push({ name, vramTotalBytes: vram * 1024 ** 2 });
					unified = false;
				} else {
					gpus.push({ name });
				}
			}
	} catch {
		// system_profiler failed: keep defaults (unified, no discrete VRAM)
	}
	bw = appleBandwidth(cpuName);

	return {
		os: `darwin ${process.env.DARWIN_VERSION ?? ""}`.trim(),
		arch: process.arch,
		cpu: { name: cpuName, cores, physicalCores: physical, features },
		ram: { totalBytes: total, availableBytes: Math.min(available, total) },
		gpus,
		unifiedMemory: unified,
		memBandwidthGBs: bw.gbs,
		bandwidthNote: bw.note,
	};
}

async function profileLinux(): Promise<HardwareProfile> {
	const read = async (p: string): Promise<string | undefined> => {
		try {
			const { readFile } = await import("node:fs/promises");
			return (await readFile(p, "utf8")).trim();
		} catch {
			return undefined;
		}
	};
	const meminfo = parseSysctlKV((await read("/proc/meminfo")) ?? "");
	const total = (num(meminfo.MemTotal) ?? 0) * 1024;
	const availKB = num(meminfo.MemAvailable) ?? num(meminfo.MemFree) ?? 0;
	const available = availKB * 1024;

	const cpuinfo = (await read("/proc/cpuinfo")) ?? "";
	const lines = cpuinfo.split("\n");
	const name = lines.map((l) => l.match(/model name\s*:\s*(.*)/)?.[1]).find(Boolean) ?? "Linux CPU";
	let cores = lines.filter((l) => l.startsWith("processor")).length;
	if (cores === 0) {
		try {
			cores = num(await sh("nproc", [])) ?? 0;
		} catch {
			// no nproc either — leave 0
		}
	}
	const flagsLine = lines.map((l) => l.match(/^flags\s*:\s*(.*)/)?.[1]).find(Boolean) ?? "";
	const features = ["avx2", "avx512f", "avx512_bf16"].filter((f) => flagsLine.includes(f));

	const gpus: GpuInfo[] = [];
	try {
		const out = await sh("nvidia-smi", [
			"--query-gpu=name,memory.total,memory.free",
			"--format=csv,noheader,nounits",
		]);
		for (const line of out.split("\n")) {
			const parts = line.split(",").map((s) => s.trim());
			if (parts.length < 3) continue; // malformed row (e.g. comma in a GPU name) — skip, don't misparse
			const [n, tot, free] = parts;
			const totB = num(tot);
			if (n && totB) gpus.push({ name: n, vramTotalBytes: totB * 1024 ** 2, vramFreeBytes: (num(free) ?? 0) * 1024 ** 2 });
		}
	} catch {
		// no nvidia-smi (or no NVIDIA GPU)
	}
	// Dimm-speed heuristics are too machine-specific to trust; report what we know.
	bw = {};

	return {
		os: "linux",
		arch: process.arch,
		cpu: { name, cores, physicalCores: cores, features },
		ram: { totalBytes: total, availableBytes: available },
		gpus,
		unifiedMemory: false,
		memBandwidthGBs: bw.gbs,
		bandwidthNote: bw.note,
	};
}

async function profileOther(): Promise<HardwareProfile> {
	const os = await import("node:os");
	return {
		os: `${os.platform()} (${os.release()})`,
		arch: os.arch(),
		cpu: { name: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length, physicalCores: os.cpus().length, features: [] },
		ram: { totalBytes: os.totalmem(), availableBytes: os.freemem() },
		gpus: [],
		unifiedMemory: false,
	};
}

/** Profile the machine. All probes are cheap (<0.5s) and the GPU data affects
 * the fit verdict, so nothing is skipped. */
export async function profileHardware(): Promise<HardwareProfile> {
	if (process.platform === "darwin") return profileDarwin();
	if (process.platform === "linux") return profileLinux();
	return profileOther();
}

/** Human-readable sizes: 48 GB, 1.2 GiB. */
export function gb(bytes: number, digits = 0): string {
	const v = bytes / GiB;
	if (v >= 100) return `${Math.round(v)} GB`;
	return `${v.toFixed(digits)} GB`;
}

/** One-line summary for banners: "Apple M5 Pro · 18 cores · 48 GB unified · ~307 GB/s". */
export function summarizeHardware(p: HardwareProfile): string {
	const parts = [p.cpu.name, `${p.cpu.cores} cores`];
	if (p.unifiedMemory) parts.push(`${gb(p.ram.totalBytes)} unified`);
	else parts.push(`${gb(p.ram.totalBytes)} RAM`);
	for (const g of p.gpus) {
		if (g.vramTotalBytes) parts.push(`${g.name} ${gb(g.vramTotalBytes)} VRAM`);
	}
	if (p.memBandwidthGBs) parts.push(`~${p.memBandwidthGBs} GB/s${p.bandwidthNote === "estimate" ? " (est)" : ""}`);
	return parts.join(" · ");
}
