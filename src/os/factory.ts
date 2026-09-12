// rein os factory — drive the Mastra Factory supervisor from the terminal.
// The supervisor and provisioning modules live in apps/factory (the native
// app's home) and are shared: whichever surface started the server, the
// other can stop it, inspect it, and open it. The server state is the pid
// file, log, and port under ~/.local/state/rein-factory; the generated
// project lives under ~/.local/share/rein-factory.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProject, installDependencies, openServer, serverStatus, startServer, stopServer } from "../../apps/factory/supervisor.mjs";
import { inspectProject, provisionProject } from "../../apps/factory/provision.mjs";

export const FACTORY_VERBS = ["setup", "start", "dev", "stop", "status", "open"] as const;
type FactoryVerb = (typeof FACTORY_VERBS)[number];

export const FACTORY_HELP = `Mastra Factory on this machine (the same server the Mastra Factory app drives)

  rein os factory setup               install the Factory project once: template, key, .env, dependencies, build
  rein os factory start               production profile: built server, requires DATABASE_URL (Postgres)
  rein os factory dev                 single-machine profile: dev server, libSQL storage, no database needed
  rein os factory stop                stop the server this supervisor started
  rein os factory status [--json]     server state, URL, pid, and project/log paths
  rein os factory open                start if needed, then open the Factory UI in a browser

Setup creates the project once and never overwrites it. The server state
(pid, log, port) is shared with the Mastra Factory app, so either surface
can start, stop, and inspect the same server. Run it with: rein os factory status`;

// Locate the vendored template from wherever this module runs: two levels up
// in the source tree (src/os), one level up in the bundle (dist), one level
// up in the test directory.
export function findTemplateDir(startDir = fileURLToPath(import.meta.url)): string {
  let dir = startDir;
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, "vendor", "mastra-factory");
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "src", "mastra", "index.ts"))) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("The Mastra Factory template (vendor/mastra-factory) is missing from this Rein tree.");
}

export type FactoryStatus = Awaited<ReturnType<typeof serverStatus>>;

export function formatFactoryStatus(status: FactoryStatus): string {
  const lines = [`Mastra Factory: ${status.state}`];
  if (status.state === "running") {
    lines.push(`  url  ${status.url}`, `  pid  ${status.pid}`);
  } else if (status.state === "external") {
    lines.push(`  url  ${status.url}`, "  note a server answers on this port, but this supervisor does not own it");
  } else {
    lines.push(`  url  ${status.url} (not answering)`);
    if (status.recentLog) for (const line of status.recentLog.split("\n").slice(-5)) lines.push(`  log  ${line}`);
    lines.push("  start  rein os factory start");
  }
  lines.push(`  project  ${status.projectDir}`, `  log  ${status.logFile}`);
  return lines.join("\n");
}

export async function openInBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, argv, { stdio: "ignore" });
    child.once("error", () => reject(new Error(`Could not open a browser for ${url}.`)));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`The browser opener finished with exit code ${code}.`)));
  });
}

export type FactoryDeps = {
	log?: (text: string) => void;
	templateDir?: string;
	install?: (projectDir: string, log: (text: string) => void) => Promise<void>;
	build?: (projectDir: string, log: (text: string) => void) => Promise<void>;
	startServer?: typeof startServer;
	stopServer?: typeof stopServer;
	serverStatus?: typeof serverStatus;
	openServer?: typeof openServer;
	open?: (url: string) => Promise<void> | void;
};

export async function setupFactory(deps: FactoryDeps = {}): Promise<{ created: boolean; installed: boolean; projectDir: string }> {
	const log = deps.log ?? console.log;
	const userHome = homedir();
	const templateDir = deps.templateDir ?? findTemplateDir();
	const env = process.env;
	const projectDir = env.FACTORY_PROJECT?.trim() || join(userHome, ".local", "share", "rein-factory");
	const state = inspectProject({ projectDir, templateDir });
	if (!state.templateOk) throw new Error("The Mastra Factory template is missing. Reinstall the Rein tree.");
	const result = provisionProject({ projectDir, templateDir, databaseUrl: env.DATABASE_URL, log });
	let installed = state.installed;
	if (!installed) {
		await (deps.install ?? installDependencies)(projectDir, log);
		installed = true;
	}
	if (!existsSync(join(projectDir, ".mastra", "output"))) {
		await (deps.build ?? buildProject)(projectDir, log);
	}
	log(result.created
		? `Mastra Factory is set up in ${projectDir}.\nStart it: rein os factory start`
		: `Mastra Factory was already set up in ${projectDir}.\nStart it: rein os factory start`);
	return { created: result.created, installed, projectDir };
}

export async function runFactoryCommand(args: string[], flags: Record<string, string | boolean> = {}, deps: FactoryDeps = {}): Promise<void> {
	const log = deps.log ?? console.log;
	const verb: string = args[0] ?? "help";
	if (verb === "help" || verb === "-h" || verb === "--help") {
		for (const key of Object.keys(flags)) throw new Error("Usage: rein os factory help");
		log(FACTORY_HELP);
		return;
	}
	if (!(FACTORY_VERBS as readonly string[]).includes(verb)) {
		throw new Error("Usage: rein os factory setup|start|dev|stop|status|open. Run rein os factory help.");
	}
	if (args.length > 1) throw new Error(`Usage: rein os factory ${verb}`);
	const env = process.env, userHome = homedir();
	if (verb === "setup") {
		for (const key of Object.keys(flags)) throw new Error(`Unsupported factory option --${key}.`);
		await setupFactory(deps);
		return;
	}
	if (verb === "start") {
		for (const key of Object.keys(flags)) throw new Error(`Unsupported factory option --${key}.`);
		const result = await (deps.startServer ?? startServer)({ env, userHome, mode: "production", log });
		log(`Mastra Factory: ${result.url}`);
		return;
	}
	if (verb === "dev") {
		for (const key of Object.keys(flags)) throw new Error(`Unsupported factory option --${key}.`);
		const result = await (deps.startServer ?? startServer)({ env, userHome, mode: "dev", log });
		log(`Mastra Factory (single-machine): ${result.url}`);
		return;
	}
	if (verb === "stop") {
		for (const key of Object.keys(flags)) throw new Error(`Unsupported factory option --${key}.`);
		await (deps.stopServer ?? stopServer)({ env, userHome, log });
		return;
	}
	if (verb === "status") {
		for (const key of Object.keys(flags)) if (!["json"].includes(key)) throw new Error(`Unsupported factory option --${key}.`);
		if (flags.json !== undefined && typeof flags.json !== "boolean") throw new Error("--json expects true or false.");
		const status = await (deps.serverStatus ?? serverStatus)({ env, userHome });
		log(flags.json === true ? JSON.stringify(status, null, 2) : formatFactoryStatus(status));
		return;
	}
	if (verb === "open") {
		for (const key of Object.keys(flags)) throw new Error(`Unsupported factory option --${key}.`);
		const result = await (deps.openServer ?? openServer)({ env, userHome, open: deps.open ?? openInBrowser, log });
		log(`Mastra Factory: ${result.url}${result.started ? " (started the server)" : ""}`);
		return;
	}
	throw new Error("Usage: rein os factory setup|start|dev|stop|status|open. Run rein os factory help.");
}
