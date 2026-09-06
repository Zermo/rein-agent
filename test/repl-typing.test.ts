import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const mode of ["steer", "finish", "approval", "parallel-approval"]) {
	const finishWhileTyping = mode === "finish";
	const approvalMode = mode.includes("approval");
	test(`TTY steering stays separate from streaming (${mode})`, { timeout: 8000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "rein-typing-"));
		const moduleUrl = new URL("../src/harness/repl.ts", import.meta.url).href;
		// Readline's TTY editing path can be exercised using pipes as a transport.
		const script = `Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
process.stdin.setRawMode = () => {}; process.stdout.columns = 120;
const { startRepl } = await import(${JSON.stringify(moduleUrl)});
const message = { role: "assistant", content: [], stopReason: "stop", provider: "fixture", model: "fixture", usage: { input: 0, output: 1, totalTokens: 1 }, timestamp: 0 };
let runs = 0;
const runner = { model: { provider: "fixture", id: "fixture" }, toolsMode: "native", toolsModeSource: "fixture", context: { messages: [] }, setSession() {}, steer() { process.stderr.write("STEERING_ACCEPTED\\n"); },
async run(prompt, { onEvent }) {
  runs++; onEvent({ type: "message_start", message });
  if (runs === 1) {
    onEvent({ type: "message_update", message, event: { type: "text_delta", delta: "answer begins" } });
    if (${approvalMode}) {
      await new Promise(resolve => setTimeout(resolve, 40));
      process.stderr.write("APPROVAL_REQUESTED\\n");
      if (${mode === "parallel-approval"}) {
        const duringApproval = chunk => {
          if (chunk.toString() !== "y") return;
          process.stdin.off("data", duringApproval);
          onEvent({ type: "tool_execution_end", toolCallId: "parallel-read", toolName: "read", result: { content: "parallel result" }, isError: false });
          process.stderr.write("TOOL_FINISHED\\n");
        };
        process.stdin.on("data", duringApproval);
      }
      if (!await runner.askFallback("write", {})) throw new Error("approval consumed steering input");
    }
    await new Promise(resolve => setTimeout(resolve, 180));
    onEvent({ type: "message_update", message, event: { type: "text_delta", delta: " answer ends" } });
  } else {
    if (prompt.content !== "steer now") throw new Error("typed request was lost");
    onEvent({ type: "message_update", message, event: { type: "text_delta", delta: "next request answered" } });
  }
  onEvent({ type: "message_end", message });
  setTimeout(() => process.stderr.write("PROVIDER_FINISHED\\n"), 0);
} };
await startRepl({ runner });`;
		const env = { ...process.env, REIN_HOME: join(dir, "home"), NODETERM_NODE_ID: "", TERM: "xterm-256color" };
		delete env.NO_COLOR;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, env });
		let out = "", err = "", stage = 0, approved = false;
		const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
		const timer = setTimeout(() => child.kill("SIGKILL"), 6500);
		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				child.on("error", reject); child.on("close", resolve);
				child.stdout.on("data", data => {
					out += data;
					const plain = strip(out);
					if (stage === 0 && plain.includes("[OPERATOR · turn 01] ❯ ")) { stage = 1; child.stdin.write("first request\n"); }
					else if (stage === 1 && plain.includes("answer begins")) {
						stage = 2; child.stdin.write("steer now");
						if (mode === "steer") setTimeout(() => child.stdin.write("\n"), 20);
					} else if (stage === 2 && plain.includes("[OPERATOR · turn 03] ❯ ")) { stage = 3; child.stdin.end("/quit\n"); }
					if (approvalMode && !approved && plain.includes("[y/N]")) { approved = true; child.stdin.write(mode === "parallel-approval" ? "y" : "yes\n"); }
				});
				child.stderr.on("data", data => {
					err += data;
					if (stage === 2 && ((finishWhileTyping && err.includes("PROVIDER_FINISHED")) || (approvalMode && err.includes("APPROVAL_REQUESTED"))) && !err.includes("ENTER_SENT")) {
						err += "ENTER_SENT"; child.stdin.write("\n");
					}
					if (mode === "parallel-approval" && err.includes("TOOL_FINISHED") && !err.includes("APPROVAL_SENT")) {
						err += "APPROVAL_SENT"; child.stdin.write("es\n");
					}
				});
			});
			assert.equal(code, 0, out + err);
			const plain = strip(out);
			assert.match(plain, /answer begins\n\[OPERATOR · turn 02\] ❯ steer now\n/);
			assert.match(plain, /\[REIN · reply 01 ◐ · continued\]\n answer ends\n/);
			assert.equal(plain.split("first request").length - 1, 1, plain);
			assert.equal(plain.split("steer now").length - 1, 1, plain);
			assert.match(out, /\x1b\[1;36m/);
			if (mode === "parallel-approval") assert.match(plain, /\[y\/N\] yes\n\[TOOL · read · done\] parallel result\n/, "parallel completion must not split the approval answer");
			if (finishWhileTyping) { assert.match(plain, /next request answered/); assert.doesNotMatch(err, /STEERING_ACCEPTED/); }
			else assert.match(err, /STEERING_ACCEPTED/);
		} finally { clearTimeout(timer); child.kill(); rmSync(dir, { recursive: true, force: true }); }
	});
}

