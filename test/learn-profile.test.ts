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

test("real macOS pass on this machine produces five boot stages and a verified evidence gate", async () => {
	if (process.platform !== "darwin") return;
	const { learn } = await learnMachine({ now: () => new Date("2026-01-01T00:00:00Z") });
	assert.equal(learn.machine.os, "macos");
	assert.equal(learn.bootChain.length, 5);
	assert.ok(learn.machine.model.length > 0);
	assert.ok(learn.probes.every(p => typeof p.detail === "string"));
});
