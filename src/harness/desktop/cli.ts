import { accessSync, constants, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopSurface } from "./surface.ts";
import type { ServeHandle } from "../klaud/serve.ts";
import { desktopAvailable, nativeApp, openNodeTerm, preferSurface, preferredSurface, registerRein } from "./surface.ts";

export async function desktopCommand(args: string[], flags: Record<string, string | boolean>): Promise<void> {
	const action = args[0] ?? (preferredSurface() === "klaud" ? "open" : "status");
	if (action === "use" && args.length === 2 && ["klaud", "terminal", "nodeterm"].includes(args[1])) {
		preferSurface(args[1] as DesktopSurface); console.log(`I saved the desktop preference: ${args[1]}. Use rein desktop open to open it. Bare rein sessions stay in this terminal.`); return;
	}
	if (args.length > 1 || !["install", "open", "status"].includes(action)) throw new Error("Usage: rein desktop install [--no-launch] | open | status | use klaud|nodeterm|terminal");
	if (action === "status") { console.log(`Default: current terminal\nOptional desktop preference: ${preferredSurface()}\nrein-klaʊd: ${klaudElectron(klaudAppDirectory()) ? "installed" : "not found"}\nNodeTerm: ${nativeApp() ? "installed" : "not found"}`); return; }
	if (action === "open" && preferredSurface() === "klaud") { await launchKlaud(); return; }
	if (action === "open" && preferredSurface() === "terminal") { console.log("I'm using this terminal. Run rein to start a session."); return; }
	if (action === "install") {
		if (flags["if-supported"] === true && preferredSurface() === "terminal") {
			console.log("Keeping Rein's saved terminal preference. Run rein desktop install to switch to NodeTerm."); return;
		}
		if (flags["if-supported"] === true && !desktopAvailable()) {
			console.log("Native desktop setup skipped on this platform or remote/CI shell. Rein remains available in this terminal."); return;
		}
		const { installNodeTerm } = await import("./install.ts");
		const result = await installNodeTerm({ launch: false });
		console.log(result.detail);
		if (!result.installed) { process.exitCode = 1; return; }
		console.log(await registerRein());
		preferSurface("nodeterm");
		if (flags["no-launch"] === true) return;
	}
	await openNodeTerm();
	console.log("NodeTerm is open. Choose a project and add a Rein agent node. In an existing terminal node, run rein --terminal.");
	console.log("NodeTerm currently cannot accept a project or session command from an external CLI; session flags stay in the terminal where you run them.");
}

function klaudAppDirectory(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	// Source and installed dist/rein.js layouts.
	const candidates = [resolve(here, "../../../apps/klaud"), resolve(here, "../apps/klaud")];
	return candidates.find(path => existsSync(join(path, "main.mjs"))) ?? candidates[0];
}
function klaudElectron(appDir: string): string | undefined {
	const path = join(appDir, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
	try {
		if (!existsSync(join(appDir, "main.mjs"))) return;
		accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return path;
	} catch { return; }
}
interface KlaudLaunchDependencies {
	appDir?: string;
	start?: () => Promise<ServeHandle>;
	spawn?: typeof spawn;
	signals?: Pick<NodeJS.Process, "once" | "removeListener">;
	log?: (message: string) => void;
}
async function runDesktopChild(command: string, args: string[], appDir: string, env: NodeJS.ProcessEnv, deps: KlaudLaunchDependencies, onStop = () => {}): Promise<number> {
	return new Promise((done, reject) => {
		const child = (deps.spawn ?? spawn)(command, args, { cwd: appDir, env, stdio: "inherit", shell: false, detached: process.platform !== "win32" });
		const signals = deps.signals ?? process;
		let cancelled = 0, closed = false, code = 1, error: Error | undefined, timer: ReturnType<typeof setTimeout> | undefined;
		const kill = (signal: NodeJS.Signals) => {
			try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
			catch { /* The owned child or process group has already exited. */ }
		};
		const finish = () => {
			if (!closed || timer) return;
			signals.removeListener("SIGINT", interrupt); signals.removeListener("SIGTERM", terminate);
			if (error) reject(error); else done(cancelled || code);
		};
		const stop = (status: number) => {
			if (cancelled) return;
			cancelled = status; onStop();
			// Electron's CLI wrapper can exit before its GUI descendants.
			timer = setTimeout(() => { kill("SIGKILL"); timer = undefined; finish(); }, 1_000);
			kill("SIGTERM");
		};
		const interrupt = () => stop(130), terminate = () => stop(143);
		signals.once("SIGINT", interrupt); signals.once("SIGTERM", terminate);
		child.once("error", cause => { error = cause; closed = true; finish(); });
		child.once("close", status => { code = status ?? 1; closed = true; finish(); });
	});
}
/**
 * The CLI owns one in-process backend and one foreground Electron child.
 * The app attaches through URL/TOKEN environment values, never CLI arguments.
 * No token is printed, and the app does not own this backend.
 * Renderer builds run before the backend starts.
 * App exit, launch failure, and CLI cancellation close this backend.
 * Ctrl-C also terminates the child; a stuck child is killed after one second.
 * The app's single-instance early exit closes only this invocation's backend.
 * Standalone app launches may own their own backend instead.
 */
export async function launchKlaud(deps: KlaudLaunchDependencies = {}): Promise<void> {
	const appDir = deps.appDir ?? klaudAppDirectory(), electron = klaudElectron(appDir);
	if (!electron) {
		(deps.log ?? console.log)("I couldn't find an installed rein-klaʊd app. From the Rein checkout, start rein serve in one terminal, then run:\n  cd apps/klaud && npm install && npm run dev\nConnect using the loopback URL and private token file reported by rein serve.");
		return;
	}
	const env: NodeJS.ProcessEnv = { ...process.env, REIN_SURFACE: "klaud", REIN_KLAUD: "1" };
	delete env.ELECTRON_RUN_AS_NODE; delete env.REIN_KLAUD_URL; delete env.REIN_KLAUD_TOKEN;
	if (!existsSync(join(appDir, "dist", "index.html"))) {
		const code = await runDesktopChild(process.platform === "win32" ? "npm.cmd" : "npm", ["--prefix", appDir, "run", "build"], appDir, env, deps);
		if (code !== 0) { process.exitCode = code; return; }
	}
	const start = deps.start ?? (await import("../klaud/serve.ts")).startKlaudServe;
	const handle = await start();
	let closing: Promise<void> | undefined;
	const close = () => closing ??= handle.close();
	try {
		const code = await runDesktopChild(electron, [appDir], appDir, { ...env, REIN_KLAUD_URL: handle.url, REIN_KLAUD_TOKEN: handle.token }, deps, () => { void close().catch(() => {}); });
		if (code !== 0) process.exitCode = code;
	} finally { await close(); }
}