for (const moveCursor of [false, true]) for (const term of ["dumb", "xterm-256color"]) {
	test(`Ctrl-C discards an unfinished TTY edit (${term}, ${moveCursor ? "cursor within draft" : "cursor at end"})`, { timeout: 8000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "rein-typing-cancel-"));
		const moduleUrl = new URL("../src/harness/repl.ts", import.meta.url).href;
		const script = `Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
process.stdin.setRawMode = () => {}; process.stdout.columns = 120;
const { startRepl } = await import(${JSON.stringify(moduleUrl)});
const message = { role: "assistant", content: [], stopReason: "stop", provider: "fixture", model: "fixture", usage: { input: 0, output: 1, totalTokens: 1 }, timestamp: 0 };
let runs = 0;
const runner = { model: { provider: "fixture", id: "fixture" }, toolsMode: "native", toolsModeSource: "fixture", context: { messages: [] }, setSession() {}, steer() { throw new Error("canceled draft was steered"); },
async run(prompt, { onEvent, signal }) {
  runs++; onEvent({ type: "message_start", message });
  if (runs === 1) {
    onEvent({ type: "message_update", message, event: { type: "text_delta", delta: "ACTIVE_REPLY" } });
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    onEvent({ type: "message_end", message: { ...message, stopReason: "aborted" } });
  } else {
    process.stderr.write("NEXT_REQUEST=" + JSON.stringify(prompt.content) + "\\n");
    onEvent({ type: "message_update", message, event: { type: "text_delta", delta: "new reply" } });
    onEvent({ type: "message_end", message });
  }
} };
await startRepl({ runner });`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
			cwd: dir, env: { ...process.env, REIN_HOME: join(dir, "home"), NODETERM_NODE_ID: "", NO_COLOR: "1", TERM: term },
		});
		let out = "", err = "", stage = 0;
		const timer = setTimeout(() => child.kill("SIGKILL"), 6500);
		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				child.on("error", reject); child.on("close", resolve);
				child.stderr.on("data", data => { err += data; });
				child.stdout.on("data", data => {
					out += data;
					const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
					if (stage === 0 && plain.includes("[OPERATOR · turn 01] ❯ ")) { stage = 1; child.stdin.write("first\n"); }
					else if (stage === 1 && plain.includes("ACTIVE_REPLY")) {
						stage = 2; child.stdin.write(`draft${moveCursor ? "\x1b[D\x1b[D" : ""}\x03`);
					} else if (stage === 2 && /Reply canceled\.[\s\S]*\[OPERATOR · turn 02\] ❯ /.test(plain)) {
						stage = 3; child.stdin.write("next\n");
					} else if (stage === 3 && plain.includes("[OPERATOR · turn 03] ❯ ")) { stage = 4; child.stdin.end("/quit\n"); }
				});
			});
			assert.equal(code, 0, out + err);
			assert.match(err, /^NEXT_REQUEST="next"\n$/, "canceling must clear the edit buffer and cursor, not just hide the draft");
		} finally { clearTimeout(timer); child.kill(); rmSync(dir, { recursive: true, force: true }); }
	});
}
