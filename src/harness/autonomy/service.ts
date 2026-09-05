/** User-owned OS services. Never attaches to or enumerates unrelated processes. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ServiceOptions {
	home: string;
	cliPath: string;
	nodePath?: string;
	platform?: NodeJS.Platform;
	userHome?: string;
	uid?: number;
	/** Test seam; production invokes each argv directly, without a shell. */
	commandRunner?: (command: string, args: string[]) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
}

export interface ServicePlan {
	manager: "launchd" | "systemd" | "foreground";
	path: string;
	content: string;
	installCommands: string[][];
	uninstallCommands: string[][];
}

export interface ServiceResult {
	manager: ServicePlan["manager"];
	path: string;
	installed: boolean;
	active: boolean | null;
	message: string;
}

function absolute(value: string, name: string): string {
	if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be an absolute path without control characters.`);
	return resolve(value);
}

function configuration(options: ServiceOptions) {
	const home = absolute(options.home, "REIN_HOME");
	const userHome = absolute(options.userHome ?? homedir(), "User home");
	const nodePath = absolute(options.nodePath ?? process.execPath, "Node executable");
	const cliPath = absolute(options.cliPath, "Rein bundle");
	const uid = options.uid ?? process.getuid?.();
	const platform = options.platform ?? process.platform;
	if (platform === "darwin" && (!Number.isSafeInteger(uid) || uid! < 0)) throw new Error("A user ID is required for a launchd user agent.");
	const scope = createHash("sha256").update(home).digest("hex").slice(0, 24);
	const label = `dev.rein.autonomy.${scope}`;
	const paths = [dirname(nodePath), join(userHome, ".local", "bin"), ...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	const path = [...new Set(paths.filter(p => isAbsolute(p) && !/[\x00-\x1f\x7f:]/.test(p)))].join(":");
	return { home, userHome, nodePath, cliPath, uid, platform, scope, label, path };
}

function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** systemd quoting is not shell quoting. % expands even inside quotes. */
function unit(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

function signedContent(body: string, scope: string, xmlFormat: boolean): string {
	const marker = `rein-autonomy:${scope}:${createHash("sha256").update(body).digest("hex")}`;
	return `${xmlFormat ? `<!-- ${marker} -->` : `# ${marker}`}\n${body}`;
}

/** Pure plan: no filesystem writes, process probing, or service installation. */
export function servicePlan(options: ServiceOptions): ServicePlan {
	const cfg = configuration(options);
	if (cfg.platform === "darwin") {
		const path = join(cfg.userHome, "Library", "LaunchAgents", `${cfg.label}.plist`);
		const target = `gui/${cfg.uid}/${cfg.label}`;
		const body = `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${cfg.label}</string>
<key>ProgramArguments</key><array>${[cfg.nodePath, cfg.cliPath, "autonomy", "daemon"].map(value => `<string>${xml(value)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(cfg.home)}</string>
<key>EnvironmentVariables</key><dict><key>REIN_HOME</key><string>${xml(cfg.home)}</string><key>PATH</key><string>${xml(cfg.path)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
		return { manager: "launchd", path, content: signedContent(body, cfg.scope, true), installCommands: [["/bin/launchctl", "enable", target], ["/bin/launchctl", "bootstrap", `gui/${cfg.uid}`, path]], uninstallCommands: [["/bin/launchctl", "bootout", target]] };
	}
	if (cfg.platform === "linux") {
		const name = `${cfg.label}.service`;
		const path = join(cfg.userHome, ".config", "systemd", "user", name);
		const body = `[Unit]
Description=Rein autonomy supervisor
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${unit(cfg.home)}
Environment=${unit(`REIN_HOME=${cfg.home}`)}
Environment=${unit(`PATH=${cfg.path}`)}
# The ':' executable prefix disables dollar expansion in every argument.
ExecStart=${unit(`:${cfg.nodePath}`)} ${unit(cfg.cliPath)} autonomy daemon
Restart=on-failure
RestartSec=30
TimeoutStopSec=30
KillMode=control-group
UMask=0077
# The daemon maintains bounded history in REIN_HOME; do not grow service logs.
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
`;
		return { manager: "systemd", path, content: signedContent(body, cfg.scope, false), installCommands: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", name], ["systemctl", "--user", "restart", name]], uninstallCommands: [["systemctl", "--user", "disable", "--now", name], ["systemctl", "--user", "daemon-reload"]] };
	}
	return { manager: "foreground", path: "", content: "", installCommands: [], uninstallCommands: [] };
}

function ownedContent(path: string, options: ServiceOptions): string | undefined {
	const cfg = configuration(options);
	let directory = dirname(path);
	for (;;) {
		try {
			const stat = lstatSync(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error(`Service directory must be private and cannot be a symlink: ${directory}`);
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (directory === cfg.userHome) break;
		const parent = dirname(directory);
		if (parent === directory) throw new Error("Service path must be within the user home directory.");
		directory = parent;
	}
	let fd: number;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to modify a service path that is not a regular file: ${path}`);
		fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		const uid = options.uid ?? process.getuid?.();
		if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o022) || (uid !== undefined && stat.uid !== uid)) throw new Error(`Service file is not privately owned by the current user: ${path}`);
		const text = readFileSync(fd, "utf8");
		const boundary = text.indexOf("\n");
		const body = text.slice(boundary + 1);
		if (boundary < 0 || text !== signedContent(body, cfg.scope, cfg.platform === "darwin")) throw new Error(`Refusing to overwrite or delete a modified or unrelated service file: ${path}`);
		return text;
	} finally { closeSync(fd); }
}

