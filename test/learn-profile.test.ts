import assert from "node:assert/strict";
import test from "node:test";
import { learnMachine, type ProbeResult } from "../src/learn/profile.ts";

const ok = (stdout: string): ProbeResult => ({ ok: true, exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): ProbeResult => ({ ok: false, exitCode: 1, stdout: "", stderr });

function fakeRun(map: Record<string, ProbeResult>) {
	return async (command: string, args: string[]): Promise<ProbeResult> => {
		const key = [command, ...args].join(" ");
		return map[key] ?? map[command] ?? fail(`no fake for ${key}`);
	};
}

test("macOS learn pass assembles the full boot chain from probe evidence", async () => {
	const { learn } = await learnMachine({
		platform: "darwin",
		hostname: () => "testhost",
		now: () => new Date("2026-01-01T00:00:00Z"),
		run: fakeRun({
			"sw_vers": ok("ProductName:\tmacOS\nProductVersion:\t26.6.2\n"),
			"sysctl -n hw.model hw.memsize hw.ncpu": ok("Mac16,10\n25769803776\n10\n"),
			"sysctl -n kern.osrelease": ok("25.6.0"),
			"csrutil status": ok("System Integrity Protection status: disabled."),
			"spctl --status": ok("assessed against policy"),
			"fdesetup status": ok("FileVault is Off."),
			"bless --info": fail("Can't statfs , failed with error -1"),
			"nvram -p": ok("boot-args    -v"),
			"nvram boot": ok("HFS:\\MacOS\""),
			"sysctl -n kern.hv_vmm_present": ok("0"),
		}),
	});
	assert.equal(learn.schemaVersion, 1);
	assert.equal(learn.kind, "host");
	assert.equal(learn.machine.os, "macos");
	assert.equal(learn.machine.hostname, "testhost");
	assert.equal(learn.machine.model, "Mac16,10");
	assert.equal(learn.machine.ramBytes, 25769803776);
	assert.equal(learn.machine.virtualized, "physical");
	assert.deepEqual(learn.bootChain.map(s => s.stage), ["bootrom", "firmware", "secure-boot", "boot-entry", "kernel"]);
	const secureBoot = learn.bootChain.find(s => s.stage === "secure-boot");
	assert.equal(secureBoot?.trust, "SIP disabled");
	assert.ok(learn.gates.some(g => g.id === "evidence-core" && g.status === "verified"));
	assert.ok(learn.gates.every(g => ["required", "blocked", "verified"].includes(g.status)));
	assert.equal(learn.learnedAt, "2026-01-01T00:00:00.000Z");
});

test("Linux learn pass reports UEFI/BIOS split and degrades without efibootmgr", async () => {
	const { learn } = await learnMachine({
		platform: "linux",
		hostname: () => "ubuntu-arm",
		now: () => new Date("2026-01-01T00:00:00Z"),
		run: fakeRun({
			"uname -sr": ok("Linux 6.8.0-40-generic"),
			"efibootmgr -v": fail("efibootmgr: command not found"),
			"mokutil --sb-state": fail("mokutil: command not found"),
			"ls /boot": ok("config-6.8.0-40-generic  grub  initrd.img-6.8.0-40-generic  vmlinuz-6.8.0-40-generic"),
			"systemd-detect-virt": ok("none"),
		}),
		read: async (path: string) => {
			if (path === "/etc/os-release") return "PRETTY_NAME=\"Ubuntu 24.04.2 LTS\"\n";
			if (path === "/proc/meminfo") return "MemTotal:       16384000 kB\n";
			if (path === "/proc/cpuinfo") return "processor\t: 0\nmodel name\t: Neoverse-V2\n";
			if (path === "/sys/firmware/efi/fw_platform_size") return "256\n";
			return undefined;
		},
	});
	assert.equal(learn.machine.os, "linux");
	assert.equal(learn.machine.ramBytes, 16384000 * 1024);
	assert.deepEqual(learn.bootChain.map(s => s.stage), ["firmware", "secure-boot", "boot-manager", "bootloader", "kernel"]);
	assert.equal(learn.bootChain[0].trust, "UEFI");
	assert.equal(learn.gates.find(g => g.id === "secure-boot")?.status, "required");
	assert.equal(learn.gates.find(g => g.id === "boot-manager")?.status, "required");
});

test("ChromeOS learn pass maps the ChromeOS boot chain and gates", async () => {
	const { learn } = await learnMachine({
		platform: "linux",
		hostname: () => "pixel",
		now: () => new Date("2026-01-01T00:00:00Z"),
		run: fakeRun({
			"uname -sr": ok("Linux 6.1.0-chromeos #1 SMP x86_64"),
			"ls /opt/google/chrome": ok("chrome  resources"),
			"ls /usr/bin/crosh": ok("/usr/bin/crosh"),
			"arc --version": ok("arc 1.0"),
			"ls /sys/block": ok("sda dm-0 dm-1 loop0"),
			"ls /dev/disk/by-label": ok("ROOT-A ROOT-B STATE-A STATE-B"),
			"systemd-detect-virt": ok("none"),
		}),
		read: async (path: string) => {
			if (path === "/etc/os-release") return "NAME=Chrome OS\nID=chromeos\nCROS_RELEASE=132.0.6834.0\n";
			if (path === "/proc/meminfo") return "MemTotal:        8123456 kB\n";
			if (path === "/sys/class/dmi/id/product_name") return "Nyanza\n";
			if (path === "/sys/firmware/efi/fw_platform_size") return "256\n";
			return undefined;
		},
	});
	assert.equal(learn.machine.os, "chromeos");
	assert.equal(learn.machine.release, "132.0.6834.0");
	assert.equal(learn.machine.model, "Nyanza");
	assert.deepEqual(learn.bootChain.map(s => s.stage), ["bootrom", "firmware", "verified-boot", "boot-ab", "kernel", "userland"]);
	assert.equal(learn.bootChain.find(s => s.stage === "firmware")?.trust, "CoreBoot/UEFI");
	assert.equal(learn.bootChain.find(s => s.stage === "verified-boot")?.trust, "dm-verity on");
	assert.equal(learn.bootChain.find(s => s.stage === "boot-ab")?.trust, "A/B partitions");
	assert.equal(learn.gates.find(g => g.id === "chromeos-tooling")?.status, "verified");
	assert.equal(learn.gates.find(g => g.id === "verified-boot")?.status, "verified");
	assert.equal(learn.gates.find(g => g.id === "ab-partitions")?.status, "verified");
	assert.equal(learn.gates.find(g => g.id === "backup")?.status, "required");
	assert.match(learn.gates.find(g => g.id === "backup")?.detail ?? "", /rein export/);
});

test("ChromeOS detection degrades when verity and A/B labels are not readable", async () => {
	const { learn } = await learnMachine({
		platform: "linux",
		hostname: () => "cros-arm",
		run: fakeRun({
			"uname -sr": ok("Linux 6.1.0-chromeos #1 SMP aarch64"),
			"ls /opt/google/chrome": fail("No such file or directory"),
			"ls /usr/bin/crosh": fail("No such file or directory"),
			"arc --version": fail("arc: command not found"),
			"ls /sys/block": fail("Operation not permitted"),
			"ls /dev/disk/by-label": fail("Operation not permitted"),
		}),
		read: async (path: string) => {
			if (path === "/etc/os-release") return "NAME=Chrome OS\nID=chromeos\nCROS_RELEASE=128.0.6613.0\n";
			if (path === "/proc/device-tree/model") return "exynos5422-Tab10\n";
			return undefined;
		},
	});
	assert.equal(learn.machine.os, "chromeos");
	assert.equal(learn.machine.model, "exynos5422-Tab10");
	assert.equal(learn.gates.find(g => g.id === "chromeos-tooling")?.status, "required");
	assert.equal(learn.gates.find(g => g.id === "verified-boot")?.status, "required");
	assert.equal(learn.gates.find(g => g.id === "ab-partitions")?.status, "required");
	assert.ok(learn.notes.some(n => n.includes("probe")), "failed probes become notes");
});

test("Windows learn pass runs on any host and degrades cleanly when probes are missing", async () => {
	const { learn } = await learnMachine({
		platform: "win32",
		hostname: () => "WSL-ARM",
		now: () => new Date("2026-01-01T00:00:00Z"),
		run: fakeRun({
			"ver": ok("Microsoft Windows [Version 10.0.26100.1]\n"),
			"systeminfo": fail("'systeminfo' is not recognized"),
			"powershell": fail("powershell not found"),
		}),
	});
	assert.equal(learn.machine.os, "windows");
	assert.deepEqual(learn.bootChain.map(s => s.stage), ["firmware", "secure-boot", "boot-manager", "kernel"]);
	assert.ok(learn.gates.length >= 3);
	assert.ok(learn.notes.length > 0, "failed probes are recorded as notes, not thrown");
	assert.equal(learn.bootChain.find(s => s.stage === "firmware")?.trust, "unknown");
	assert.equal(learn.gates.find(g => g.id === "firmware-mode")?.status, "required");
});

test("Windows firmware mode comes from BiosFirmwareType, independently of Secure Boot", async () => {
	for (const [value, expected] of [["Bios\r\n", "legacy BIOS"], ["Uefi\r\n", "UEFI"]]) {
		const { learn } = await learnMachine({
			platform: "win32", hostname: () => "fixture-windows",
			run: fakeRun({
				"powershell -NoProfile -Command (Get-ComputerInfo -Property BiosFirmwareType -ErrorAction Stop).BiosFirmwareType": ok(value),
				"powershell -NoProfile -Command Confirm-SecureBootUEFI": ok("False"),
			}),
		});
		assert.equal(learn.bootChain.find(s => s.stage === "firmware")?.trust, expected);
		assert.equal(learn.bootChain.find(s => s.stage === "firmware")?.evidence, "Get-ComputerInfo BiosFirmwareType");
		assert.equal(learn.gates.find(g => g.id === "firmware-mode")?.status, "verified");
		assert.equal(learn.bootChain.find(s => s.stage === "secure-boot")?.trust, "disabled");
		assert.equal(learn.probes.some(p => p.command.includes("Test-Path")), false);
	}
});

test("Windows firmware mode remains unknown for failed, empty, or unrecognized evidence", async () => {
	for (const result of [ok(""), ok("Unknown"), ok("True"), { ...fail("Access denied"), stdout: "Uefi" }]) {
		const { learn } = await learnMachine({
			platform: "win32", hostname: () => "fixture-windows",
			run: fakeRun({
				"powershell -NoProfile -Command (Get-ComputerInfo -Property BiosFirmwareType -ErrorAction Stop).BiosFirmwareType": result,
			}),
		});
		assert.equal(learn.bootChain.find(s => s.stage === "firmware")?.trust, "unknown");
		assert.equal(learn.bootChain.find(s => s.stage === "firmware")?.evidence, undefined);
		assert.equal(learn.gates.find(g => g.id === "firmware-mode")?.status, "required");
	}
});

test("unknown platform yields a blocked gate instead of throwing", async () => {
	const { learn } = await learnMachine({
		platform: "freebsd",
		hostname: () => "iso",
		now: () => new Date("2026-01-01T00:00:00Z"),
	});
	assert.equal(learn.machine.os, "unknown-freebsd");
	assert.equal(learn.gates.find(g => g.id === "platform")?.status, "blocked");
});

test("real macOS pass on this machine produces five boot stages and a verified evidence gate", {
	skip: process.platform !== "darwin" || process.env.REIN_LEARN_HOST_TESTS !== "1",
}, async () => {
	const { learn } = await learnMachine({ now: () => new Date("2026-01-01T00:00:00Z") });
	assert.equal(learn.machine.os, "macos");
	assert.equal(learn.bootChain.length, 5);
	assert.ok(learn.machine.model.length > 0);
	assert.ok(learn.probes.every(p => typeof p.detail === "string"));
});
