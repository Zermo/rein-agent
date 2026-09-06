import { emitKeypressEvents } from "node:readline";
import { resolve } from "node:path";
import { TmuxShells, shellQuote } from "../tmux.ts";
import { terminalText } from "../autonomy/tui.ts";
import { newActivityId, readActivity, type ActivitySnapshot } from "./store.ts";

export function renderActivity(snapshot: ActivitySnapshot | undefined, selected?: string, width = 65, height = 36, controls = "↑↓ select · f follow · q quit"): string {
	const columns = Math.max(16, width), rows = Math.max(8, height);
	const lines = ["REIN / ACTIVITY", snapshot ? `${snapshot.state} · ${snapshot.model ?? ""}` : "Waiting for the session…", controls, ""];
	if (!snapshot) return lines.join("\n");
	const nodes = snapshot.nodes, index = Math.max(0, selected ? nodes.findIndex(node => node.id === selected) : nodes.length - 1);
	const count = Math.max(2, Math.floor((rows - 9) / 2));
	const first = Math.max(0, index - count + 1);
	for (const node of nodes.slice(first, first + count)) {
		const mark = node.status === "running" ? "●" : node.status === "done" ? "✓" : node.status === "paused" ? "Ⅱ" : "!";
		lines.push(`${node.id === nodes[index]?.id ? "›" : " "} ${node.kind === "tool" ? "  ├─" : "└─"} ${mark} #${node.id} ${node.kind === "tool" ? "TOOL " : node.kind === "request" ? "OPERATOR " : "REIN "}${node.title}${node.path ? " · " + node.path : ""}`);
	}
	const node = nodes[index];
	if (node) {
		lines.push("", `${node.title} / ${node.status}`, "─".repeat(Math.min(columns - 1, 44)));
		const detail = (node.input ? "Input: " + node.input + "\n\n" : "") + node.detail;
		const wrapped = terminalText(detail, true).split("\n").flatMap(line => line.match(new RegExp(`.{1,${columns - 1}}`, "gu")) ?? [""]);
		lines.push(...wrapped.slice(0, Math.max(0, rows - lines.length - 2)));
	}
	if (snapshot.omitted) lines.push(`[${snapshot.omitted} older steps omitted from this view]`);
	return lines.map(line => terminalText(line).slice(0, columns - 1)).slice(0, rows - 1).join("\n");
}

export async function watchActivity(id: string) {
	if (!process.stdin.isTTY || !process.stdout.isTTY) { console.log(renderActivity(readActivity(id))); return; }
	let selected: string | undefined, follow = true, closed = false;
	const draw = () => { const state = readActivity(id); if (follow) selected = state?.nodes.at(-1)?.id; process.stdout.write("\x1b[2J\x1b[H" + renderActivity(state, selected, process.stdout.columns, process.stdout.rows)); };
	emitKeypressEvents(process.stdin); const wasRaw = process.stdin.isRaw; process.stdin.setRawMode(true); process.stdin.resume();
	process.stdout.write("\x1b[?1049h\x1b[?25l");
	try { await new Promise<void>((resolveDone, reject) => {
		const finish = (error?: unknown) => { if (closed) return; closed = true; clearInterval(timer); process.stdin.off("keypress", key); process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("SIGHUP", stop); if (error) reject(error); else resolveDone(); };
		const stop = () => finish();
		const refresh = () => { try { draw(); } catch (error) { finish(error); } };
		const timer = setInterval(refresh, 500);
		const key = (_text: string, event: { name?: string; ctrl?: boolean }) => {
			try {
				if (event.name === "q" || event.ctrl && event.name === "c") { finish(); return; }
				if (event.name === "f") follow = true;
				if (event.name === "up" || event.name === "down") { follow = false; const nodes = readActivity(id)?.nodes ?? []; const index = Math.max(0, nodes.findIndex(node => node.id === selected)); selected = nodes[Math.max(0, Math.min(nodes.length - 1, index + (event.name === "up" ? -1 : 1)))]?.id; }
				refresh();
			} catch (error) { finish(error); }
		};
		process.stdin.on("keypress", key); process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", stop); refresh();
	}); } finally { process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stdout.write("\x1b[?25h\x1b[?1049l"); }
}

export async function launchVisual(argv: string[], cwd: string): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("rein --visual requires an interactive terminal and tmux.");
	const id = newActivityId(), shells = new TmuxShells(cwd, "visual");
	const boundary = argv.indexOf("--");
	const args = argv.filter((arg, index) => boundary >= 0 && index > boundary || !/^--visual(?:=true|=false)?$/.test(arg));
	const cli = [process.execPath, resolve(process.argv[1])].map(shellQuote).join(" ");
	const prefix = `cd ${shellQuote(cwd)} && `;
	const session = await shells.start();
	try {
		await shells.split(session, `${prefix}exec ${cli} watch ${shellQuote(id)}`);
		await shells.send(session, `${prefix}${cli} --activity ${shellQuote(id)} ${args.map(shellQuote).join(" ")}; exit`);
		console.error(`Activity ${id}\nChat and activity stay in this terminal. Switch panes: Ctrl-b Left/Right. Detach: Ctrl-b d.\nResume: rein tmux attach ${session} --view`);
		return await shells.attach(session);
	} catch (error) { await shells.stop(session).catch(() => {}); throw error; }
}
