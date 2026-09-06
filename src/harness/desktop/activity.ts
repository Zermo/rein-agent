import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startCanvas } from "../activity/server.ts";

const exec = promisify(execFile);
interface DesktopActivityDependencies {
	env?: NodeJS.ProcessEnv;
	script?: string;
	start?: typeof startCanvas;
	run?: (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<unknown>;
	log?: (message: string) => void;
}
/** Explicit NodeTerm embed only. A missing capability never opens another app. */
export async function openDesktopActivity(id: string, deps: DesktopActivityDependencies = {}): Promise<Awaited<ReturnType<typeof startCanvas>>> {
	const env = deps.env ?? process.env;
	const base = process.platform === "darwin" ? join(homedir(), "Library/Application Support/node-terminal") : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "node-terminal");
	const script = deps.script ?? join(base, "canvas-control/nodeterm.sh");
	if (!env.NODETERM_NODE_ID || !env.NODETERM_CANVAS_CONTROL || !existsSync(script)) {
		throw new Error("This terminal has no NodeTerm canvas capability. Activity remains in the terminal. Use /activity or rein watch <activity-id>.");
	}
	const canvas = await (deps.start ?? startCanvas)(id);
	try {
		await (deps.run ?? exec)("sh", [script, "show-web", "--url", canvas.url], { timeout: 10_000, maxBuffer: 64 * 1024 });
		(deps.log ?? console.error)("Rein activity opened as a NodeTerm canvas node.");
		return canvas;
	} catch (error) { await canvas.close(); throw error; }
}