function prepareDirectory(path: string, userHome: string): void {
	// Do not follow a symlink installed in a service configuration directory.
	const components = relative(userHome, path).split("/");
	let current = userHome;
	for (const component of components) {
		current = join(current, component);
		try { mkdirSync(current, { mode: 0o700 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		const stat = lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error(`Service directory must be private and cannot be a symlink: ${current}`);
	}
}

function run(options: ServiceOptions, command: string[], timeoutMs = 15_000) {
	return options.commandRunner ? options.commandRunner(command[0], command.slice(1)) : spawnSync(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 32 * 1024 });
}

function checkedRun(options: ServiceOptions, command: string[]): void {
	const result = run(options, command);
	if (result.status !== 0 || result.error) throw new Error(`${command[0]} ${command.slice(1).join(" ")} failed: ${String(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 1000)}. You can run rein autonomy daemon in the foreground.`);
}

function foreground(): ServiceResult {
	return { manager: "foreground", path: "", installed: false, active: false, message: "This platform has no supported user-service manager. Run rein autonomy daemon in the foreground." };
}

/** Synchronous; inspects only Rein's exact scoped service. */
export function serviceStatus(options: ServiceOptions): ServiceResult {
	const plan = servicePlan(options);
	if (plan.manager === "foreground") return foreground();
	const installed = ownedContent(plan.path, options) !== undefined;
	if (!installed) return { manager: plan.manager, path: plan.path, installed, active: false, message: "Autonomy service is not installed." };
	const cfg = configuration(options);
	const command = plan.manager === "launchd" ? ["/bin/launchctl", "print", `gui/${cfg.uid}/${cfg.label}`] : ["systemctl", "--user", "is-active", basename(plan.path)];
	const result = run(options, command, 1000);
	let active: boolean | null = null;
	if (!result.error && result.status === 0) active = plan.manager === "systemd" || /\bstate\s*=\s*running\b/.test(result.stdout ?? "");
	else if (!result.error && ((plan.manager === "systemd" && (result.status === 3 || result.status === 4)) || /could not find service|service not found/i.test(result.stderr ?? ""))) active = false;
	const detail = String(result.error?.message || result.stderr || "").trim().slice(0, 500);
	return { manager: plan.manager, path: plan.path, installed, active, message: active === true ? "Autonomy service is running." : active === false ? "Autonomy service is installed but stopped." : `Autonomy service is installed; service manager status is unavailable${detail ? `: ${detail}` : "."}` };
}

/** Allow asynchronous user-service startup without treating an installed file as a running daemon. */
export async function waitForService(options: ServiceOptions, initial: ServiceResult, polling: { timeoutMs?: number; intervalMs?: number } = {}): Promise<ServiceResult> {
	const timeout = Math.min(5000, Math.max(0, polling.timeoutMs ?? 3000));
	const interval = Math.min(500, Math.max(10, polling.intervalMs ?? 250));
	const deadline = Date.now() + timeout;
	let result = initial;
	while (result.installed && result.active !== true && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))));
		result = serviceStatus(options);
	}
	return result;
}

/** Synchronous; call only for an explicit service-install action. */
export function installService(options: ServiceOptions): ServiceResult {
	const plan = servicePlan(options);
	if (plan.manager === "foreground") return foreground();
	const cfg = configuration(options);
	const previous = ownedContent(plan.path, options);
	prepareDirectory(dirname(plan.path), cfg.userHome);
	mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
	if (previous !== undefined && plan.manager === "launchd") {
		const result = run(options, plan.uninstallCommands[0]);
		if ((result.status !== 0 || result.error) && !/could not find service|no such process|service not found/i.test(result.stderr ?? "")) throw new Error(`Cannot unload the existing Rein service: ${result.error?.message || result.stderr || result.status}`);
	}
	const temp = `${plan.path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, plan.content, { flag: "wx", mode: 0o600 });
		// Revalidate immediately before replacing a prior service file.
		if (ownedContent(plan.path, options) !== previous) throw new Error("The Rein service file changed while installing; retry the command.");
		renameSync(temp, plan.path);
	} finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
	for (const command of plan.installCommands) checkedRun(options, command);
	const status = serviceStatus(options);
	return status.active === false ? { ...status, message: "Autonomy service registered. It may still be starting; check rein autonomy status." } : status;
}

/** Synchronous; leaves a file in place if the service could not be stopped. */
export function uninstallService(options: ServiceOptions): ServiceResult {
	const plan = servicePlan(options);
	if (plan.manager === "foreground") return foreground();
	const previous = ownedContent(plan.path, options);
	if (previous === undefined) return { manager: plan.manager, path: plan.path, installed: false, active: false, message: "Autonomy service is not installed." };
	const result = run(options, plan.uninstallCommands[0]);
	const absent = plan.manager === "launchd" && /could not find service|no such process|service not found/i.test(result.stderr ?? "");
	if ((result.status !== 0 || result.error) && !absent) throw new Error(`Cannot stop the Rein service; its file was kept: ${result.error?.message || result.stderr || result.status}`);
	if (ownedContent(plan.path, options) !== previous) throw new Error("The Rein service file changed while uninstalling; its file was kept.");
	unlinkSync(plan.path);
	for (const command of plan.uninstallCommands.slice(1)) checkedRun(options, command);
	return { manager: plan.manager, path: plan.path, installed: false, active: false, message: "Autonomy service stopped and uninstalled." };
}
