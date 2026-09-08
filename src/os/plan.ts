/** Platform planning does not change disks, firmware, accounts, or services. */
import type { HardwareProfile } from "../hardware/profile.ts";

export const OMARCHY_BASE = {
	repository: "https://github.com/omacom/omarchy.git",
	tag: "v4.0.2",
	commit: "346e69e1cec6c4e8924531874af6ba010a1bc99e",
	installation: "https://github.com/omacom/omarchy/blob/v4.0.2/manual/02-getting-started.md",
	macSupport: "https://github.com/omacom/omarchy/blob/v4.0.2/manual/44-mac-support.md",
	unattended: "https://github.com/omacom/omarchy/blob/v4.0.2/manual/51-unattended-installs.md",
} as const;

export interface OSGate { id: string; status: "required" | "blocked"; detail: string }
export interface ReinOSPlan {
	schemaVersion: 1;
	mode: "host" | "image";
	platform: { os: string; arch: string };
	status: "candidate" | "unsupported";
	adapter: string;
	runtimes: string[];
	facts: string[];
	gates: OSGate[];
	next: string[];
	sources: string[];
}

export function planReinOS(profile: HardwareProfile, options: { mode?: "host" | "image"; chromeos?: boolean } = {}): ReinOSPlan {
	if (!profile || typeof profile.os !== "string" || typeof profile.arch !== "string" ||
		!Array.isArray(profile.gpus) || !profile.gpus.every(gpu => gpu && typeof gpu === "object")) {
		throw new Error("A hardware profile with OS, architecture, and GPUs is required.");
	}
	const mode = options.mode ?? "host";
	if (mode !== "host" && mode !== "image") throw new Error("OS mode must be host or image.");
	const chromeos = options.chromeos === true;
	const platform = { os: profile.os, arch: profile.arch };
	const recognized = ["darwin", "linux", "win32"].includes(profile.os) && ["x64", "arm64"].includes(profile.arch);
	const apple = profile.os === "darwin" && profile.arch === "arm64";
	const plan: ReinOSPlan = {
		schemaVersion: 1, mode, platform, status: recognized ? "candidate" : "unsupported",
		adapter: "unsupported", runtimes: [], facts: [], gates: [], next: [], sources: [],
	};
	if (mode === "host") {
		plan.adapter = !recognized ? "unsupported" : profile.os === "darwin" ? "macos-native" : profile.os === "win32" ? "windows-with-wsl2" : "linux-native";
		plan.runtimes = !recognized ? [] : apple ? ["MLX", "llama.cpp (Metal)", "existing OpenAI-compatible server"] :
			["llama.cpp", "existing OpenAI-compatible server"];
		if (recognized && profile.os === "linux" && profile.gpus.some(gpu => gpu.vendor === "nvidia" || gpu.vendor === "amd")) {
			plan.runtimes.push("vLLM (verify GPU, driver, and runtime compatibility)");
		}
		plan.facts.push("Host mode keeps the installed OS. Runtime names are candidates, not installed or benchmarked capabilities.");
		plan.facts.push("Platform components ship in the same bundle: the Rainmeter-rebuilt terminal skin engine (rein os skin) and the Argent-rebuilt device toolkit (rein argent). Both are offline; device targets beyond the terminal provider are parity gates.");
		if (apple) {
			plan.facts.push("Apple Silicon uses native macOS and its shared memory pool; an Omarchy Linux replacement is a separate hardware port.");
			plan.sources.push("https://github.com/ml-explore/mlx-lm", OMARCHY_BASE.macSupport);
		}
		if (profile.os === "win32") {
			plan.facts.push("The full terminal harness needs Bash and tmux. WSL2 is the planned execution backend; its presence and GPU forwarding are unverified.");
			plan.gates.push({ id: "wsl2", status: "required", detail: "Confirm WSL2 and a Linux distribution, then run Rein's hardware and connection checks inside that distribution." });
			plan.sources.push("https://learn.microsoft.com/en-us/windows/wsl/install");
		}
		if (chromeos && profile.os === "linux") {
			plan.adapter = "chromeos-userland";
			plan.facts.push("ChromeOS reports as linux to the harness. The overlay installs only into the chronos user's home; the verified (dm-verity) root and A/B partitions stay untouched.");
			plan.facts.push("ChromeOS user data (My Files) lives under /home/chronos/user/<id>; export it with rein export before any OS-level change.");
			plan.gates.push(
				{ id: "developer-mode", status: "required", detail: "Enable developer mode and confirm the arc shell with a Node 18+ environment inside it." },
				{ id: "backup", status: "required", detail: "Run rein export presets (or rein export browse) to an external drive before any OS-level change." },
			);
			plan.sources.push("https://chromium.googlesource.com/chromiumos/docs/+/HEAD/developer_mode.md");
			plan.next = ["rein export presets --to <external-drive>", "rein os prepare --target chromeos --output ./rein-os-kit"];
		}
		plan.gates.push(
			{ id: "dependencies", status: recognized ? "required" : "blocked", detail: recognized ? "Verify Node, Git, Bash, tmux, Python, and zstd in the actual execution environment." : "No Dareecho host adapter is defined for this OS and architecture." },
			{ id: "runtime", status: "required", detail: "Check driver/runtime versions and available memory; benchmark the selected model with its real context and tool protocol." },
			{ id: "autonomy", status: "required", detail: "Configure the headless helper and resource limits before explicitly enabling its user service." },
		);
		plan.next.push("rein hardware", "rein setup");
	} else {
		const candidate = recognized && profile.arch === "x64";
		plan.status = candidate ? "candidate" : "unsupported";
		plan.adapter = "omarchy-x86_64-vm-overlay";
		plan.runtimes = ["llama.cpp", "existing OpenAI-compatible server", "vLLM after GPU validation"];
		plan.facts.push("The preparation command exports a Dareecho overlay for an installed Omarchy VM. It does not build a bootable ISO or certify this machine for installation.");
		plan.facts.push(`The reviewed Omarchy base is ${OMARCHY_BASE.tag} (${OMARCHY_BASE.commit}). Its supported installation starts with the upstream ISO.`);
		if (!candidate) {
			plan.facts.push(apple ? "Omarchy does not directly support M-series Macs. Native macOS is the current path; a Linux port depends on model-specific Asahi support." : "This preparation path targets x86-64 PCs and VMs. No image target is defined for this OS and architecture.");
			plan.gates.push({ id: "architecture", status: "blocked", detail: "Use a separate x86-64 VM target for this kit; staging files on this computer does not make it a supported installation target." });
		}
		if (profile.os === "darwin" && profile.arch === "x64") plan.facts.push("Intel Mac support has model-specific driver and boot limitations. The versioned Mac guide describes replacing macOS; do not infer dual-boot support from the general PC guide.");
		plan.gates.push(
			{ id: "hardware", status: "required", detail: "Verify the target's firmware boot mode, graphics, storage, network, input devices, and upstream hardware support. CPU architecture alone is insufficient." },
			{ id: "media", status: "required", detail: "Acquire and verify the upstream installation ISO separately. The source commit pins reviewed code, not an ISO checksum." },
			{ id: "vm", status: "required", detail: "Install Omarchy in a disposable x86-64 VM using its wizard and only that VM's virtual disk, then apply and test the Dareecho overlay." },
			{ id: "migration", status: "required", detail: "Before any physical-machine installation, review backups, recovery, exact target disk, encryption, and owner approval in a separate installer." },
		);
		plan.sources.push(OMARCHY_BASE.installation, OMARCHY_BASE.macSupport, OMARCHY_BASE.unattended);
		if (apple) plan.sources.push("https://asahilinux.org/docs/platform/feature-support/overview/");
		plan.next.push("rein os prepare --output ./rein-os-kit", "Follow the generated README.md to install and validate in a disposable VM.");
	}
	return plan;
}

export function formatReinOSPlan(plan: ReinOSPlan): string {
	return [
		`Dareecho ${plan.mode}: ${plan.status} (${plan.platform.os}/${plan.platform.arch})`,
		`Adapter: ${plan.adapter}`,
		...(plan.runtimes.length ? [`Runtime candidates: ${plan.runtimes.join(", ")}`] : []),
		...plan.facts.map(fact => `- ${fact}`),
		...plan.gates.map(gate => `[${gate.status}] ${gate.id}: ${gate.detail}`),
		...plan.next.map(step => `Next: ${step}`),
	].join("\n");
}
