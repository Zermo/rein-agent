/** The Rainmeter rebuild: what upstream is, what Dareecho rebuilt, and what stays a gate. */

export const RAINMETER_BASE = {
	repository: "https://github.com/rainmeter/rainmeter.git",
	commit: "be2afe7eb8ff485e77394ded07943b357207a3e0",
	commitDate: "2026-09-07",
	license: "GPL-2.0",
	homepage: "https://rainmeter.net/",
} as const;

export type RebuildStatus = "implemented" | "mapped" | "gate";

export interface RainmeterModule {
	/** Upstream Rainmeter component (path in the pinned tree). */
	upstream: string;
	/** What it does in Rainmeter. */
	role: string;
	/** The Dareecho rebuild, or the existing harness component it maps onto. */
	rebuild: string;
	status: RebuildStatus;
}

export const RAINMETER_MODULES: RainmeterModule[] = [
	{ upstream: "Application/ (Rainmeter.exe host, tray, command handler)", role: "Windows host process that owns skins", rebuild: "`rein os` terminal host; `rein os skin render` owns the skin session", status: "implemented" },
	{ upstream: "Library/ConfigParser.cpp, Skin.cpp, Section.cpp", role: "INI skin model, sections, variables", rebuild: "src/os/skin/parser.ts", status: "implemented" },
	{ upstream: "Library/Measure*.cpp (~50 measures: Time, Uptime, SysInfo, Calc, Loop, String, CPU, Net, Ping, WebParser, Registry, NowPlaying, ...)", role: "value providers", rebuild: "src/os/skin/measures.ts (Time, Uptime, SysInfo, String, Loop, Calc)", status: "implemented" },
	{ upstream: "Library/Meter*.cpp (String, Bar, Gauge-style, Line, Bitmap, Shape, Svg, TextEdit, ...)", role: "visual widgets", rebuild: "src/os/skin/meters.ts (String, Bar, Gauge, Line)", status: "implemented" },
	{ upstream: "Library/IfActions.cpp", role: "conditional meter behavior", rebuild: "meter IfMeasureName/IfCondition (hidden on false)", status: "implemented" },
	{ upstream: "Library/SkinInstaller.cpp, SkinRegistry.cpp", role: "install and enumerate skins", rebuild: "src/os/skin/install.ts (`rein os skin install|list`)", status: "implemented" },
	{ upstream: "Build/Skins/illustro (bundled skin)", role: "reference skin set", rebuild: "src/os/assets/skins/dareecho.ini (terminal dashboard skin)", status: "implemented" },
	{ upstream: "Library/UpdateCheck.cpp", role: "self-update check", rebuild: "`rein update`", status: "implemented" },
	{ upstream: "Library/LuaBinding*.cpp, MeasureScript.cpp, MeasureRunCommand.cpp", role: "scripting measures", rebuild: "the Rein agent itself: `rein -p` / `rein loop` as the script surface", status: "mapped" },
	{ upstream: "Library/RainmeterAPI.h, RainmeterQuery.h, PluginAPI/ (plugin SDK)", role: "C DLL plugin extension point", rebuild: "Rein's tool protocol (AgentTool) as the extension point", status: "mapped" },
	{ upstream: "Library/GameMode.cpp (DWM occlusion suppression)", role: "low-impact desktop mode", rebuild: "REIN_REDUCED_MOTION keeps skin previews static", status: "mapped" },
	{ upstream: "ThirdParty/ (fmt, rapidjson, luajit, pcre, zlib, kiss_fft, ...)", role: "C++ dependencies", rebuild: "Node builtins (JSON, node:zlib, Intl); no new runtime dependencies", status: "mapped" },
	{ upstream: "Library/MeasureCPU/Net/Ping/WebParser/Registry/NowPlaying/CoreTemp, Library/taglib, Library/CoreTemp", role: "Windows API and media measures", rebuild: "deferred: Windows-only system APIs with no terminal equivalent in this rebuild", status: "gate" },
	{ upstream: "Library/MeterBitmap/Shape/Svg/TextEdit/Rotator", role: "raster and vector meters", rebuild: "deferred: the terminal surface renders text; bitmap/vector meters need a desktop stage", status: "gate" },
	{ upstream: "Library/SkinPosition.cpp, SkinSelectionOverlay.cpp, SkinDropTarget.cpp, ContextMenu.cpp, TrayIcon.cpp", role: "desktop placement, drag and tray", rebuild: "deferred: terminal skins lay out linearly; placement is a desktop-integration gate", status: "gate" },
	{ upstream: "RainLexer/ (editor syntax lexer)", role: "skin file syntax highlighting for editors", rebuild: "deferred: editor integration; the parser's own errors already locate skin mistakes", status: "gate" },
	{ upstream: "Language/ (localization)", role: "translated UI strings", rebuild: "deferred: the operator profile carries working-language preferences instead", status: "gate" },
];

export const RAINMETER_GATES = [
	"Clean-room rebuild: no GPL-2.0 Rainmeter code is copied into this MIT harness. The pinned commit is the reviewed source, the way Omarchy is pinned.",
	"Upstream is a Windows (Win32) desktop tool; this rebuild expresses its skin model in the terminal, preserving the running OS exactly like the Omarchy and ChromeOS kits.",
	"Windows-API measures (CPU, Net, Ping, WebParser, Registry, NowPlaying) and raster/vector meters are parity gates, not claims: they need their own validation before they count as rebuilt.",
];

export interface RainmeterReport {
	schemaVersion: 1;
	base: typeof RAINMETER_BASE;
	modules: RainmeterModule[];
	gates: string[];
	commands: string[];
}

export function rainmeterReport(): RainmeterReport {
	return {
		schemaVersion: 1,
		base: RAINMETER_BASE,
		modules: RAINMETER_MODULES,
		gates: RAINMETER_GATES,
		commands: [
			"rein os skin render src/os/assets/skins/dareecho.ini",
			"rein os skin render src/os/assets/skins/dareecho.ini --frames 16",
			"rein os skin install <skin-directory>",
			"rein os skin list",
		],
	};
}

export function formatRainmeterReport(report: RainmeterReport): string {
	const count = (status: RebuildStatus) => report.modules.filter(module => module.status === status).length;
	return [
		`Rainmeter rebuild for Dareecho`,
		`Pinned: ${report.base.repository} @ ${report.base.commit} (${report.base.commitDate}, ${report.base.license})`,
		`Modules: ${report.modules.length} upstream components — ${count("implemented")} implemented, ${count("mapped")} mapped onto existing harness parts, ${count("gate")} deferred gates`,
		"",
		...report.modules.flatMap(module => [
			`  [${module.status.toUpperCase().padEnd(11)}] ${module.upstream}`,
			`      role:    ${module.role}`,
			`      rebuild: ${module.rebuild}`,
		]),
		"",
		"Gates:",
		...report.gates.map(gate => `  - ${gate}`),
		"",
		"Try it:",
		...report.commands.map(command => `  ${command}`),
	].join("\n");
}
