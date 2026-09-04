// Runs the shipped bundle on Node 18+ with no dev dependencies or provider credentials.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "rein-bundle-"));
let requests = 0;
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  requests++;
  assert.ok(body.tools.some(tool => tool.function.name === "new_context"));
  if (requests === 2) {
    assert.ok(body.messages.some(message => typeof message.content === "string" && message.content.includes("bundle handoff")));
    assert.ok(!body.messages.some(message => message.content === "original bundle prompt"));
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: requests === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "roll", type: "function", function: { name: "new_context", arguments: JSON.stringify({ handoff: "bundle handoff" }) } }] } : { role: "assistant", content: "bundle rollover OK" }, finish_reason: requests === 1 ? "tool_calls" : "stop" }] }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "dist/rein.js"), "--base-url", `http://127.0.0.1:${server.address().port}/v1`, "--model", "bundle-mock", "--tools", "native", "-p", "original bundle prompt", "--save"], { cwd: dir, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NODETERM_"))), REIN_HOME: dir } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /bundle rollover OK/);
  assert.equal(requests, 2);
  console.log(`bundle smoke OK (${process.version})`);
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
