/** Read-only, bounded hardware probes. Memory fit applies to this machine only. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import * as os from "node:os";

const execFileP = promisify(execFile);
const GiB = 1024 ** 3;

export interface GpuInfo {
	name: string;
	vendor?: "nvidia" | "amd" | "intel" | "apple";
	/** Undefined means unknown, or a shared pool; never zero available VRAM. */
	vramTotalBytes?: number;
	vramFreeBytes?: number;
	computeCapability?: number;
	/** Stable driver identity for a CUDA recipe; ordinal ordering can differ. */
	uuid?: string;
	sharedMemory?: boolean;
}

export interface HardwareProfile {
	os: string;
	arch: string;
	cpu: { name: string; cores: number; physicalCores: number; features: string[] };
	ram: { totalBytes: number; availableBytes: number };
	gpus: GpuInfo[];
	/** GPU and CPU use the same physical pool, not CUDA managed-memory support. */
	unifiedMemory: boolean;
	memBandwidthGBs?: number;
	bandwidthNote?: string;
	/** Probe failures and estimates that matter to a recommendation. */
	notes?: string[];
}

async function sh(cmd: string, args: string[]): Promise<string> {
	return (await execFileP(cmd, args, { timeout: 5000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}
async function read(path: string): Promise<string | undefined> {
	try { return (await readFile(path, "utf8")).trim(); } catch { return undefined; }
}
function num(s: string | undefined): number | undefined {
	if (!s) return undefined;
	const n = Number.parseFloat(s.replace(/,/g, ""));
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function clamp(value: number, total: number): number { return Math.max(0, Math.min(value, total)); }

/** Published chip bandwidth, not a measurement. Unknown bins stay unknown.
 * Sources: Apple MacBook Pro / Mac Studio tech specs, checked 2026-09-06.
 * https://www.apple.com/macbook-pro/specs/ https://www.apple.com/mac-studio/specs/
 */
export function appleBandwidth(cpuName: string, cpuCores?: number): { gbs?: number; note?: string } {
	const name = cpuName.replace(/^Apple\s+/, "").trim();
	const fixed: Record<string, number> = {
		"M1": 68, "M1 Pro": 200, "M1 Max": 400, "M1 Ultra": 800,
		"M2": 100, "M2 Pro": 200, "M2 Max": 400, "M2 Ultra": 800,
		"M3": 100, "M3 Pro": 150, "M3 Ultra": 819,
		"M4": 120, "M4 Pro": 273, "M5": 153, "M5 Pro": 307,
	};
	const bins: Record<string, Record<number, number>> = {
		"M3 Max": { 14: 300, 16: 400 }, "M4 Max": { 14: 410, 16: 546 }, "M5 Max": { 18: 614 },
	};
	// M5 Max's lower bin also has 18 CPU cores in some products: GPU-core data
	// is necessary, so report its conservative published lower bound instead.
	if (name === "M5 Max") return { gbs: 460, note: "published lower bin; 460–614 GB/s, GPU variant unverified" };
	const gbs = fixed[name] ?? (cpuCores == null ? undefined : bins[name]?.[cpuCores]);
	return gbs ? { gbs, note: "published peak; not measured" } : {};
}
function parseKV(text: string): Record<string, string> {
	return Object.fromEntries(text.split("\n").flatMap(line => {
		const i = line.indexOf(":");
		return i > 0 ? [[line.slice(0, i).trim(), line.slice(i + 1).trim()]] : [];
	}));
}

/** system_profiler VRAM strings can be MB or GB. */
export function parseVram(text: unknown): number | undefined {
	if (typeof text !== "string") return undefined;
	const match = /^([\d.,]+)\s*(GB|MB|GiB|MiB)\b/i.exec(text.trim());
	if (!match) return undefined;
	const n = num(match[1]);
	return n == null ? undefined : n * (/^G/i.test(match[2]) ? GiB : 1024 ** 2);
}
export function parseDarwinGpus(json: unknown, appleSilicon: boolean): GpuInfo[] {
	const list = (json as any)?.SPDisplaysDataType;
	if (!Array.isArray(list)) return [];
	const result: GpuInfo[] = [];
	for (const group of list) {
		for (const gpu of Array.isArray(group?._items) ? group._items : [group]) {
			if (!gpu || typeof gpu !== "object") continue;
			const name = String(gpu.sppci_model ?? gpu["chipset-model"] ?? gpu["chip-model"] ?? gpu._name ?? "GPU");
			const apple = appleSilicon && /Apple/i.test(name);
			const vram = parseVram(gpu["vram-total"] ?? gpu.spdisplays_vram ?? gpu.spdisplays_vram_shared);
			result.push({ name, vendor: apple ? "apple" : /AMD|Radeon/i.test(name) ? "amd" : /Intel/i.test(name) ? "intel" : undefined,
				...(apple ? { sharedMemory: true } : { vramTotalBytes: vram }) });
		}
	}
	return result;
}

async function profileDarwin(): Promise<HardwareProfile> {
	const key = async (k: string) => { try { return await sh("sysctl", ["-n", k]); } catch { return undefined; } };
	const [memsize, ncpu, physicalcpu, cpuNameRaw, arm, cpuFeatures, leaf7] = await Promise.all([
		key("hw.memsize"), key("hw.ncpu"), key("hw.physicalcpu"), key("machdep.cpu.brand_string"),
		key("hw.optional.arm64"), key("machdep.cpu.features"), key("machdep.cpu.leaf7_features"),
	]);
	const unified = arm === "1" || /^Apple M\d/.test(cpuNameRaw ?? "");
	const cpuName = cpuNameRaw || os.cpus()[0]?.model || "unknown CPU";
	const total = num(memsize) ?? os.totalmem();
	let available = Math.min(os.freemem(), total);
	const notes: string[] = [];
	try {
		const text = await sh("vm_stat", []);
		const pageSize = num(/page size of (\d+)/.exec(text)?.[1]);
		const vm = parseKV(text);
		if (!pageSize || vm["Pages free"] == null) throw new Error("incomplete vm_stat");
		available = ((num(vm["Pages free"]) ?? 0) + (num(vm["Pages inactive"]) ?? 0) + (num(vm["Pages speculative"]) ?? 0)) * pageSize;
		notes.push("Available macOS memory includes reclaimable inactive pages; Metal allocation limits and memory pressure still apply.");
	} catch { notes.push("Available memory probe incomplete; only free system memory was counted."); }
	let gpus: GpuInfo[] = [];
	try { gpus = parseDarwinGpus(JSON.parse(await sh("system_profiler", ["SPDisplaysDataType", "-json"])), unified); }
	catch { notes.push("GPU details unavailable; no discrete VRAM inferred."); }
	if (unified && !gpus.some(g => g.sharedMemory)) gpus.push({ name: cpuName + " GPU", vendor: "apple", sharedMemory: true });
	const cores = num(ncpu) ?? os.cpus().length;
	const bw = unified ? appleBandwidth(cpuName, cores) : {};
	return {
		os: "darwin", arch: unified ? "arm64" : process.arch,
		cpu: { name: cpuName, cores, physicalCores: num(physicalcpu) ?? cores, features: ["avx2", "avx512f"].filter(f => new RegExp(`\\b${f}\\b`, "i").test(`${cpuFeatures} ${leaf7}`)) },
		ram: { totalBytes: total, availableBytes: clamp(available, total) }, gpus, unifiedMemory: unified,
		memBandwidthGBs: bw.gbs, bandwidthNote: bw.note, notes,
	};
}

/** Reject malformed CSV rows rather than assigning another column to memory. */
export function parseNvidiaSmi(text: string): GpuInfo[] {
	return text.split("\n").flatMap(line => {
		const parts = line.split(",").map(s => s.trim());
		if (![3, 4, 5].includes(parts.length) || !parts[0]) return [];
		const [name, total, free, compute, uuid] = parts;
		if (uuid != null && !/^GPU-[a-f\d-]+$/i.test(uuid)) return [];
		if (!/^(?:[\d.]+|\[?N\/A\]?|\[Not Supported\])$/i.test(total)) return [];
		const totalMiB = num(total), freeMiB = num(free);
		return [{ name, vendor: "nvidia" as const,
			vramTotalBytes: totalMiB ? totalMiB * 1024 ** 2 : undefined,
			vramFreeBytes: totalMiB && freeMiB != null ? Math.min(freeMiB, totalMiB) * 1024 ** 2 : undefined,
			computeCapability: num(compute),
			uuid,
			// GB10 is a physical UMA device; arbitrary CUDA managed memory is not.
			sharedMemory: /\bGB10\b/i.test(name) || undefined }];
	});
}
async function nvidiaGpus(): Promise<GpuInfo[]> {
	for (const fields of ["name,memory.total,memory.free,compute_cap,uuid", "name,memory.total,memory.free,compute_cap", "name,memory.total,memory.free"]) {
		try { return parseNvidiaSmi(await sh("nvidia-smi", [`--query-gpu=${fields}`, "--format=csv,noheader,nounits"])); } catch { /* Older drivers may not expose compute_cap. */ }
	}
	return [];
}
async function amdGpus(): Promise<GpuInfo[]> {
	const result: GpuInfo[] = [];
	try {
		for (const entry of (await readdir("/sys/class/drm")).filter(n => /^card\d+$/.test(n))) {
			const dir = `/sys/class/drm/${entry}/device`;
			if (await read(`${dir}/vendor`) !== "0x1002") continue;
			const [totalRaw, usedRaw, name] = await Promise.all([read(`${dir}/mem_info_vram_total`), read(`${dir}/mem_info_vram_used`), read(`${dir}/product_name`)]);
			const total = num(totalRaw), used = num(usedRaw);
			result.push({ name: name ?? `AMD GPU (${entry})`, vendor: "amd", vramTotalBytes: total,
				vramFreeBytes: total != null && used != null ? Math.max(0, total - used) : undefined });
		}
	} catch { /* sysfs unavailable */ }
	return result;
}

/** Respect memory ceilings when Rein is installed in a Linux container. */
export function limitContainerMemory(total: number, available: number, limitRaw?: string, usedRaw?: string): { totalBytes: number; availableBytes: number } {
	const limit = num(limitRaw), used = num(usedRaw);
	if (limit != null && limit > 0 && limit < total) {
		return { totalBytes: limit, availableBytes: Math.min(available, Math.max(0, limit - (used ?? limit))) };
	}
	return { totalBytes: total, availableBytes: clamp(available, total) };
}
export async function profileLinux(): Promise<HardwareProfile> {
	const meminfo = parseKV((await read("/proc/meminfo")) ?? "");
	const total = (num(meminfo.MemTotal) ?? 0) * 1024;
	const available = (num(meminfo.MemAvailable) ?? num(meminfo.MemFree) ?? 0) * 1024;
	const [limit, used, v1Limit, v1Used, cpuinfo, nvidia, amd] = await Promise.all([
		read("/sys/fs/cgroup/memory.max"), read("/sys/fs/cgroup/memory.current"),
		read("/sys/fs/cgroup/memory/memory.limit_in_bytes"), read("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
		read("/proc/cpuinfo"), nvidiaGpus(), amdGpus(),
	]);
	const blocks = (cpuinfo ?? "").split(/\n\s*\n/).map(parseKV);
	const logical = blocks.filter(b => b.processor != null).length;
	const physicalIds = new Set(blocks.filter(b => b["core id"] != null).map(b => `${b["physical id"] ?? "0"}:${b["core id"]}`));
	const cores = logical || (process.platform === "linux" ? os.cpus().length : 0);
	const flags = (blocks.find(b => b.flags || b.Features)?.flags ?? blocks.find(b => b.Features)?.Features ?? "").split(/\s+/);
	const gpus = [...nvidia, ...amd];
	const ram = limitContainerMemory(total, available, limit ?? v1Limit, used ?? v1Used);
	const notes = ["GPU detection uses NVIDIA driver queries and AMD sysfs; missing GPU data does not establish that no accelerator exists."];
	if (ram.totalBytes < total) notes.push("System RAM is limited to the detected container memory ceiling.");
	if (nvidia.some(g => g.sharedMemory)) notes.push("GPU shares physical system memory; system RAM is counted once. Runtime support and allocation limits still require verification.");
	return {
		os: "linux", arch: process.arch,
		cpu: { name: blocks.find(b => b["model name"])?.["model name"] ?? blocks.find(b => b.Hardware)?.Hardware ?? os.cpus()[0]?.model ?? "Linux CPU",
			cores, physicalCores: physicalIds.size || cores, features: ["avx2", "avx512f", "avx512_bf16", "asimd"].filter(f => flags.includes(f)) },
		ram, gpus, unifiedMemory: nvidia.some(g => g.sharedMemory), notes,
	};
}
async function profileOther(): Promise<HardwareProfile> {
	return {
		os: `${os.platform()} (${os.release()})`, arch: os.arch(),
		cpu: { name: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length, physicalCores: os.cpus().length, features: [] },
		ram: { totalBytes: os.totalmem(), availableBytes: os.freemem() },
		gpus: process.platform === "win32" ? await nvidiaGpus() : [], unifiedMemory: false,
		notes: ["Physical CPU cores and non-NVIDIA GPU memory were not independently measured on this platform."],
	};
}

/** Probe only the current machine. Does not connect to a remote model server. */
export async function profileHardware(): Promise<HardwareProfile> {
	if (process.platform === "darwin") return profileDarwin();
	if (process.platform === "linux") return profileLinux();
	return profileOther();
}
export function gb(bytes: number, digits = 0): string {
	return `${(Math.max(0, bytes) / GiB).toFixed(digits)} GiB`;
}
export function summarizeHardware(p: HardwareProfile): string {
	const parts = [p.cpu.name, `${p.cpu.cores} cores`, `${gb(p.ram.totalBytes)} ${p.unifiedMemory ? "unified" : "RAM"}`];
	for (const g of p.gpus) if (g.vramTotalBytes && !g.sharedMemory) parts.push(`${g.name} ${gb(g.vramTotalBytes)} VRAM`);
	if (p.memBandwidthGBs) parts.push(`~${p.memBandwidthGBs} GB/s (${p.bandwidthNote ?? "estimate"})`);
	return parts.join(" · ");
}
