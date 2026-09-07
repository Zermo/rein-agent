// Verify the app can run its local gateway with no checkout or system Node.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareLocalRuntime } from "./runtime-paths.mjs";
import { stopChild } from "./lifecycle.mjs";

const app = resolve(process.argv[2] || "");
if (!app.endsWith(".app")) throw new Error("Usage: node smoke-macos.mjs /path/to/rein-klaud.app");
const home = mkdtempSync(join(tmpdir(), "rein-macos-package-"));
const resourcesPath = join(app, "Contents/Resources"), executable = join(app, "Contents/MacOS/rein-klaud");
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
let child;
try {
  mkdirSync(join(home, "tmp"));
  const runtime = prepareLocalRuntime({ packaged: true, resourcesPath, userHome: home });
  const env = { HOME: home, REIN_HOME: runtime.home, TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ELECTRON_RUN_AS_NODE: "1" };
  const before = digest(runtime.entry);
  // A first x64 launch through Rosetta may need to translate Electron's native
  // framework. Keep the smoke bounded without mistaking that cold start for a hang.
  const cli = argv => execFileSync(executable, [runtime.entry, ...argv], { env, cwd: runtime.cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  assert.match(cli(["--help"]), /Rein|rein/);
  assert.match(cli(["skills", "ponytail"]), /ponytail/i);
  assert.match(cli(["skills", "tdd", "tests.md"]), /test/i);
  child = spawn(executable, [runtime.entry, "serve", "--port", "0"], { env, cwd: runtime.cwd, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  const url = await new Promise((resolveReady, reject) => {
    let output = "";
    const finish = error => { clearTimeout(timer); child.stdout.off("data", data); child.off("error", fail); child.off("exit", exited); if (error) reject(error); };
    const fail = () => finish(new Error("The packaged local gateway did not start."));
    const exited = () => finish(new Error("The packaged local gateway exited before readiness."));
    const data = chunk => {
      output = (output + chunk).slice(-8192);
      const found = output.match(/http:\/\/127\.0\.0\.1:([1-9]\d*)\b/);
      if (found) { finish(); child.stdout.resume(); resolveReady(found[0]); }
    };
    const timer = setTimeout(fail, 15_000);
    child.stdout.on("data", data); child.once("error", fail); child.once("exit", exited);
  });
  const token = readFileSync(join(runtime.home, "klaud", `serve-${new URL(url).port}.token`), "utf8").trim();
  const response = await fetch(`${url}/state`, { headers: { Authorization: `Bearer ${token}`, Origin: url }, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.ok(Array.isArray(state.bots));
  assert.equal(state.shell.version, 1);
  assert.equal(digest(runtime.entry), before);
  console.log("Packaged headless runtime passed: standalone CLI, bundled skills, local gateway, private state, immutable code.");
} finally {
  await stopChild(child);
  rmSync(home, { recursive: true, force: true });
}
