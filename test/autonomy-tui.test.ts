import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { dashboardTransition, renderDashboard, terminalText, type DashboardSnapshot, type DashboardViewState } from "../src/harness/autonomy/tui.ts";

function snapshot(): DashboardSnapshot {
	return {
		paused: false, workspaces: ["/projects/rein"], service: "running", budget: "2 runs/day",
		proposals: [{ id: "proposal-1", title: "Inspect regressions", kind: "routine", workspace: "/projects/rein", reason: "Recent test failures", prompt: "Inspect tests; report findings without changing files.", evidenceIds: ["session-1"], status: "pending", intervalMinutes: 60 }],
		recentRuns: [{ id: "run-1", status: "complete", detail: "No new failures" }],
	};
}
function view(): DashboardViewState { return { selected: 0, button: 0, details: false }; }

test("dashboard strips terminal commands from every external display field", () => {
	const dangerous = "before\x1b]52;c;ZXhwbG9pdA==\x07\x1b[2J\x1b[31mafter\x1b[0m\r\n\u202espoof\x9b31m";
	const data = snapshot();
	data.service = dangerous; data.budget = dangerous; data.lastError = dangerous;
	data.workspaces = [dangerous];
	Object.assign(data.proposals[0], { id: dangerous, title: dangerous, kind: dangerous, status: dangerous });
	data.recentRuns = [{ id: dangerous, status: dangerous, detail: dangerous }];
	const rendered = renderDashboard(data);
	assert.doesNotMatch(rendered, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
	assert.doesNotMatch(rendered, /ZXhwbG9pdA==/);
	assert.match(rendered, /beforeafter spoof/);
	assert.equal(terminalText("a\r\nb\tend", true), "a\nb    end");
	assert.equal(terminalText("a\r\nb"), "a b");
	Object.assign(data.proposals[0], { prompt: dangerous, reason: dangerous, workspace: dangerous, evidenceIds: [dangerous] });
	const review = renderDashboard(data, { ...view(), confirmation: data.proposals[0] });
	assert.doesNotMatch(review, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
	assert.match(review, /Exact task prompt:/);
	assert.match(review, /Evidence entry IDs:/);
	assert.match(review, /read-only inspection/);
});

test("approval requires reviewing an exact pending proposal followed by a separate y", () => {
	const data = snapshot();
	assert.equal(dashboardTransition(data, view(), "y").request, undefined);
	const review = dashboardTransition(data, view(), "a");
	assert.equal(review.request, undefined);
	assert.equal(review.state.details, true);
	assert.deepEqual(review.state.confirmation, data.proposals[0]);
	assert.notEqual(review.state.confirmation, data.proposals[0]);
	assert.notEqual(review.state.confirmation?.evidenceIds, data.proposals[0].evidenceIds);
	assert.equal(dashboardTransition(data, review.state, "\r").request, undefined);
	assert.equal(dashboardTransition(data, review.state, "r").request, undefined);
	assert.equal(dashboardTransition(data, review.state, "n").state.confirmation, undefined);
	const approved = dashboardTransition(data, review.state, "y");
	assert.equal(approved.request?.action, "approve");
	assert.equal(approved.request?.id, "proposal-1");
	assert.deepEqual(approved.request?.review, data.proposals[0]);
	assert.equal(approved.state.confirmation, undefined);
	assert.match(renderDashboard(data, review.state), /recurring read-only inspection/);
	for (const kind of ["loop", "project"]) {
		data.proposals[0].kind = kind;
		const once = renderDashboard(data, dashboardTransition(data, view(), "a").state);
		assert.match(once, /Schedule: one bounded run/);
		assert.match(once, /one bounded read-only inspection/);
		assert.doesNotMatch(once, /every 60/);
	}
});

test("keyboard controls select proposals and buttons without running unapproved tasks", () => {
	const data = snapshot();
	assert.equal(dashboardTransition(data, view(), "r").request, undefined);
	data.proposals.push({ ...data.proposals[0], id: "proposal-2", status: "enabled" });
	const down = dashboardTransition(data, view(), "\x1b[B");
	assert.equal(down.state.selected, 1);
	assert.equal(dashboardTransition(data, down.state, "r").request?.id, "proposal-2");
	assert.equal(dashboardTransition(data, down.state, "a").state.confirmation, undefined);
	const up = dashboardTransition(data, down.state, "k");
	assert.equal(up.state.selected, 0);
	const tab = dashboardTransition(data, up.state, "\t");
	assert.equal(tab.state.button, 1);
	assert.ok(dashboardTransition(data, tab.state, "\r").state.confirmation);
	assert.equal(dashboardTransition(data, view(), "\r").state.details, true);
	assert.equal(dashboardTransition(data, view(), "p").request?.action, "pause");
	data.paused = true;
	assert.equal(dashboardTransition(data, view(), "p").request?.action, "resume");
	assert.equal(dashboardTransition(data, view(), "\x03").quit, true);
});

test("proposal review includes bounded, sanitized cited excerpts and freezes their reviewed values", () => {
	const data = snapshot();
	data.proposals[0].evidence = [{ id: "entry-17", sessionId: "session-2", workspace: "/projects/rein", role: "user", timestamp: 1_788_562_800_000,
		excerpt: "Inspect the nightly regression.\n\x1b]52;c;ZXhwbG9pdA==\x07\x1b[2JKeep it read-only.\x00\u202e" }];
	const review = dashboardTransition(data, view(), "a");
	const text = renderDashboard(data, review.state);
	assert.match(text, /Entry: entry-17 \| Session: session-2/);
	assert.match(text, /Role: user \| Workspace: \/projects\/rein/);
	assert.match(text, /Inspect the nightly regression\.\nKeep it read-only\./);
	assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
	assert.notEqual(review.state.confirmation?.evidence?.[0], data.proposals[0].evidence[0]);
	data.proposals[0].evidence[0].excerpt = "Changed source";
	assert.match(review.state.confirmation!.evidence![0].excerpt, /nightly regression/);
	data.proposals[0].evidence = Array.from({ length: 20 }, (_, index) => ({ ...data.proposals[0].evidence![0], id: `bounded-${index}`, excerpt: "x".repeat(2000) }));
	const bounded = renderDashboard(data, { ...view(), details: true });
	assert.equal((bounded.match(/Entry: bounded-/g) ?? []).length, 12);
	assert.ok(!bounded.includes("x".repeat(1401)));
});

function fakeTerminal(program: string): any {
	const script = `
import { EventEmitter } from "node:events";
import { runDashboard } from ${JSON.stringify(new URL("../src/harness/autonomy/tui.ts", import.meta.url).href)};
const actualWrite = process.stdout.write.bind(process.stdout);
const data = ${JSON.stringify(snapshot())};
const captures = []; const actions = [];
const initialSignals = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
class Input extends EventEmitter {
  isTTY = true; isRaw = false; paused = true;
  setRawMode(value) { this.isRaw = value; }
  isPaused() { return this.paused; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
}
const input = new Input();
const output = new EventEmitter(); output.isTTY = true;
output.write = (text) => { captures.push(text); return true; };
Object.defineProperty(process, "stdin", { value: input });
Object.defineProperty(process, "stdout", { value: output });
const report = (extra = {}) => actualWrite(JSON.stringify({ actions, captures, raw: input.isRaw, paused: input.paused,
  listeners: input.listenerCount("data") + input.listenerCount("error") + output.listenerCount("error"),
  signalDelta: process.listenerCount("SIGINT") - initialSignals.int + process.listenerCount("SIGTERM") - initialSignals.term, ...extra }));
${program}`;
	return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5_000 }));
}

