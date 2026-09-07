/** Read-only machine learning for Dareecho injection planning.
 * Every probe degrades to a note. Nothing in this module writes to the machine. */
import { execFile } from "node:child_process";
import * as os from "node:os";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";


export interface ProbeResult { ok: boolean; exitCode: number; stdout: string; stderr: string }
export interface Probe { id: string; command: string; ok: boolean; detail: string }
export interface BootStage { stage: string; trust: string; evidence?: string; notes?: string }
export interface OSGate { id: string; status: "required" | "blocked" | "verified"; detail: string }
export interface MachineLearn {
	schemaVersion: 1;
	learnedAt: string;
	kind: "host" | "ios";
	machine: {
		os: string; release: string; arch: string; hostname: string; model: string;
		kernel?: string; cpu: string; ramBytes?: number; virtualized?: string;
	};
	bootChain: BootStage[];
	probes: Probe[];
	gates: OSGate[];
	notes: string[];
}
export interface LearnDeps {
	platform?: string;
	udid?: string;
	hostname?: () => string;
	run?: (command: string, args: string[]) => Promise<ProbeResult>;
	read?: (path: string) => Promise<string | undefined>;
	now?: () => Date;
}

const execFileP = promisify(execFile);
const LIMIT = 4_000;
const trim = (text: string) => text.length > LIMIT ? text.slice(0, LIMIT) + "…[trimmed]" : text;

export async function defaultRun(command: string, args: string[]): Promise<ProbeResult> {
	try {
		const { stdout, stderr } = await execFileP(command, args, { timeout: 15_000, maxBuffer: 64 * 1024 });
		return { ok: true, exitCode: 0, stdout: trim(stdout), stderr: trim(stderr) };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		return { ok: false, exitCode: typeof e.code === "number" ? e.code : 1, stdout: trim(String(e.stdout ?? "")), stderr: trim(String(e.stderr ?? e.message ?? "")) };
	}
}
async function defaultRead(path: string): Promise<string | undefined> {
	try { return trim(await readFile(path, "utf8")); } catch { return undefined; }
}

interface Outcome { learn: MachineLearn }

