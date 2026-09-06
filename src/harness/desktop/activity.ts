import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startCanvas, openCanvas } from "../activity/server.ts";

const exec = promisify(execFile);
/** Only use the capability supplied to this node by NodeTerm itself. */
export async function openDesktopActivity(id: string): Promise<Awaited<ReturnType<typeof startCanvas>>> {
	const canvas = await startCanvas(id);
	const base = process.platform === "darwin" ? join(homedir(), "Library/Application Support/node-terminal") : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "node-terminal");
	const script = join(base, "canvas-control/nodeterm.sh");
	try {
		if (process.env.NODETERM_NODE_ID && process.env.NODETERM_CANVAS_CONTROL && existsSync(script)) {
			try {
				await exec("sh", [script, "show-web", "--url", canvas.url], { timeout: 10_000, maxBuffer: 64 * 1024 });
				console.error("Rein activity opened as a NodeTerm canvas node."); return canvas;
			} catch {
				console.error(`NodeTerm could not embed this activity view. Open it manually if wanted: ${canvas.url}`);
				return canvas;
			}
		} else console.error("This NodeTerm node has no browser-node capability. Opening Rein's activity view in your browser.");
		openCanvas(canvas.url);
		console.error(`Activity view: ${canvas.url}`);
		return canvas;
	} catch (error) { await canvas.close(); throw error; }
}