test("non-TTY status exits without approval or terminal changes", () => {
	const result = fakeTerminal(`
input.isTTY = false;
await runDashboard({ snapshot: () => data, action: async (...args) => { actions.push(args); } });
report();`);
	assert.deepEqual(result.actions, []);
	assert.equal(result.raw, false);
	assert.equal(result.paused, true);
	assert.equal(result.listeners, 0);
	assert.equal(result.signalDelta, 0);
	assert.match(result.captures.join(""), /Rein autonomy/);
	assert.doesNotMatch(result.captures.join(""), /\x1b/);
});

test("interactive approval displays the complete reviewed task and restores the terminal on quit", () => {
	const result = fakeTerminal(`
let stage = 0;
output.write = (text) => {
  captures.push(text);
  if (stage === 0 && text.includes("Proposals (")) { stage = 1; setImmediate(() => input.emit("data", Buffer.from("a"))); }
  else if (stage === 1 && text.includes("[y] Approve")) { stage = 2; setImmediate(() => input.emit("data", Buffer.from("y"))); }
  return true;
};
await runDashboard({ snapshot: () => data, action: async (...args) => {
  actions.push(args); setImmediate(() => input.emit("data", Buffer.from("q"))); return "Enabled";
} });
report();`);
	assert.deepEqual(result.actions, [["approve", "proposal-1"]]);
	const display = result.captures.join("");
	assert.ok(display.includes(snapshot().proposals[0].prompt));
	assert.ok(display.includes(snapshot().proposals[0].reason));
	assert.ok(display.includes("session-1"));
	assert.equal(result.raw, false);
	assert.equal(result.paused, true);
	assert.equal(result.listeners, 0);
	assert.equal(result.signalDelta, 0);
	assert.ok(display.endsWith("\x1b[?25h\n"));
});

test("proposal updates invalidate an open approval and Ctrl-C cleans up", () => {
	const result = fakeTerminal(`
let stage = 0; let reads = 0;
output.write = (text) => {
  captures.push(text);
  if (stage === 0 && text.includes("Proposals (")) { stage = 1; setImmediate(() => input.emit("data", Buffer.from("a"))); }
  else if (stage === 1 && text.includes("[y] Approve")) { stage = 2; setImmediate(() => input.emit("data", Buffer.from("y"))); }
  else if (stage === 2 && text.includes("changed while")) { stage = 3; setImmediate(() => input.emit("data", Buffer.from("\\x03"))); }
  return true;
};
await runDashboard({ snapshot: () => {
  reads++; if (reads > 1) data.proposals[0].prompt = "Different task"; return data;
}, action: async (...args) => { actions.push(args); } });
report();`);
	assert.deepEqual(result.actions, []);
	assert.equal(result.raw, false);
	assert.equal(result.listeners, 0);
	assert.equal(result.signalDelta, 0);
	assert.match(result.captures.join(""), /changed while you reviewed/);
});

test("terminal exceptions restore raw mode, listeners and the cursor", () => {
	const result = fakeTerminal(`
setImmediate(() => input.emit("error", new Error("terminal disconnected")));
let failure;
try { await runDashboard({ snapshot: () => data, action: async () => {} }); }
catch (error) { failure = error.message; }
report({ failure });`);
	assert.equal(result.failure, "terminal disconnected");
	assert.equal(result.raw, false);
	assert.equal(result.paused, true);
	assert.equal(result.listeners, 0);
	assert.equal(result.signalDelta, 0);
	assert.ok(result.captures.join("").endsWith("\x1b[?25h\n"));
});
