import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readConfig } from "../ai/config.ts";
import { sshRouteArguments } from "../ai/ssh-route.ts";
import { validateSshHost } from "../ai/ssh.ts";
import { printHardwareReport } from "./report.ts";

/** Execute the shipped read-only probe over a saved SSH connection, without installing it. */
async function remoteReport(host: string): Promise<string> {
  validateSshHost(host);
  const file = fileURLToPath(import.meta.url);
  const payload = await readFile(file.endsWith(".ts") ? new URL("../../dist/rein.js", import.meta.url) : file, "utf8");
  const route = await sshRouteArguments(host);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...route, "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "PermitLocalCommand=no", "--", host, "node --input-type=module - hardware --json"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", failed = false;
    const fail = (message: string) => { if (failed) return; failed = true; child.kill("SIGKILL"); reject(new Error(message)); };
    const timer = setTimeout(() => fail("Model-host inspection timed out. Check the saved SSH route and Node.js on that host."), 12000);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 2 * 1024 * 1024) fail("Model-host inspection exceeded its output limit."); });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); fail("Could not start model-host inspection."); });
    child.on("close", code => { clearTimeout(timer); if (!failed) code === 0 ? resolve(output) : fail("Model-host inspection failed. The saved SSH host needs Node.js 18 or newer."); });
    child.stdin.end(payload);
  });
}

export function summarizeInspection(raw: string, target: "local" | "model-host") {
  let report;
  try { report = JSON.parse(raw); } catch { throw new Error("Hardware inspection did not return a valid report."); }
  if (!report?.hardware?.ram || !Array.isArray(report.models) || !report.tools) throw new Error("Hardware inspection returned an incomplete report.");
  const h = report.hardware;
  return { target, measuredAt: new Date().toISOString(), contextTokens: report.contextTokens,
    hardware: { os: h.os, arch: h.arch, cpu: h.cpu, ram: h.ram, unifiedMemory: h.unifiedMemory,
      gpus: (h.gpus ?? []).map(({ name, sharedMemory, vramTotalBytes, vramFreeBytes }) => ({ name, sharedMemory, vramTotalBytes, vramFreeBytes })) },
    tools: report.tools, best: report.best,
    models: report.models.map(({ id, name, quant, footprint, verdict, placement }) => ({ id, name, quant, footprint, verdict, placement })),
    notes: ["Memory estimates at the displayed context assume one concurrent request. They are not a generation benchmark.", ...(h.notes ?? [])] };
}

export async function inspectHardware(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => key !== "target") || !["local", "model-host"].includes(String(input.target))) throw new Error("Choose this computer or the saved model host.");
  const target = input.target as "local" | "model-host";
  let raw = "";
  if (target === "model-host") {
    const config = readConfig();
    if (typeof config.sshHost !== "string" || config.auth && (config.auth as { type?: string }).type === "cli") throw new Error("Remote hardware inspection needs a saved SSH model connection. An API URL alone cannot reveal that machine's memory.");
    raw = await remoteReport(config.sshHost);
  } else await printHardwareReport({ json: true, log: value => { raw = value; } });
  return summarizeInspection(raw, target);
}
