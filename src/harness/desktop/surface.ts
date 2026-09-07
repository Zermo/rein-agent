/** Desktop surfaces are optional; never change the OS terminal default. */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { shellQuote } from "../tmux.ts";

const exec = promisify(execFile);
export const REIN_AGENT_ID = "custom:749611bd-a3c7-4b35-b0e1-70cf837648b2";
export const desktopHome = () => resolve(process.env.REIN_HOME || join(homedir(), ".rein"));
export function remoteDesktopSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return !!(env.SSH_CONNECTION || env.SSH_TTY || /[/\\]\.nodeterm[/\\]hook-endpoint-[^/\\]+\.env$/.test(env.NODETERM_HOOK_ENDPOINT ?? ""));
}
export function desktopAvailable(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
	return platform === "darwin" && !env.CI && !remoteDesktopSession(env);
}
export function nativeApp(home = homedir()): string | undefined {
	return [join(home, "Applications/nodeterm.app"), "/Applications/nodeterm.app"].find(path => existsSync(join(path, "Contents/MacOS/nodeterm")));
}
export type DesktopSurface = "klaud" | "nodeterm" | "terminal";
function preferencesFile(home: string): string {
	const file = join(home, "desktop.json");
	if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Desktop preferences must not be a symlink.");
	return file;
}
export function preferredSurface(home = desktopHome()): DesktopSurface {
	const file = preferencesFile(home);
	try {
		const surface = JSON.parse(readFileSync(file, "utf8"))?.surface;
		return surface === "nodeterm" || surface === "terminal" ? surface : "klaud";
	} catch { return "klaud"; }
}
export function preferSurface(surface: DesktopSurface, home = desktopHome()) {
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const file = preferencesFile(home);
	const temp = `${file}.${randomUUID()}.tmp`;
	try { writeFileSync(temp, JSON.stringify({ surface }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); renameSync(temp, file); }
	finally { if (existsSync(temp)) unlinkSync(temp); }
}

export async function nodeTermRunning(): Promise<boolean> {
	try { await exec("pgrep", ["-x", "nodeterm"], { timeout: 3000 }); return true; }
	catch (error: any) { return error.code !== 1; } // Unknown process state is not permission to rewrite settings.
}
export function registeredSettings(current: unknown, launchCmd: string): Record<string, unknown> {
	if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("NodeTerm settings are not a JSON object.");
	const settings = current as Record<string, any>;
	if (settings.customAgents !== undefined && !Array.isArray(settings.customAgents)) throw new Error("Unrecognized NodeTerm custom-agent settings.");
	if (settings.disabledAgents !== undefined && !Array.isArray(settings.disabledAgents)) throw new Error("Unrecognized NodeTerm disabled-agent settings.");
	const customAgents = (settings.customAgents ?? []).filter((agent: any) => agent?.id !== REIN_AGENT_ID);
	customAgents.push({ id: REIN_AGENT_ID, label: "Rein", launchCmd, promptInjectionMode: "stdin-after-start", color: "#b6472d" });
	return { ...settings, customAgents, defaultAgent: REIN_AGENT_ID,
		...(settings.disabledAgents ? { disabledAgents: settings.disabledAgents.filter((id: unknown) => id !== REIN_AGENT_ID) } : {}) };
}
export async function registerRein(options: { settingsFile?: string; running?: () => Promise<boolean>; node?: string; cli?: string } = {}): Promise<string> {
	const running = options.running ?? nodeTermRunning;
	if (await running()) return "NodeTerm is running, so its settings were preserved. Close it when convenient and run rein desktop install --no-launch to register Rein as the default agent. For now, run rein --terminal in a NodeTerm terminal node.";
	const file = options.settingsFile ?? join(homedir(), "Library/Application Support/node-terminal/settings.json");
	if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error("NodeTerm settings must be an ordinary file.");
	const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
	// NodeTerm uses a login shell; resolve the current Node there, not an upgrade-sensitive Cellar path.
	const command = [options.node ?? "node", options.cli ?? resolve(process.argv[1]), "--terminal"].map(shellQuote).join(" ");
	const next = registeredSettings(before === undefined ? {} : JSON.parse(before), command);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		if (await running() || (existsSync(file) ? readFileSync(file, "utf8") : undefined) !== before) throw new Error("NodeTerm settings changed during registration. Close the app and retry.");
		renameSync(temp, file);
	} finally { if (existsSync(temp)) unlinkSync(temp); }
	return "Rein is registered as NodeTerm's default agent. Open a project and add an agent node to start Rein.";
}
export async function openNodeTerm(app = nativeApp()): Promise<void> {
	if (!app) throw new Error("NodeTerm is not installed. Run rein desktop install, or use rein --terminal.");
	await exec("open", ["-a", app], { timeout: 10_000 });
}
export function shouldOpenDesktop(input: { requested?: boolean; terminal?: boolean; visual?: boolean; activity?: string; hasSessionOptions?: boolean; interactive: boolean; insideNodeTerm: boolean; available: boolean; preference: string }): boolean {
	// Saved preferences from older installers never move a new chat out of its terminal.
	return input.requested === true && input.interactive && !input.hasSessionOptions && !input.terminal && input.visual === undefined && !input.activity && !input.insideNodeTerm && input.available && input.preference === "nodeterm";
}
