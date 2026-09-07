import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserTransition, loadDir, renderBrowser, terminalText, type BrowserState } from "../src/export/tui.ts";

const state: BrowserState = {
	dir: "/home/user",
	home: "/home/user",
	entries: [
		{ name: "Documents", path: "/home/user/Documents", dir: true, bytes: 0 },
		{ name: "notes.txt", path: "/home/user/notes.txt", dir: false, bytes: 12 },
	],
	cursor: 0,
	selected: [],
	notice: "",
};

test("cursor moves down, wraps, and up", () => {
	const down = browserTransition(state, "j");
	assert.equal(down.state.cursor, 1);
	const wrap = browserTransition(down.state, "j");
	assert.equal(wrap.state.cursor, 0, "wraps to the top");
	const up = browserTransition(wrap.state, "k");
	assert.equal(up.state.cursor, 1, "wraps to the bottom");
});

test("enter on a folder navigates, enter on a file selects", () => {
	const nav = browserTransition(state, "\r");
	assert.equal(nav.nav, "enter");
	assert.equal(nav.state.entries[state.cursor].path, "/home/user/Documents");
	const fileState = { ...state, cursor: 1 };
	const sel = browserTransition(fileState, "\r");
	assert.deepEqual(sel.state.selected, ["/home/user/notes.txt"]);
	const again = browserTransition(sel.state, "\r");
	assert.equal(again.state.selected.length, 0, "enter toggles the selection");
});

test("space selects, a selects all, c clears", () => {
	const sel = browserTransition(state, " ");
	assert.deepEqual(sel.state.selected, ["/home/user/Documents"]);
	assert.match(sel.state.notice, /whole folder/);
	const all = browserTransition(sel.state, "a");
	assert.equal(all.state.selected.length, 2);
	const cleared = browserTransition(all.state, "c");
	assert.equal(cleared.state.selected.length, 0);
});

test("h goes up except at home; g always goes home", () => {
	assert.equal(browserTransition(state, "h").nav, undefined, "at home, h stays put");
	const deep = { ...state, dir: "/home/user/Documents/work" };
	assert.equal(browserTransition(deep, "h").nav, "back");
	assert.equal(browserTransition(deep, "g").nav, "home");
});

test("e requests export; q and Ctrl-C quit", () => {
	assert.equal(browserTransition(state, "e").action.type, "export");
	assert.equal(browserTransition(state, "q").action.type, "quit");
	assert.equal(browserTransition(state, "\x03").action.type, "quit");
});

test("render shows markers, selection, target, and never-deletes line", () => {
	const withSelection = { ...state, selected: ["/home/user/notes.txt"], notice: "Selected notes.txt." };
	const text = renderBrowser(withSelection, "/home/user/Dareecho-Export-2026-01-01");
	assert.match(text, /Dareecho export — choose personal files/);
	assert.match(text, /Browse: \/home\/user/);
	assert.match(text, />\s+\[ \] Documents\//);
	assert.match(text, /\[x\] notes\.txt/);
	assert.match(text, /Export to: \/home\/user\/Dareecho-Export-2026-01-01/);
	assert.match(text, /never deletes/);
});

test("terminalText neutralizes control characters and truncates", () => {
	assert.equal(terminalText("ab\x07cd"), "ab cd");
	assert.equal(terminalText("x".repeat(50), 10).length, 10);
});

test("loadDir sorts folders first and reports sizes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "export-tui-"));
	await mkdir(join(dir, "b-folder"));
	await writeFile(join(dir, "a-file.txt"), "123");
	await writeFile(join(dir, "z-file.txt"), "1");
	const entries = await loadDir(dir);
	assert.deepEqual(entries.map(e => e.name), ["b-folder", "a-file.txt", "z-file.txt"]);
	assert.equal(entries[0].dir, true);
	assert.equal(entries[1].bytes, 3);
});
