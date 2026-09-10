/** Finder-style export browser. Pure state transitions; the raw-mode loop mirrors the autonomy TUI. */
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { exportFiles, formatBytes, type CopySummary } from "./copy.ts";

export interface Entry { name: string; path: string; dir: boolean; bytes: number }
export interface BrowserState { dir: string; home: string; entries: Entry[]; cursor: number; selected: string[]; notice: string }
export type BrowserAction = { type: "none" } | { type: "quit" } | { type: "export" }

export function terminalText(value: string, width = 60): string {
	const text = stripVTControlCharacters(String(value ?? "")).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
	return text.length > width ? text.slice(0, width - 1) + "…" : text;
}

export async function loadDir(dir: string): Promise<Entry[]> {
	const names = await readdir(dir, { withFileTypes: true });
	const entries: Entry[] = [];
	for (const name of names) {
		const path = join(dir, name.name);
		try {
			const info = await lstat(path);
			entries.push({ name: name.name, path, dir: info.isDirectory(), bytes: info.isDirectory() ? 0 : info.size });
		} catch { entries.push({ name: name.name, path, dir: name.isDirectory(), bytes: 0 }); }
	}
	return entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

function toggle(list: string[], path: string): string[] {
	return list.includes(path) ? list.filter(p => p !== path) : [...list, path];
}
function merge(list: string[], more: string[]): string[] {
	const out = [...list];
	for (const m of more) if (!out.includes(m)) out.push(m);
	return out;
}

/** Pure key handling keeps export decisions separate from rendering or model-generated text. */
export function browserTransition(state: BrowserState, key: string): { state: BrowserState; action: BrowserAction; nav?: "home" | "back" | "enter" } {
	if (key === "q" || key === "\x03") return { state, action: { type: "quit" } };
	if (key === "e" || key === "E") return { state, action: { type: "export" } };
	if (key === "\x1b[A" || key === "k" || key === "p") {
		if (state.entries.length === 0) return { state, action: { type: "none" } };
		return { state: { ...state, cursor: (state.cursor - 1 + state.entries.length) % state.entries.length }, action: { type: "none" } };
	}
	if (key === "\x1b[B" || key === "j" || key === "n") {
		if (state.entries.length === 0) return { state, action: { type: "none" } };
		return { state: { ...state, cursor: (state.cursor + 1) % state.entries.length }, action: { type: "none" } };
	}
	if (key === "g" || key === "G") return { state, action: { type: "none" }, nav: "home" };
	if (key === "h" || key === "\x7f" || key === "\x1b") return { state, action: { type: "none" }, nav: state.dir === state.home ? undefined : "back" };
	if (key === "\r" || key === "\n" || key === "l" || key === "\t") {
		const entry = state.entries[state.cursor];
		if (!entry) return { state, action: { type: "none" } };
		if (entry.dir) return { state, action: { type: "none" }, nav: "enter" };
		return { state: { ...state, selected: toggle(state.selected, entry.path) }, action: { type: "none" } };
	}
	if (key === " ") {
		const entry = state.entries[state.cursor];
		if (!entry) return { state, action: { type: "none" } };
		return { state: { ...state, selected: toggle(state.selected, entry.path), notice: entry.dir ? `Selected whole folder ${terminalText(entry.name, 30)}.` : `Selected ${terminalText(entry.name, 30)}.` }, action: { type: "none" } };
	}
	if (key === "a" || key === "A") {
		const all = state.entries.map(e => e.path);
		return { state: { ...state, selected: merge(state.selected, all), notice: `Selected all ${all.length} items here.` }, action: { type: "none" } };
	}
	if (key === "c" || key === "C") return { state: { ...state, selected: [], notice: "Selection cleared." }, action: { type: "none" } };
	return { state, action: { type: "none" } };
}

export function renderBrowser(state: BrowserState, target: string): string {
	const lines = [
		"Dareecho export — choose personal files to keep before the OS is replaced",
		`Browse: ${terminalText(state.dir, 70)}`,
		"",
	];
	if (state.entries.length === 0) lines.push("  (empty)");
	for (const [i, entry] of state.entries.entries()) {
		const marker = i === state.cursor ? ">" : " ";
		const check = state.selected.includes(entry.path) ? "[x]" : "[ ]";
		const name = terminalText(entry.name, 36) + (entry.dir ? "/" : "");
		const size = entry.dir ? "" : formatBytes(entry.bytes).padStart(10);
		lines.push(` ${marker} ${check} ${name.padEnd(38)}${size}`);
	}
	lines.push("");
	lines.push(`Export to: ${terminalText(target, 70)}`);
	lines.push(state.notice ? `Notice: ${terminalText(state.notice, 70)}` : " ");
	lines.push("[j/k] move  [enter] open or select  [space] select  [a] all here  [c] clear  [h] up  [g] home");
	lines.push("[e] export selection (copies, never deletes)  [q] quit");
	return lines.join("\n");
}

export interface BrowserRunnerOptions {
	start?: string;
	target: string;
	export?: (sources: string[], target: string) => Promise<CopySummary>;
	load?: (dir: string) => Promise<Entry[]>;
}
export interface BrowserRunnerResult { exported?: CopySummary; lastNotice: string }

/** Raw-mode loop. Restores the terminal and input mode on every exit path. */
export function runBrowser(input: Readable, output: Writable, options: BrowserRunnerOptions): Promise<BrowserRunnerResult> {
	return new Promise((resolvePromise, reject) => {
		const home = resolve(homedir());
		const start = options.start ? resolve(options.start) : home;
		const load = options.load ?? loadDir;
		const exportFn = options.export ?? exportFiles;
		const state: BrowserState = { dir: start, home, entries: [], cursor: 0, selected: [], notice: "" };
		const result: BrowserRunnerResult = { lastNotice: "" };
		let done = false, lastDisplay = "", wasRaw = false, wasPaused = false;
		const finish = (error?: unknown) => {
			if (done) return;
			done = true;
			input.off("data", onData);
			try { if (wasRaw && input.isTTY) input.setRawMode(false); } catch { /* disconnected terminal */ }
			if (wasPaused) input.pause();
			try { output.write("\x1b[?25h\n"); } catch { /* disconnected terminal */ }
			if (error) reject(error instanceof Error ? error : new Error(String(error)));
			else resolvePromise(result);
		};
		const draw = () => {
			if (done) return;
			const display = renderBrowser(state, options.target);
			if (display !== lastDisplay) {
				try { output.write("\x1b[2J\x1b[H" + display + "\n"); } catch { /* disconnected terminal */ }
				lastDisplay = display;
			}
		};
		const step = async (key: string) => {
			if (done) return;
			const transition = browserTransition(state, key);
			state.notice = transition.state.notice;
			if (transition.nav) {
				try {
					state.dir = transition.nav === "home" ? home : transition.nav === "back" ? dirname(state.dir) : state.entries[state.cursor].path;
					state.entries = await load(state.dir);
					state.cursor = 0;
					state.notice = "";
				} catch { state.notice = `Cannot open ${state.dir}.`; }
				draw();
				return;
			}
			state.selected = transition.state.selected;
			draw();
			if (transition.action.type === "quit") return finish();
			if (transition.action.type === "export") {
				if (state.selected.length === 0) { state.notice = "Nothing selected. Space or a to choose files first."; draw(); return; }
				try {
					result.exported = await exportFn(state.selected, options.target);
					state.notice = `Exported ${result.exported.files} files (${formatBytes(result.exported.bytes)}) to ${options.target}. Sources are untouched.`;
					result.lastNotice = state.notice;
					draw();
				} catch (error) { state.notice = (error as Error).message; result.lastNotice = state.notice; draw(); }
			}
		};
		const onData = (chunk: unknown) => { void step(String(chunk)); };
		try {
			input.setEncoding("utf8");
			input.on("data", onData);
			if (input.isTTY) { input.setRawMode(true); input.resume(); output.write("\x1b[?25l"); wasRaw = true; }
			else { input.resume(); wasPaused = true; }
			draw();
			void load(start).then(entries => { state.entries = entries; draw(); }).catch(error => finish(error));
		} catch (error) { finish(error); }
	});
}
