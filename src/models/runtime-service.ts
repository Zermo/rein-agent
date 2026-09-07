/** Explicit, per-model user services. Never attaches to unrelated processes. */
import { spawnSync } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { verifyInstalledModel } from "./artifacts.ts";
import { servingPlan, validateModelId, type ServingOptions } from "./runtime.ts";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ModelServiceOptions extends ServingOptions {
	id: string;
	signal?: AbortSignal;
	/** Artifact verification seam for local fixture tests. */
	verify?: typeof verifyInstalledModel;
	home: string;
	cliPath: string;
	nodePath?: string;
	platform?: NodeJS.Platform;
	userHome?: string;
	uid?: number;
	/** Test seam; production invokes each argv directly, without a shell. */
	commandRunner?: (command: string, args: string[]) => { status: number | null; stdout?: string; stderr?: string; error?: Error };
}

export interface ModelServicePlan {
	manager: "launchd" | "systemd" | "foreground";
	path: string;
	content: string;
	installCommands: string[][];
	uninstallCommands: string[][];
}

export interface ModelServiceResult {
	manager: ModelServicePlan["manager"];
	path: string;
	installed: boolean;
	active: boolean | null;
	message: string;
}

function absolute(value: string, name: string): string {
	if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be an absolute path without control characters.`);
	return resolve(value);
}

function configuration(options: ModelServiceOptions, requireRuntime = false) {
	const home = absolute(options.home, "REIN_HOME");
	const userHome = absolute(options.userHome ?? homedir(), "User home");
	const nodePath = absolute(options.nodePath ?? process.execPath, "Node executable");
	const cliPath = absolute(options.cliPath, "Rein bundle");
	const uid = options.uid ?? process.getuid?.();
	const platform = options.platform ?? process.platform;
	if (platform === "darwin" && (!Number.isSafeInteger(uid) || uid! < 0)) throw new Error("A user ID is required for a launchd user agent.");
	const id = validateModelId(options.id);
	const runtime = requireRuntime || options.runtime ? absolute(options.runtime ?? "", "Model runtime (--runtime)") : "";
	const plan = servingPlan({ artifact: { id, repo: "synthetic/local", sizeBytes: 1 } as any, path: join(home, "models", "artifacts", id, "model.gguf"), installedAt: "" }, options);
	const scope = createHash("sha256").update(`${home}\0${id}`).digest("hex").slice(0, 24);
	const label = `dev.rein.model.${scope}`;
	const paths = [dirname(nodePath), join(userHome, ".local", "bin"), ...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	const path = [...new Set(paths.filter(p => isAbsolute(p) && !/[\x00-\x1f\x7f:]/.test(p)))].join(":");
	const arguments_ = ["model", "serve", id, "--runtime", runtime, "--port", String(plan.port), "--context", String(plan.context), "--gpu-layers", String(plan.gpuLayers), ...(options.threads === undefined ? [] : ["--threads", String(options.threads)])];
	// The desktop app's executable is also its bundled Node runtime. Persist
	// Node mode for service-manager restarts, which do not inherit the app env.
	const electronNode = Boolean(process.versions.electron) && nodePath === resolve(process.execPath);
	return { home, userHome, nodePath, cliPath, uid, platform, scope, label, path, arguments_, electronNode };
}

function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** systemd quoting is not shell quoting. % expands even inside quotes. */
function unit(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

function signedContent(body: string, scope: string, xmlFormat: boolean): string {
	const marker = `rein-model-service:${scope}:${createHash("sha256").update(body).digest("hex")}`;
	return `${xmlFormat ? `<!-- ${marker} -->` : `# ${marker}`}\n${body}`;
}

/** Pure plan: no filesystem writes, process probing, or service installation. */
export function modelServicePlan(options: ModelServiceOptions, inspect = false): ModelServicePlan {
	const platform = options.platform ?? process.platform;
	const cfg = configuration(options, !inspect && ["darwin", "linux"].includes(platform));
	if (cfg.platform === "darwin") {
		const path = join(cfg.userHome, "Library", "LaunchAgents", `${cfg.label}.plist`);
		const target = `gui/${cfg.uid}/${cfg.label}`;
		const body = `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${cfg.label}</string>
<key>ProgramArguments</key><array>${[cfg.nodePath, cfg.cliPath, ...cfg.arguments_].map(value => `<string>${xml(value)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(cfg.home)}</string>
<key>EnvironmentVariables</key><dict><key>REIN_HOME</key><string>${xml(cfg.home)}</string><key>PATH</key><string>${xml(cfg.path)}</string>${cfg.electronNode ? "<key>ELECTRON_RUN_AS_NODE</key><string>1</string>" : ""}</dict>
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
Description=Rein model server
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${unit(cfg.home)}
Environment=${unit(`REIN_HOME=${cfg.home}`)}
Environment=${unit(`PATH=${cfg.path}`)}${cfg.electronNode ? '\nEnvironment="ELECTRON_RUN_AS_NODE=1"' : ""}
# The ':' executable prefix disables dollar expansion in every argument.
ExecStart=${unit(`:${cfg.nodePath}`)} ${unit(cfg.cliPath)} ${cfg.arguments_.map(unit).join(" ")}
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

function ownedContent(path: string, options: ModelServiceOptions): string | undefined {
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
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 || (stat.mode & 0o022) || (uid !== undefined && stat.uid !== uid)) throw new Error(`Service file is not privately owned by the current user: ${path}`);
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

function run(options: ModelServiceOptions, command: string[], timeoutMs = 15_000) {
	return options.commandRunner ? options.commandRunner(command[0], command.slice(1)) : spawnSync(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 32 * 1024 });
}

function checkedRun(options: ModelServiceOptions, command: string[]): void {
	const result = run(options, command);
	if (result.status !== 0 || result.error) throw new Error(`${command[0]} ${command.slice(1).join(" ")} failed: ${String(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 1000)}. You can run rein model serve <id> --runtime /absolute/path/to/llama-server in the foreground.`);
}

function foreground(): ModelServiceResult {
	return { manager: "foreground", path: "", installed: false, active: false, message: "This platform has no supported user-service manager. Run rein model serve <id> --runtime /absolute/path/to/llama-server in the foreground." };
}

/** Synchronous; inspects only Rein's exact scoped service. */
export function modelServiceStatus(options: ModelServiceOptions): ModelServiceResult {
	const plan = modelServicePlan(options, true);
	if (plan.manager === "foreground") return foreground();
	const installed = ownedContent(plan.path, options) !== undefined;
	if (!installed) return { manager: plan.manager, path: plan.path, installed, active: false, message: "Model service is not installed." };
	const cfg = configuration(options);
	const command = plan.manager === "launchd" ? ["/bin/launchctl", "print", `gui/${cfg.uid}/${cfg.label}`] : ["systemctl", "--user", "is-active", basename(plan.path)];
	const result = run(options, command, 1000);
	let active: boolean | null = null;
	if (!result.error && result.status === 0) active = plan.manager === "systemd" || /\bstate\s*=\s*running\b/.test(result.stdout ?? "");
	else if (!result.error && ((plan.manager === "systemd" && (result.status === 3 || result.status === 4)) || /could not find service|service not found/i.test(result.stderr ?? ""))) active = false;
	const detail = String(result.error?.message || result.stderr || "").trim().slice(0, 500);
	return { manager: plan.manager, path: plan.path, installed, active, message: active === true ? "Model service process is running; model readiness is checked by rein model use <id>." : active === false ? "Model service is installed but stopped." : `Model service is installed; service manager status is unavailable${detail ? `: ${detail}` : "."}` };
}

/** Call only for an explicit service-install action. Verify before registering. */
export async function installModelService(options: ModelServiceOptions): Promise<ModelServiceResult> {
	options.signal?.throwIfAborted();
	if (!["darwin", "linux"].includes(options.platform ?? process.platform)) return foreground();
	const command = options.runtime ?? "llama-server";
	if (!command || /[\x00-\x1f\x7f]/.test(command) || !isAbsolute(command) && /[/\\]/.test(command)) throw new Error("Provide an absolute --runtime path or a command name on PATH.");
	const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).map(path => join(path, command));
	let runtime: string | undefined;
	for (const candidate of candidates) {
		try { await access(candidate, constants.X_OK); if (lstatSync(await realpath(candidate)).isFile()) { runtime = await realpath(candidate); break; } } catch { /* Try the next PATH entry. */ }
	}
	if (!runtime) throw new Error("llama-server was not found. Install llama.cpp or supply --runtime /absolute/path/to/llama-server.");
	options = { ...options, runtime };
	const plan = modelServicePlan(options);
	if (plan.manager === "foreground") return foreground();
	const cfg = configuration(options);
	const installed = await (options.verify ?? verifyInstalledModel)(options.id, { home: options.home, signal: options.signal });
	servingPlan(installed, options);
	await access(options.runtime!, constants.X_OK);
	await access(cfg.nodePath, constants.X_OK);
	await access(cfg.cliPath, constants.R_OK);
	options.signal?.throwIfAborted();
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
	for (const command of plan.installCommands) { options.signal?.throwIfAborted(); checkedRun(options, command); }
	const status = modelServiceStatus(options);
	return status.active === false ? { ...status, message: "Model service registered. It may still be starting; check rein model service status <id>." } : status;
}

/** Synchronous; leaves a file in place if the service could not be stopped. */
export function removeModelService(options: ModelServiceOptions): ModelServiceResult {
	const plan = modelServicePlan(options, true);
	if (plan.manager === "foreground") return foreground();
	const previous = ownedContent(plan.path, options);
	if (previous === undefined) return { manager: plan.manager, path: plan.path, installed: false, active: false, message: "Model service is not installed." };
	const result = run(options, plan.uninstallCommands[0]);
	const absent = plan.manager === "launchd" && /could not find service|no such process|service not found/i.test(result.stderr ?? "");
	if ((result.status !== 0 || result.error) && !absent) throw new Error(`Cannot stop the Rein service; its file was kept: ${result.error?.message || result.stderr || result.status}`);
	if (ownedContent(plan.path, options) !== previous) throw new Error("The Rein service file changed while uninstalling; its file was kept.");
	unlinkSync(plan.path);
	for (const command of plan.uninstallCommands.slice(1)) checkedRun(options, command);
	return { manager: plan.manager, path: plan.path, installed: false, active: false, message: "Model service stopped and uninstalled." };
}
