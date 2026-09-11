import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stopChild } from "../lifecycle.mjs";

test("stopChild terminates a running child with SIGTERM, then SIGKILL", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await new Promise(resolve => child.once("spawn", resolve));
  // main.mjs consumes both streams; do the same so close settles promptly.
  child.stdout.resume();
  child.stderr.resume();
  let exited = false;
  child.once("exit", () => { exited = true; });
  const started = Date.now();
  await stopChild(child, 2000);
  assert.equal(exited, true, "the child process must be gone after stopChild");
  assert.ok(Date.now() - started < 1900, "SIGTERM should settle well before the SIGKILL backstop");
});

test("stopChild ignores an already-finished child", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(3)"]);
  await new Promise(resolve => child.once("exit", resolve));
  await stopChild(child, 100);
  assert.equal(child.exitCode, 3);
});

test("stopChild is a no-op for missing handles", async () => {
  await stopChild(undefined);
  await stopChild(null);
  await stopChild({ pid: undefined });
});
