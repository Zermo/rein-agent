// Real engine, controlled HTTP page, shipped Node 18+ bundle. No model requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/rein.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "rein-obscura-live-"));
const env = { ...process.env, REIN_HOME: dir, OBSCURA_ALLOW_PRIVATE_NETWORK: "1" };
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, ...args], { env, cwd: dir, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
  const timer = setTimeout(() => { try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} }, 150_000);
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});
let dataHits = 0;
const server = createServer((req, res) => {
  if (req.url === "/redirect") { res.writeHead(302, { location: "/page" }); res.end(); return; }
  if (req.url === "/data") { dataHits++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ message: "Rendered through Obscura" })); return; }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><html><head><title>Loading fixture</title></head><body><main id="content">Loading</main><script>
    fetch('/data').then(r => r.json()).then(data => {
      document.title = 'Obscura fixture';
      document.getElementById('content').innerHTML = '<h1>' + data.message + '</h1><p><strong>Native markdown</strong></p><a href="/source">Source link</a><p>' + 'Long body. '.repeat(200) + '</p>';
    });
  </script></body></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const installed = await run(["web", "install", "--json"]);
  assert.equal(installed.code, 0, installed.stderr);
  const runtime = JSON.parse(installed.stdout);
  assert.equal(runtime.available, true); assert.equal(runtime.pinnedVersion, "0.2.2");
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetched = await run(["web", "fetch", `${base}/redirect`, "--max-chars", "500", "--json"]);
  assert.equal(fetched.code, 0, fetched.stderr + fetched.stdout);
  const result = JSON.parse(fetched.stdout);
  assert.equal(result.isError, undefined);
  assert.equal(result.details.backend, "obscura");
  assert.equal(result.details.finalUrl, `${base}/page`);
  assert.equal(result.details.title, "Obscura fixture");
  assert.match(result.content, /# Rendered through Obscura/);
  assert.match(result.content, /\*\*Native markdown\*\*/);
  assert.ok(result.content.includes(`[Source link](${base}/source)`));
  assert.equal(result.details.truncated, true); assert.ok(result.details.chars > 500);
  assert.equal(dataHits, 1, "The browser renders one navigation, including JavaScript fetch.");
  assert.ok(result.content.length < 750, "max_chars must bound a long, single-line body.");
  // Browser navigation may render an HTTP error page. Do not invent a status code.
  assert.equal(Object.hasOwn(result.details, "httpStatus"), false);
  const status = await run(["web", "status", "--json"]);
  assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).available, true);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ obscura: { bin: runtime.binary, allowPrivateNetwork: false } }));
  console.log(`Obscura live smoke OK (${process.platform}/${process.arch}, ${process.version})`);
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