export async function learnMachine(deps: LearnDeps = {}): Promise<Outcome> {
	const platform = deps.platform ?? process.platform;
	const run = deps.run ?? defaultRun, read = deps.read ?? defaultRead;
	const now = deps.now ?? (() => new Date());
	const name = (deps.hostname ?? osHostname)();
	const osId = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : `unknown-${platform}`;
	const probes: Probe[] = [];
	const notes: string[] = [];
	const record = (id: string, command: string, result: ProbeResult) => {
		const detail = result.ok ? firstLine(result.stdout) || "ok" : firstLine(result.stderr) || `exit ${result.exitCode}`;
		probes.push({ id, command, ok: result.ok, detail });
		if (!result.ok) notes.push(`probe ${id} unavailable: ${detail}`);
		return result;
	};
	const machine: MachineLearn["machine"] = {
		os: osId, release: "", arch: process.arch, hostname: name, model: "unknown", cpu: "unknown",
	};
	const gates: OSGate[] = [];
	const bootChain: BootStage[] = [];
	const out = async (id: string, command: string, args: string[]) => record(id, [command, ...args].join(" "), await run(command, args));

	if (platform === "darwin") {
		const [sw, hw, kernel, sip, spctl, fde, bless, nvram, bootvar, vmm] = await Promise.all([
			out("sw_vers", "sw_vers", []),
			out("hw", "sysctl", ["-n", "hw.model", "hw.memsize", "hw.ncpu"]),
			out("kernel", "sysctl", ["-n", "kern.osrelease"]),
			out("sip", "csrutil", ["status"]),
			out("gatekeeper", "spctl", ["--status"]),
			out("filevault", "fdesetup", ["status"]),
			out("boot-entry", "bless", ["--info"]),
			out("nvram", "nvram", ["-p"]),
			out("boot-var", "nvram", ["boot"]),
			out("vmm", "sysctl", ["-n", "kern.hv_vmm_present"]),
		]);
		const versionLine = (sw.stdout.split("\n").find(l => l.includes("ProductVersion")) ?? "").split("\t").pop()?.trim();
		machine.release = versionLine ?? firstLine(sw.stdout) ?? "unknown";
		const hwLines = hw.stdout.split("\n").map(line => line.trim());
		machine.model = hwLines[0] || "unknown";
		machine.ramBytes = Number.parseInt(hwLines[1] ?? "", 10) || undefined;
		machine.cpu = `${hwLines[2] ?? "?"} cores, Apple Silicon`;
		machine.kernel = firstLine(kernel.stdout);
		machine.virtualized = vmm.stdout.trim() === "1" ? "vm" : "physical";
		const bootEntryOk = bless.ok || bootvar.ok;
		const sipOn = /enabled/i.test(sip.stdout);
		const gatekeeperOn = /enabled/i.test(spctl.stdout);
		const filevaultOn = /On/i.test(fde.stdout);
		bootChain.push(
			{ stage: "bootrom", trust: "immutable", notes: "Apple per-board ROM; not updatable through the OS." },
			{ stage: "firmware", trust: "apple-signed", evidence: nvram.ok ? "nvram" : undefined, notes: "Apple firmware; updates arrive through softwareupdate." },
			{ stage: "secure-boot", trust: sipOn ? "SIP enabled" : "SIP disabled", evidence: "csrutil", notes: `Gatekeeper ${gatekeeperOn ? "on" : "off"}, FileVault ${filevaultOn ? "on" : "off"}.` },
			{ stage: "boot-entry", trust: "bless/nvram", evidence: bless.ok ? "bless" : (bootvar.ok ? "nvram boot" : undefined), notes: bootEntryOk ? "Active boot entry recorded." : "Active boot entry not read." },
			{ stage: "kernel", trust: "amfi-signed", evidence: "sysctl", notes: machine.kernel ?? "release unknown." },
		);
		gates.push(
			{ id: "secure-boot", status: sip.ok ? "verified" : "required", detail: `SIP ${sipOn ? "enabled" : "disabled"}; ${sip.ok ? "state read" : "csrutil unavailable"}.` },
			{ id: "boot-entry", status: bootEntryOk ? "verified" : "required", detail: bootEntryOk ? "Active boot entry readable; injection path C is testable." : "bless and nvram boot both unavailable; boot entry state unknown." },
		);
	} else if (platform === "linux") {
		const osrelText = await read("/etc/os-release");
		probes.push({ id: "os-release", command: "/etc/os-release", ok: osrelText !== undefined, detail: osrelText ? firstLine(osrelText) : "missing" });
		const chromeos = /ID=chromeos/i.test(osrelText ?? "") || /CROS_RELEASE/i.test(osrelText ?? "");
		if (chromeos) {
			const [uname, meminfo, dmi, dts, chrome, crosh, arc, verity, ab, efi, virt] = await Promise.all([
				out("uname", "uname", ["-sr"]),
				(async () => { const text = await read("/proc/meminfo"); probes.push({ id: "meminfo", command: "/proc/meminfo", ok: text !== undefined, detail: text ? firstLine(text) : "missing" }); return text; })(),
				(async () => { const text = await read("/sys/class/dmi/id/product_name"); probes.push({ id: "dmi", command: "/sys/class/dmi/id", ok: text !== undefined, detail: text ? text.trim() : "not present" }); return text; })(),
				(async () => { const text = await read("/proc/device-tree/model"); probes.push({ id: "dtb-model", command: "/proc/device-tree/model", ok: text !== undefined, detail: text ? text.trim() : "not present" }); return text; })(),
				out("chrome", "ls", ["/opt/google/chrome"]),
				out("crosh", "ls", ["/usr/bin/crosh"]),
				out("arc", "arc", ["--version"]),
				out("verity", "ls", ["/sys/block"]),
				out("ab-labels", "ls", ["/dev/disk/by-label"]),
				(async () => { const text = await read("/sys/firmware/efi/fw_platform_size"); probes.push({ id: "efi", command: "/sys/firmware/efi", ok: text !== undefined, detail: text ? "UEFI (CoreBoot build)" : "not present" }); return text; })(),
				out("virt", "systemd-detect-virt", []),
			]);
			machine.os = "chromeos";
			machine.release = /CROS_RELEASE=([^\s]+)/i.exec(osrelText ?? "")?.[1] ?? firstLine(osrelText) ?? "chromeos";
			machine.model = (dmi ?? dts ?? "").trim() || "unknown";
			const mem = /MemTotal:\s+(\d+)\s*kB/.exec(meminfo ?? "")?.[1];
			machine.ramBytes = mem ? Number(mem) * 1024 : undefined;
			machine.kernel = uname.stdout.trim().split(" ").slice(-1)[0] ?? undefined;
			machine.virtualized = virt.ok && virt.stdout.trim() && virt.stdout.trim() !== "none" ? virt.stdout.trim() : "physical";
			const isUefi = efi !== undefined;
			const verityOn = /dm-\d+/.test(verity.stdout);
			const abOk = /ROOT-[AB]/.test(ab.stdout);
			bootChain.push(
				{ stage: "bootrom", trust: "immutable", notes: "Per-board ROM; not updatable through the OS." },
				{ stage: "firmware", trust: isUefi ? "CoreBoot/UEFI" : "coreboot", evidence: isUefi ? "/sys/firmware/efi" : "chromeos-firmware", notes: "ChromeOS firmware; updates arrive through the OS." },
				{ stage: "verified-boot", trust: verity.ok ? (verityOn ? "dm-verity on" : "not seen") : "not read", evidence: verity.ok ? "/sys/block" : undefined, notes: verityOn ? "Verified root filesystems are present." : "dm-verity devices not listed; state unknown." },
				{ stage: "boot-ab", trust: abOk ? "A/B partitions" : "not read", evidence: ab.ok ? "/dev/disk/by-label" : undefined, notes: "ChromeOS boots ROOT-A or ROOT-B; the other stays as the fallback." },
				{ stage: "kernel", trust: "signed", evidence: "uname", notes: machine.kernel ?? "release unknown." },
				{ stage: "userland", trust: "chromium", evidence: chrome.ok ? "/opt/google/chrome" : undefined, notes: `crosh ${crosh.ok ? "present" : "not read"}, arc ${arc.ok ? "present" : "not read"}.` },
			);
			gates.push(
				{ id: "chromeos-tooling", status: crosh.ok || arc.ok ? "verified" : "required", detail: crosh.ok || arc.ok ? "crosh or arc present; shell and remote injection are reachable." : "Neither crosh nor arc read; shell access path unknown." },
				{ id: "verified-boot", status: verity.ok ? "verified" : "required", detail: verity.ok ? (verityOn ? "dm-verity devices listed." : "dm-verity state not read.") : "dm-verity state unknown." },
				{ id: "ab-partitions", status: ab.ok && abOk ? "verified" : "required", detail: abOk ? "ROOT-A/ROOT-B labels visible; the A/B rollback path is confirmed." : "A/B labels not read." },
				{ id: "backup", status: "required", detail: "Run rein export presets (or rein export browse) first; ChromeOS user data lives under /home/chronos/user." },
			);
		} else {
		const [osrel, uname, meminfo, cpuinfo, efi, efibootmgr, mokutil, bootdir, virt] = await Promise.all([
			(async () => { return osrelText; })(),
			out("uname", "uname", ["-sr"]),
			(async () => { const text = await read("/proc/meminfo"); probes.push({ id: "meminfo", command: "/proc/meminfo", ok: text !== undefined, detail: text ? firstLine(text) : "missing" }); return text; })(),
			(async () => { const text = await read("/proc/cpuinfo"); probes.push({ id: "cpuinfo", command: "/proc/cpuinfo", ok: text !== undefined, detail: text ? firstLine(text) : "missing" }); return text; })(),
			(async () => { const text = await read("/sys/firmware/efi/fw_platform_size"); probes.push({ id: "efi", command: "/sys/firmware/efi", ok: text !== undefined, detail: text ? "UEFI" : "not present" }); return text; })(),
			out("efibootmgr", "efibootmgr", ["-v"]),
			out("mokutil", "mokutil", ["--sb-state"]),
			out("boot-dir", "ls", ["/boot"]),
			out("virt", "systemd-detect-virt", []),
		]);
		machine.release = firstLine(osrel) ?? "linux";
		machine.model = (cpuinfo ?? "").split("\n").map(l => l.trim()).find(l => l.startsWith("model name"))?.split(":").slice(1).join(" ").trim() ?? "unknown";
		const mem = /MemTotal:\s+(\d+)\s*kB/.exec(meminfo ?? "")?.[1];
		machine.ramBytes = mem ? Number(mem) * 1024 : undefined;
		machine.kernel = uname.stdout.trim().split(" ").slice(-1)[0] ?? undefined;
		machine.virtualized = virt.ok && virt.stdout.trim() && virt.stdout.trim() !== "none" ? virt.stdout.trim() : "physical";
		const isUefi = efi !== undefined;
		const sb = /enabled/i.test(mokutil.stdout) ? "enabled" : /disabled/i.test(mokutil.stdout) ? "disabled" : "unknown";
		bootChain.push(
			{ stage: "firmware", trust: isUefi ? "UEFI" : "legacy BIOS", evidence: isUefi ? "/sys/firmware/efi" : "absence", notes: isUefi ? "UEFI platform." : "No EFI runtime visible; treat as legacy BIOS." },
			{ stage: "secure-boot", trust: sb, evidence: mokutil.ok ? "mokutil" : undefined, notes: sb === "unknown" ? "Secure Boot state not read." : "State read." },
			{ stage: "boot-manager", trust: "efibootmgr", evidence: efibootmgr.ok ? "efibootmgr" : undefined, notes: efibootmgr.ok ? "Boot entries recorded." : "Boot entries not read." },
			{ stage: "bootloader", trust: "distro", evidence: bootdir.ok ? "ls /boot" : undefined, notes: bootdir.ok ? "/boot contents recorded." : "/boot not listed." },
			{ stage: "kernel", trust: "signed-by-distro", evidence: "uname", notes: machine.kernel ?? "release unknown." },
		);
		gates.push(
			{ id: "secure-boot", status: mokutil.ok && sb !== "unknown" ? "verified" : "required", detail: `Secure Boot ${sb}.` },
			{ id: "boot-manager", status: efibootmgr.ok ? "verified" : "required", detail: efibootmgr.ok ? "Boot entries readable." : "efibootmgr unavailable." },
		);
		}
	} else if (platform === "win32") {
		const [ver, systeminfo, bios, secureboot, legacy, cpu, ram, hypervisor, tpm] = await Promise.all([
			out("ver", "ver", []),
			out("systeminfo", "systeminfo", []),
			out("bios", "powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_BIOS).SMBIOSBIOSVersion"]),
			out("secure-boot", "powershell", ["-NoProfile", "-Command", "Confirm-SecureBootUEFI"]),
			out("legacy-boot", "powershell", ["-NoProfile", "-Command", "Test-Path $env:SystemRoot\\System32"]),
			out("cpu", "powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name"]),
			out("ram", "powershell", ["-NoProfile", "-Command", "[int64](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"]),
			out("hypervisor", "powershell", ["-NoProfile", "-Command", "[bool](Get-CimInstance Win32_ComputerSystem).HypervisorPresent"]),
			out("tpm", "powershell", ["-NoProfile", "-Command", "(Get-Tpm).TpmStatus"]),
		]);
		machine.release = firstLine(ver.stdout) ?? firstLine(systeminfo.stdout) ?? "unknown";
		machine.cpu = firstLine(cpu.stdout) ?? "unknown";
		machine.ramBytes = Number.parseInt(firstLine(ram.stdout) ?? "", 10) || undefined;
		machine.kernel = firstLine(systeminfo.stdout) ?? undefined;
		const isLegacy = legacy.stdout.trim() === "True";
		const sbOn = secureboot.stdout.trim() === "True";
		machine.virtualized = hypervisor.stdout.trim() === "True" ? "vm" : "physical";
		bootChain.push(
			{ stage: "firmware", trust: isLegacy ? "legacy BIOS" : "UEFI", evidence: "Win32_BIOS", notes: `BIOS ${firstLine(bios.stdout) ?? "version unknown"}.` },
			{ stage: "secure-boot", trust: secureboot.ok ? (sbOn ? "enabled" : "disabled") : "unknown", evidence: secureboot.ok ? "Confirm-SecureBootUEFI" : undefined, notes: secureboot.ok ? "State read." : "Secure Boot state not read." },
			{ stage: "boot-manager", trust: "bcd", notes: "bcdedit entries need elevation; not read in this pass." },
			{ stage: "kernel", trust: "windows-loader", evidence: "ver", notes: machine.release || "release unknown." },
		);
		gates.push(
			{ id: "secure-boot", status: secureboot.ok ? "verified" : "required", detail: `Secure Boot ${secureboot.ok ? (sbOn ? "enabled" : "disabled") : "unknown"}.` },
			{ id: "tpm", status: tpm.ok ? "verified" : "required", detail: `TPM ${tpm.ok ? firstLine(tpm.stdout) : "state unknown"}.` },
		);
	} else {
		notes.push(`No learn pass is defined for platform "${platform}"; structure only.`);
		gates.push({ id: "platform", status: "blocked", detail: `No Dareecho learn adapter for "${platform}".` });
	}

	const okCount = probes.filter(p => p.ok).length;
	gates.unshift({
		id: "evidence-core",
		status: probes.length >= 3 && okCount / probes.length >= 0.5 ? "verified" : "required",
		detail: `${okCount}/${probes.length} probes succeeded on ${machine.os}/${machine.arch}.`,
	});
	notes.push("Probes are read-only. This pass changed nothing on the machine.");
	const learn: MachineLearn = { schemaVersion: 1, learnedAt: now().toISOString(), kind: "host", machine, bootChain, probes, gates, notes };
	return { learn };
}

function firstLine(text: string): string | undefined {
	const line = text.split("\n").map(s => s.trim()).find(Boolean);
	return line;
}
function osHostname(): string {
	try { return os.hostname(); } catch { return "unknown"; }
}
