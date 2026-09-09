/** The Argent rebuild: what upstream is, what the harness rebuilt, and what stays a gate. */

export const ARGENT_BASE = {
	repository: "https://github.com/software-mansion/argent.git",
	commit: "aa90873b59b1aa75332e949f28d9f905cac34d04",
	commitDate: "2026-09-07",
	package: "@swmansion/argent",
	version: "0.24.0",
	license: "Apache-2.0",
	homepage: "https://argent.swmansion.com",
} as const;

export type ArgentStatus = "implemented" | "mapped" | "gate";

export interface ArgentComponent {
	/** Upstream Argent package or capability (pinned tree). */
	upstream: string;
	/** What it does in Argent. */
	role: string;
	/** The harness rebuild, or the existing component it maps onto. */
	rebuild: string;
	status: ArgentStatus;
}

export const ARGENT_COMPONENTS: ArgentComponent[] = [
	{ upstream: "packages/device-providers (contract.ts, read.ts, write.ts, schema v1)", role: "frozen external device-provider contract (ext: ids, capability tokens)", rebuild: "src/argent/contract.ts (same schema version, id shapes, and degrade-to-empty discovery)", status: "implemented" },
	{ upstream: "packages/argent-cli (flow.ts, run.ts, tools.ts, providers.ts)", role: "record & replay flows with pass/fail/skip/error step reports", rebuild: "src/argent/flows.ts (strict parse, replay, step reports)", status: "implemented" },
	{ upstream: "packages/argent-mcp (mcp-server.ts, tool-mapping.ts)", role: "MCP tool surface for AI assistants", rebuild: "Rein's tool protocol: the agent itself is the assistant, tools are its harness tools", status: "mapped" },
	{ upstream: "packages/tool-server + packages/argent-tools-client", role: "long-running device tool server over a local endpoint", rebuild: "`rein serve` loopback API as the long-running surface; flows run in-process today", status: "mapped" },
	{ upstream: "packages/argent (visual regression: screenshot diff, OCR/font-aware compare)", role: "diff screenshots against baselines", rebuild: "src/argent/png.ts (pure-TS PNG encode/decode + threshold diff + bounding box)", status: "implemented" },
	{ upstream: "packages/argent (iOS simulators and physical iPhones: touch, gesture, hardware keys)", role: "drive iOS through simctl/XCUITest", rebuild: "deferred: needs Xcode and a simulator host; the contract and flow layer are device-agnostic", status: "gate" },
	{ upstream: "packages/argent + packages/native-devtools-android (AVDs and physical devices over adb)", role: "drive Android through adb", rebuild: "deferred: needs adb and an emulator; provider files can already advertise these devices", status: "gate" },
	{ upstream: "packages/argent (Apple TV, Android TV, Fire TV: D-pad and remote)", role: "drive TV remotes", rebuild: "deferred: TV remotes are a later provider; the capability vocabulary covers them", status: "gate" },
	{ upstream: "packages/argent (Electron/Chromium over CDP: tabs, cookies, DOM, network)", role: "drive desktop and web apps", rebuild: "deferred: the Obscura web surface is a separate kit; CDP providers are a later stage", status: "gate" },
	{ upstream: "packages/argent (React Native out of the box: build, launch, iterate)", role: "native RN workflow support", rebuild: "the terminal provider drives any CLI, including RN build and test loops", status: "mapped" },
	{ upstream: "packages/argent (profiling: Hermes, React DevTools, Instruments, Perfetto)", role: "record and analyze profiling sessions", rebuild: "deferred: profiling analysis needs the native toolchains; flows can run the profilers today", status: "gate" },
	{ upstream: "packages/registry, packages/configuration-core, packages/telemetry, packages/update-core", role: "shared registry, config, telemetry, updates", rebuild: "Rein's config (~/.rein), budgets, and `rein update` carry the equivalent responsibilities", status: "mapped" },
	{ upstream: "packages/ios-device-runner, packages/preview-window, packages/skills", role: "device runner, preview window, bundled skills", rebuild: "deferred: desktop preview windows are a UI gate; skills map onto `rein skills`", status: "gate" },
];

export const ARGENT_GATES = [
	"Clean-room rebuild: no upstream code is copied into this harness. The pinned commit is the reviewed source; the Apache-2.0 license is recorded for provenance.",
	"Device targets (iOS, Android, TV, desktop/CDP) are parity gates: the contract, flows, and diffing are device-agnostic, and a target counts as supported only when a real device has been driven end to end.",
	"OCR- and font-aware comparison is upstream behavior; this rebuild's diff is per-channel pixel comparison with a threshold and bounding box. Do not treat the two as equivalent evidence.",
];

export interface ArgentReport {
	schemaVersion: 1;
	base: typeof ARGENT_BASE;
	components: ArgentComponent[];
	gates: string[];
	commands: string[];
}

export function argentReport(): ArgentReport {
	return {
		schemaVersion: 1,
		base: ARGENT_BASE,
		components: ARGENT_COMPONENTS,
		gates: ARGENT_GATES,
		commands: [
			"rein argent status",
			"rein argent rebuild",
			"rein argent flow validate <flow.json>",
			"rein argent flow run <flow.json> [--pane <session-id>]",
			"rein argent screenshot --out shot.png",
			"rein argent diff baseline.png actual.png --threshold 12",
		],
	};
}

export function formatArgentReport(report: ArgentReport): string {
	const count = (status: ArgentStatus) => report.components.filter(component => component.status === status).length;
	return [
		`Argent toolkit rebuild for the harness and Dareecho`,
		`Pinned: ${report.base.repository} @ ${report.base.commit} (${report.base.commitDate})`,
		`Upstream: ${report.base.package}@${report.base.version} (${report.base.license})`,
		`Components: ${report.components.length} — ${count("implemented")} implemented, ${count("mapped")} mapped onto existing harness parts, ${count("gate")} deferred gates`,
		"",
		...report.components.flatMap(component => [
			`  [${component.status.toUpperCase().padEnd(11)}] ${component.upstream}`,
			`      role:    ${component.role}`,
			`      rebuild: ${component.rebuild}`,
		]),
		"",
		"Gates:",
		...report.gates.map(gate => `  - ${gate}`),
		"",
		"Try it:",
		...report.commands.map(command => `  ${command}`),
	].join("\n");
}
