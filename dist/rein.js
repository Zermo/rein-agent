#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/ai/models.ts
var models_exports = {};
__export(models_exports, {
  LOCAL_SERVERS: () => LOCAL_SERVERS,
  PROVIDER_PRESETS: () => PROVIDER_PRESETS,
  apiKeyFor: () => apiKeyFor,
  discoverLocalServers: () => discoverLocalServers,
  loadConfig: () => loadConfig,
  pickDefaultModelId: () => pickDefaultModelId,
  resolveModel: () => resolveModel
});
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function pickDefaultModelId(ids) {
  if (ids.length === 0) return void 0;
  for (const re of PREFERRED_MODELS) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  const withSize = ids.map((id) => {
    const m = id.match(/(\d+(?:\.\d+)?)\s*[bBkKmMgG]\b/);
    return { id, size: m ? parseFloat(m[1]) * (m[2].toLowerCase() === "k" ? 1e-3 : 1) : -1 };
  }).filter((x) => x.size >= 7).sort((a, b) => b.size - a.size);
  if (withSize.length > 0) return withSize[0].id;
  return ids[0];
}
async function fetchJson(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return void 0;
    return await res.json();
  } catch {
    return void 0;
  } finally {
    clearTimeout(timer);
  }
}
async function discoverLocalServers() {
  const alive = [];
  for (const server of LOCAL_SERVERS) {
    let models = [];
    let data = await fetchJson(server.baseUrl + "/models");
    if (data?.data?.map) models = data.data.map((m) => m.id).filter(Boolean);
    if (models.length === 0) {
      data = await fetchJson(server.modelsEndpoint);
      if (data?.models?.map) models = data.models.map((m) => m.name ?? m.model ?? m.id).filter(Boolean);
    }
    if (models.length === 0) continue;
    alive.push({ ...server, models });
    if (alive.length >= 1 && server.provider === "ollama") continue;
  }
  return alive;
}
function apiKeyFor(provider) {
  if (provider && PROVIDER_PRESETS[provider]) {
    const envKey = process.env[PROVIDER_PRESETS[provider].keyEnv];
    if (envKey) return envKey;
  }
  const config = loadConfig();
  return config.apiKey;
}
function loadConfig() {
  const path2 = join(homedir(), ".rein", "config.json");
  try {
    if (existsSync(path2)) return JSON.parse(readFileSync(path2, "utf8"));
  } catch {
  }
  return {};
}
async function resolveModel(overrides = {}) {
  const config = loadConfig();
  const envBase = process.env.REIN_BASE_URL;
  const envModel = process.env.REIN_MODEL;
  let providerBaseUrl;
  let providerName;
  if (overrides.provider) {
    const preset = PROVIDER_PRESETS[overrides.provider.toLowerCase()];
    if (!preset) {
      throw new Error(`Unknown provider "${overrides.provider}". Known: ${Object.keys(PROVIDER_PRESETS).join(", ")}`);
    }
    providerBaseUrl = preset.baseUrl;
    providerName = overrides.provider.toLowerCase();
  }
  const baseUrl = (overrides.baseUrl ?? envBase ?? config.baseUrl ?? (providerBaseUrl ?? "")).replace(/\/$/, "");
  const modelId = overrides.model ?? envModel ?? config.model;
  if (baseUrl && modelId) {
    return {
      id: modelId,
      provider: providerName ?? (overrides.baseUrl ? "custom" : await guessProvider(baseUrl)),
      baseUrl,
      contextWindow: config.contextWindow ?? 32768,
      maxTokens: config.maxTokens ?? 4096
    };
  }
  const servers = await discoverLocalServers();
  if (servers.length > 0) {
    const server = servers[0];
    const id = modelId && server.models?.includes(modelId) ? modelId : pickDefaultModelId(server.models ?? []);
    if (id) {
      return {
        id,
        provider: server.provider,
        baseUrl: server.baseUrl,
        contextWindow: config.contextWindow ?? 32768,
        maxTokens: config.maxTokens ?? 4096
      };
    }
  }
  if (baseUrl && config.model) {
    return { id: config.model, provider: "custom", baseUrl, contextWindow: config.contextWindow ?? 32768, maxTokens: config.maxTokens ?? 4096 };
  }
  throw new Error(
    "No local AI server found.\nStart one (e.g. `ollama serve` + `ollama pull qwen2.5-coder:7b`, or LM Studio's local server), or set:\n  REIN_BASE_URL=http://localhost:11434/v1 REIN_MODEL=qwen2.5-coder:7b rein ...\nSee `rein models` for what rein can see."
  );
}
async function guessProvider(baseUrl) {
  if (baseUrl.includes("11434")) return "ollama";
  if (baseUrl.includes("1234")) return "lmstudio";
  if (baseUrl.includes("8080")) return "llamacpp";
  if (baseUrl.includes("8000")) return "vllm";
  return "openai-compatible";
}
var PROVIDER_PRESETS, LOCAL_SERVERS, PREFERRED_MODELS;
var init_models = __esm({
  "src/ai/models.ts"() {
    PROVIDER_PRESETS = {
      ollama: { baseUrl: "http://localhost:11434/v1", keyEnv: "OLLAMA_API_KEY" },
      lmstudio: { baseUrl: "http://localhost:1234/v1", keyEnv: "LMSTUDIO_API_KEY" },
      llamacpp: { baseUrl: "http://localhost:8080/v1", keyEnv: "LLAMACPP_API_KEY" },
      vllm: { baseUrl: "http://localhost:8000/v1", keyEnv: "VLLM_API_KEY" },
      openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
      deepseek: { baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
      groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
      together: { baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY" },
      openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
      mistral: { baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY" },
      fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY" },
      cerebras: { baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY" },
      huggingface: { baseUrl: "https://router.huggingface.co/v1", keyEnv: "HF_TOKEN" },
      github: { baseUrl: "https://models.inference.ai.azure.com/v1", keyEnv: "GITHUB_TOKEN" }
    };
    LOCAL_SERVERS = [
      { provider: "ollama", baseUrl: "http://localhost:11434/v1", modelsEndpoint: "http://localhost:11434/api/tags" },
      { provider: "lmstudio", baseUrl: "http://localhost:1234/v1", modelsEndpoint: "http://localhost:1234/v1/models" },
      { provider: "llamacpp", baseUrl: "http://localhost:8080/v1", modelsEndpoint: "http://localhost:8080/v1/models" },
      { provider: "vllm", baseUrl: "http://localhost:8000/v1", modelsEndpoint: "http://localhost:8000/v1/models" }
    ];
    PREFERRED_MODELS = [
      /qwen3-coder/i,
      /qwen2\.5-coder/i,
      /deepseek-coder/i,
      /gpt-oss/i,
      /llama3\.[12]-8b/i,
      /llama3\.1/i,
      /mistral/i,
      /codestral/i
    ];
  }
});

// src/hardware/profile.ts
var profile_exports = {};
__export(profile_exports, {
  gb: () => gb,
  profileHardware: () => profileHardware,
  summarizeHardware: () => summarizeHardware
});
import { execFile } from "node:child_process";
import { promisify } from "node:util";
function sh(cmd, args) {
  return execFileP(cmd, args, { timeout: 15e3, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout.trim());
}
function num(s) {
  if (!s) return void 0;
  const n = Number.parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : void 0;
}
function appleBandwidth(cpuName) {
  for (const [re, gbs, kind] of APPLE_BANDWIDTH) {
    if (re.test(cpuName)) return { gbs, note: kind === "estimate" ? "estimate" : "spec" };
  }
  return {};
}
function parseSysctlKV(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}
async function profileDarwin() {
  const key = async (k) => {
    try {
      return (await sh("sysctl", ["-n", k])).trim();
    } catch {
      return void 0;
    }
  };
  const [memsize, ncpu, physicalcpu, cpuNameRaw] = await Promise.all([
    key("hw.memsize"),
    key("hw.ncpu"),
    key("hw.physicalcpu"),
    key("machdep.cpu.brand_string")
  ]);
  const cpuName = cpuNameRaw || "Apple CPU";
  const cores = num(ncpu) ?? 0;
  const physical = num(physicalcpu) ?? cores;
  const total = num(memsize) ?? 0;
  const features = [];
  const cpuFeatures = await key("machdep.cpu.features") ?? "";
  if (/\bAVX2\b/i.test(cpuFeatures)) features.push("avx2");
  if (/\bAVX512F\b/i.test(cpuFeatures)) features.push("avx512");
  let available = total;
  try {
    const vmText = await sh("vm_stat", []);
    const page = Number(/page size of (\d+)/.exec(vmText)?.[1]) || 16384;
    const vm = parseSysctlKV(vmText);
    const free = num(vm["Pages free"]) ?? 0;
    const inactive = num(vm["Pages inactive"]) ?? 0;
    const spec = num(vm["Pages speculative"]) ?? 0;
    available = (free + inactive + spec) * page;
  } catch {
  }
  const gpus = [];
  let unified = true;
  let bw2 = {};
  try {
    const text = await sh("system_profiler", ["SPDisplaysDataType", "-json"]);
    const json = JSON.parse(text);
    const items = json?.SPDisplaysDataType ?? [];
    for (const item of items) {
      const gpu = item._items?.[0] ?? item;
      if (!gpu) continue;
      const name = gpu["_name"] ?? gpu["chipset-model"] ?? gpu["chip-model"] ?? "Apple GPU";
      const vram = num(gpu["vram-total"]) ?? num(gpu["spdisplays_vram"]);
      if (vram) {
        gpus.push({ name, vramTotalBytes: vram * 1024 ** 2 });
        unified = false;
      } else {
        gpus.push({ name });
      }
    }
  } catch {
  }
  bw2 = appleBandwidth(cpuName);
  return {
    os: `darwin ${process.env.DARWIN_VERSION ?? ""}`.trim(),
    arch: process.arch,
    cpu: { name: cpuName, cores, physicalCores: physical, features },
    ram: { totalBytes: total, availableBytes: Math.min(available, total) },
    gpus,
    unifiedMemory: unified,
    memBandwidthGBs: bw2.gbs,
    bandwidthNote: bw2.note
  };
}
async function profileLinux() {
  const read = async (p) => {
    try {
      const { readFile } = await import("node:fs/promises");
      return (await readFile(p, "utf8")).trim();
    } catch {
      return void 0;
    }
  };
  const meminfo = parseSysctlKV(await read("/proc/meminfo") ?? "");
  const total = (num(meminfo.MemTotal) ?? 0) * 1024;
  const availKB = num(meminfo.MemAvailable) ?? num(meminfo.MemFree) ?? 0;
  const available = availKB * 1024;
  const cpuinfo = await read("/proc/cpuinfo") ?? "";
  const lines = cpuinfo.split("\n");
  const name = lines.map((l) => l.match(/model name\s*:\s*(.*)/)?.[1]).find(Boolean) ?? "Linux CPU";
  let cores = lines.filter((l) => l.startsWith("processor")).length;
  if (cores === 0) {
    try {
      cores = num(await sh("nproc", [])) ?? 0;
    } catch {
    }
  }
  const flagsLine = lines.map((l) => l.match(/^flags\s*:\s*(.*)/)?.[1]).find(Boolean) ?? "";
  const features = ["avx2", "avx512f", "avx512_bf16"].filter((f) => flagsLine.includes(f));
  const gpus = [];
  try {
    const out = await sh("nvidia-smi", [
      "--query-gpu=name,memory.total,memory.free",
      "--format=csv,noheader,nounits"
    ]);
    for (const line of out.split("\n")) {
      const parts = line.split(",").map((s) => s.trim());
      if (parts.length < 3) continue;
      const [n, tot, free] = parts;
      const totB = num(tot);
      if (n && totB) gpus.push({ name: n, vramTotalBytes: totB * 1024 ** 2, vramFreeBytes: (num(free) ?? 0) * 1024 ** 2 });
    }
  } catch {
  }
  bw = {};
  return {
    os: "linux",
    arch: process.arch,
    cpu: { name, cores, physicalCores: cores, features },
    ram: { totalBytes: total, availableBytes: available },
    gpus,
    unifiedMemory: false,
    memBandwidthGBs: bw.gbs,
    bandwidthNote: bw.note
  };
}
async function profileOther() {
  const os2 = await import("node:os");
  return {
    os: `${os2.platform()} (${os2.release()})`,
    arch: os2.arch(),
    cpu: { name: os2.cpus()[0]?.model ?? "unknown", cores: os2.cpus().length, physicalCores: os2.cpus().length, features: [] },
    ram: { totalBytes: os2.totalmem(), availableBytes: os2.freemem() },
    gpus: [],
    unifiedMemory: false
  };
}
async function profileHardware() {
  if (process.platform === "darwin") return profileDarwin();
  if (process.platform === "linux") return profileLinux();
  return profileOther();
}
function gb(bytes, digits = 0) {
  const v = bytes / GiB;
  if (v >= 100) return `${Math.round(v)} GB`;
  return `${v.toFixed(digits)} GB`;
}
function summarizeHardware(p) {
  const parts = [p.cpu.name, `${p.cpu.cores} cores`];
  if (p.unifiedMemory) parts.push(`${gb(p.ram.totalBytes)} unified`);
  else parts.push(`${gb(p.ram.totalBytes)} RAM`);
  for (const g of p.gpus) {
    if (g.vramTotalBytes) parts.push(`${g.name} ${gb(g.vramTotalBytes)} VRAM`);
  }
  if (p.memBandwidthGBs) parts.push(`~${p.memBandwidthGBs} GB/s${p.bandwidthNote === "estimate" ? " (est)" : ""}`);
  return parts.join(" \xB7 ");
}
var execFileP, GiB, APPLE_BANDWIDTH;
var init_profile = __esm({
  "src/hardware/profile.ts"() {
    execFileP = promisify(execFile);
    GiB = 1024 ** 3;
    APPLE_BANDWIDTH = [
      [/M1 Pro/, 200, "spec"],
      [/M1 Max/, 400, "spec"],
      [/M1\b/, 68, "spec"],
      [/M2 Pro/, 200, "spec"],
      [/M2 Max/, 400, "spec"],
      [/M2\b/, 100, "spec"],
      [/M3 Pro/, 150, "spec"],
      [/M3 Max/, 300, "spec"],
      [/M3\b/, 100, "spec"],
      [/M4 Pro/, 273, "spec"],
      [/M4 Max/, 546, "spec"],
      [/M4\b/, 120, "spec"],
      [/M5 Pro/, 307, "estimate"],
      [/M5 Max/, 614, "estimate"],
      [/M5\b/, 153, "estimate"]
    ];
  }
});

// src/hardware/catalog.ts
var catalog_exports = {};
__export(catalog_exports, {
  CATALOG: () => CATALOG,
  matchCatalog: () => matchCatalog
});
function matchCatalog(modelId) {
  const id = modelId.toLowerCase();
  for (const m of CATALOG) {
    if (m.ollama && id === m.ollama.toLowerCase()) return m;
  }
  const norm = (s) => s.toLowerCase().replace(/[:.-]/g, "");
  for (const m of CATALOG) {
    if (m.ollama && norm(m.ollama).startsWith(norm(id).slice(0, 8))) return m;
  }
  return void 0;
}
var QUANTS, CATALOG;
var init_catalog = __esm({
  "src/hardware/catalog.ts"() {
    QUANTS = {
      q4: { label: "Q4_K_M", bytesPerWeight: 0.58 },
      q6: { label: "Q6_K", bytesPerWeight: 0.82 },
      q8: { label: "Q8_0", bytesPerWeight: 1.06 }
    };
    CATALOG = [
      {
        id: "qwen2.5-coder-7b",
        name: "Qwen2.5-Coder 7B",
        params: 7618414080,
        contextLength: 32768,
        quants: [QUANTS.q4, QUANTS.q8],
        ollama: "qwen2.5-coder:7b",
        note: "The default local coder. Fast on anything with 8 GB."
      },
      {
        id: "qwen3-8b",
        name: "Qwen3 8B",
        params: 8172701696,
        contextLength: 40960,
        quants: [QUANTS.q4, QUANTS.q8],
        ollama: "qwen3:8b",
        note: "Thinking-mode toggle; strong general tool use."
      },
      {
        id: "qwen2.5-coder-14b",
        name: "Qwen2.5-Coder 14B",
        params: 14777107968,
        contextLength: 32768,
        quants: [QUANTS.q4, QUANTS.q8],
        ollama: "qwen2.5-coder:14b",
        note: "The 16\u201324 GB sweet spot for coding agents."
      },
      {
        id: "deepseek-v2-lite-16b",
        name: "DeepSeek Coder V2 Lite 16B",
        params: 16310918144,
        contextLength: 131072,
        quants: [QUANTS.q4, QUANTS.q6],
        activeParams: 24e8,
        ollama: "deepseek-coder-v2:16b",
        note: "128k context; MoE (16.3B total, ~2.4B active) \u2014 fast for its size."
      },
      {
        id: "qwen3-30b-a3b",
        name: "Qwen3 30B-A3B (MoE)",
        params: 30532672512,
        activeParams: 3276819456,
        contextLength: 40960,
        quants: [QUANTS.q4],
        ollama: "qwen3:30b-a3b",
        note: "30B brain, 3B per token \u2014 near-14B speed if you have 20 GB."
      },
      {
        id: "gpt-oss-20b",
        name: "GPT-OSS 20B (MoE)",
        params: 21263125504,
        activeParams: 3558896128,
        contextLength: 131072,
        quants: [QUANTS.q4, { label: "MXFP4", bytesPerWeight: 0.52 }],
        ollama: "gpt-oss:20b",
        note: "Open-weight 20B; 128k context, very fast (3.6B active)."
      },
      {
        id: "qwen2.5-coder-32b",
        name: "Qwen2.5-Coder 32B",
        params: 32768210432,
        contextLength: 32768,
        quants: [QUANTS.q4, QUANTS.q6, QUANTS.q8],
        ollama: "qwen2.5-coder:32b",
        note: "The 32\u201348 GB workhorse; best dense coder in class."
      },
      {
        id: "mistral-small-24b",
        name: "Mistral Small 3.2 24B",
        params: 24333378048,
        contextLength: 131072,
        quants: [QUANTS.q4, QUANTS.q6],
        ollama: "mistral-small3.2:24b",
        note: "128k context; solid generalist tool caller."
      },
      {
        id: "gemma3-27b",
        name: "Gemma 3 27B",
        params: 27396375040,
        contextLength: 131072,
        quants: [QUANTS.q4, QUANTS.q6],
        ollama: "gemma3:27b",
        note: "128k context, vision-capable in some builds."
      },
      {
        id: "gpt-oss-120b",
        name: "GPT-OSS 120B (MoE)",
        params: 117172437504,
        activeParams: 5104399616,
        contextLength: 131072,
        quants: [QUANTS.q4, { label: "MXFP4", bytesPerWeight: 0.52 }],
        ollama: "gpt-oss:120b",
        note: "Frontier-class in a 60\u201370 GB footprint; 5B active per token."
      }
    ];
  }
});

// src/hardware/fit.ts
var fit_exports = {};
__export(fit_exports, {
  assessCatalog: () => assessCatalog,
  assessFit: () => assessFit,
  bestAssessment: () => bestAssessment,
  verdictMark: () => verdictMark
});
function reserveFor(poolBytes) {
  return Math.max(poolBytes / 10, 2 * GiB2);
}
function assessFit(profile, model, quant) {
  const active2 = model.activeParams ?? model.params;
  const weightsBytes = model.params * quant.bytesPerWeight * 1.05;
  const kvBytes = model.params * KV_PER_PARAM * (PLAN_CONTEXT / 4096);
  const totalBytes = weightsBytes + kvBytes;
  const pools = [];
  if (profile.unifiedMemory) {
    pools.push({ name: "unified", capacity: profile.ram.totalBytes, available: Math.min(profile.ram.availableBytes, profile.ram.totalBytes) });
  } else {
    for (const g of profile.gpus) {
      if (g.vramTotalBytes) pools.push({ name: "gpu", capacity: g.vramTotalBytes, available: Math.min(g.vramFreeBytes ?? g.vramTotalBytes, g.vramTotalBytes) });
    }
    pools.push({ name: "ram", capacity: profile.ram.totalBytes, available: Math.min(profile.ram.availableBytes, profile.ram.totalBytes) });
  }
  let verdict = "no";
  let placement = "ram";
  let usedReserve = 0;
  for (const pool of pools) {
    const reserve = reserveFor(pool.capacity);
    if (totalBytes + reserve <= pool.available) {
      verdict = "fits";
      placement = pool.name;
      usedReserve = reserve;
      if (pool.name === "gpu" || pool.name === "unified") break;
    } else if (verdict === "no" && totalBytes + reserve <= pool.capacity * 0.95) {
      verdict = "tight";
      placement = pool.name;
      usedReserve = reserve;
    }
  }
  const estTokS = profile.memBandwidthGBs && verdict !== "no" ? Math.round(profile.memBandwidthGBs * 1e9 / (active2 * quant.bytesPerWeight) * EFFICIENCY) : void 0;
  const estimate = `weights ${gb(totalBytes - kvBytes)} + KV ~${gb(kvBytes)} @ ${PLAN_CONTEXT / 1024}k ctx, after ${gb(usedReserve || reserveFor(8 * GiB2))} reserve`;
  return {
    model,
    quant,
    weightsBytes,
    kvBytes,
    totalBytes,
    placement,
    verdict,
    estTokS,
    estimate
  };
}
async function assessCatalog() {
  const profile = await profileHardware();
  return { profile, all: CATALOG.map((m) => ({ model: m, a: bestAssessment(profile, m) })) };
}
function bestAssessment(profile, model) {
  const ranked = model.quants.map((q) => assessFit(profile, model, q)).sort((a, b) => {
    const order = { fits: 0, tight: 1, no: 2 };
    if (order[a.verdict] !== order[b.verdict]) return order[a.verdict] - order[b.verdict];
    return a.totalBytes - b.totalBytes;
  });
  return ranked[0];
}
function verdictMark(a) {
  if (a.verdict === "fits") return a.estTokS ? `\u2713 ~${a.estTokS} tok/s` : "\u2713 fits";
  if (a.verdict === "tight") return "\u25B3 tight";
  return "\u2717 won't fit";
}
var GiB2, PLAN_CONTEXT, KV_PER_PARAM, EFFICIENCY;
var init_fit = __esm({
  "src/hardware/fit.ts"() {
    init_catalog();
    init_profile();
    GiB2 = 1024 ** 3;
    PLAN_CONTEXT = 16384;
    KV_PER_PARAM = 0.045;
    EFFICIENCY = 0.55;
  }
});

// src/util/ansi.ts
function wrap(open, close) {
  return (text) => enabled ? `\x1B[${open}m${text}\x1B[${close}m` : text;
}
var enabled, bold, dim, italic, red, green, yellow, blue, magenta, cyan, gray;
var init_ansi = __esm({
  "src/util/ansi.ts"() {
    enabled = process.stdout.isTTY && !("NO_COLOR" in process.env);
    bold = wrap(1, 22);
    dim = wrap(2, 22);
    italic = wrap(3, 23);
    red = wrap(31, 39);
    green = wrap(32, 39);
    yellow = wrap(33, 39);
    blue = wrap(34, 39);
    magenta = wrap(35, 39);
    cyan = wrap(36, 39);
    gray = wrap(90, 39);
  }
});

// src/hardware/report.ts
var report_exports = {};
__export(report_exports, {
  printHardwareReport: () => printHardwareReport
});
async function printHardwareReport(opts = {}) {
  const { profile, all: assessments } = await assessCatalog();
  const fits = assessments.filter((x) => x.a.verdict === "fits");
  const tight = assessments.filter((x) => x.a.verdict === "tight");
  const no = assessments.filter((x) => x.a.verdict === "no");
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          hardware: {
            os: profile.os,
            cpu: profile.cpu,
            ram: { total: profile.ram.totalBytes, available: profile.ram.availableBytes },
            gpus: profile.gpus,
            unifiedMemory: profile.unifiedMemory,
            memBandwidthGBs: profile.memBandwidthGBs,
            bandwidthNote: profile.bandwidthNote
          },
          models: assessments.map((x) => ({
            id: x.model.id,
            name: x.model.name,
            params: x.model.params,
            activeParams: x.model.activeParams,
            quant: x.a.quant.label,
            footprint: Math.round(x.a.totalBytes),
            placement: x.a.placement,
            verdict: x.a.verdict,
            estTokS: x.a.estTokS,
            ollama: x.model.ollama
          }))
        },
        null,
        2
      )
    );
    return 0;
  }
  console.log(bold("rein hardware"));
  console.log(`  ${profile.cpu.name} \xB7 ${profile.cpu.cores} cores${profile.cpu.features.length ? ` (${profile.cpu.features.join(", ")})` : ""}`);
  const bwLine = profile.memBandwidthGBs ? ` \xB7 ~${profile.memBandwidthGBs} GB/s${profile.bandwidthNote === "estimate" ? " (est)" : ""}` : "";
  console.log(
    profile.unifiedMemory ? `  ${gb(profile.ram.totalBytes)} unified memory (${gb(profile.ram.availableBytes)} available)${bwLine}` : `  ${gb(profile.ram.totalBytes)} RAM (${gb(profile.ram.availableBytes)} available)${bwLine}`
  );
  for (const g of profile.gpus) {
    if (g.vramTotalBytes) console.log(`  ${g.name} \xB7 ${gb(g.vramTotalBytes)} VRAM${g.vramFreeBytes != null ? ` (${gb(g.vramFreeBytes)} free)` : ""}`);
    else if (!profile.unifiedMemory) console.log(`  ${g.name} (no VRAM reported)`);
  }
  console.log("");
  const row = (x) => {
    const m = x.model;
    const moe = m.activeParams ? ` \xB7 ${Math.round(m.activeParams / 1e9)}B active` : "";
    const markPlain = verdictMark(x.a).padEnd(14);
    const mark = x.a.verdict === "fits" ? green(markPlain) : x.a.verdict === "tight" ? yellow(markPlain) : red(markPlain);
    const get = m.ollama ? `  ${dim("ollama pull " + m.ollama)}` : "";
    console.log(`  ${mark} ${m.name.padEnd(26)} ${Math.round(m.params / 1e9)}B${moe.padEnd(16)} ${x.a.quant.label.padEnd(8)} ${dim(x.a.placement)}${get}`);
  };
  if (fits.length > 0) {
    console.log(bold(`what you can run (${fits.length})`));
    fits.sort((a, b) => (b.a.estTokS ?? 0) - (a.a.estTokS ?? 0) || b.model.params - a.model.params).forEach(row);
  }
  if (tight.length > 0) {
    console.log("");
    console.log(bold("tight \u2014 fits only if other memory hogs are closed"));
    tight.forEach(row);
  }
  if (no.length > 0) {
    console.log("");
    console.log(dim(`out of reach: ${no.map((x) => x.model.name).join(", ")}`));
  }
  if (fits.length > 0) {
    const best = fits[0];
    console.log("");
    console.log(`best pick: ${bold(best.model.name)}`);
    if (best.model.ollama) console.log(`  ollama pull ${best.model.ollama}`);
    console.log(`  ${dim(best.a.estimate)}`);
  }
  console.log("");
  console.log(dim("estimates: footprint = weights + KV @ 16k ctx, 10%/2GiB reserve; tok/s = bandwidth \xD7 efficiency \u2014 directional, not a benchmark"));
  console.log(dim(`summary: ${summarizeHardware(profile)}`));
  return 0;
}
var init_report = __esm({
  "src/hardware/report.ts"() {
    init_ansi();
    init_fit();
    init_profile();
  }
});

// src/harness/doctor.ts
var doctor_exports = {};
__export(doctor_exports, {
  runDoctor: () => runDoctor
});
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname, join as join2 } from "node:path";
function sh2(cmd, opts = {}) {
  try {
    const out = execFileSync("sh", ["-c", cmd], {
      encoding: "utf8",
      timeout: opts.timeout ?? 15e3,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return { out, err: "" };
  } catch (e) {
    return { out: e.stdout?.toString() ?? "", err: (e.stderr?.toString() || e.message).slice(0, 200) };
  }
}
function gitRootOf(file, maxDepth = 4) {
  let dir = existsSync2(file) && statSync(file).isFile() ? dirname(file) : file;
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync2(join2(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return void 0;
    dir = up;
  }
  return void 0;
}
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const p = join2(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}
async function checkServerModels(baseUrl, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5e3);
  try {
    const res = await fetch(baseUrl.replace(/\/$/, "") + "/models", { signal: controller.signal });
    if (!res.ok) return { reachable: false, models: [] };
    const json = await res.json().catch(() => ({}));
    const models = (json?.data ?? []).map((m) => m?.id).filter(Boolean);
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}
async function runDoctor(opts = {}) {
  const checks = [];
  const say = (s) => {
    if (!opts.quiet) console.log(s);
  };
  const config = loadConfig();
  {
    const major = parseInt(process.versions.node.split(".")[0], 10);
    checks.push({
      name: "node",
      status: major >= 18 ? "ok" : "fail",
      detail: `v${process.versions.node}`,
      fix: major >= 18 ? void 0 : "node \u226518 required (brew install node)"
    });
  }
  let binPath;
  let repo;
  {
    const { out } = sh2("command -v rein");
    binPath = out.trim() || void 0;
    if (!binPath) {
      checks.push({ name: "bin", status: "fail", detail: "rein not on PATH", fix: "curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh | bash" });
    } else {
      let real = binPath;
      try {
        real = realpathSync(binPath);
      } catch {
      }
      repo = gitRootOf(real);
      const distOk = repo && existsSync2(join2(repo, "dist", "rein.js"));
      checks.push({
        name: "bin",
        status: distOk ? "ok" : "fail",
        detail: binPath + (repo ? ` \u2192 ${repo}` : ""),
        fix: distOk ? void 0 : "install is missing dist/rein.js \u2014 reinstall (curl one-liner above)"
      });
    }
  }
  if (repo) {
    const local = sh2("git -C " + JSON.stringify(repo) + " rev-parse HEAD").out.trim();
    const remote = sh2("git -C " + JSON.stringify(repo) + " ls-remote origin main", { timeout: 1e4 });
    if (remote.err) {
      checks.push({ name: "repo", status: "warn", detail: `@ ${local.slice(0, 7)} (offline \u2014 could not compare to origin)` });
    } else {
      const remoteSha = remote.out.trim().split(/\s+/)[0];
      checks.push({
        name: "repo",
        status: remoteSha && remoteSha === local ? "ok" : "fail",
        detail: `local ${local.slice(0, 7)} / origin ${remoteSha?.slice(0, 7) ?? "?"}`,
        fix: remoteSha && remoteSha !== local ? "git -C " + repo + " pull --ff-only" : void 0,
        autoFix: async () => {
          const r = sh2("git -C " + JSON.stringify(repo) + " pull --ff-only", { timeout: 3e4 });
          if (r.err) throw new Error(r.err);
          return "git pull --ff-only";
        }
      });
    }
  }
  if (repo) {
    const bundle = join2(repo, "dist", "rein.js");
    if (!existsSync2(bundle)) {
      checks.push({ name: "bundle", status: "fail", detail: "dist/rein.js missing", fix: "npm run bundle", autoFix: async () => {
        const r = sh2("npm run bundle --prefix " + JSON.stringify(repo), { timeout: 6e4 });
        if (r.err) throw new Error(r.err);
        return "npm run bundle";
      } });
    } else {
      const bundleMtime = statSync(bundle).mtimeMs;
      const srcMtime = newestMtime(join2(repo, "src"));
      const fresh = bundleMtime >= srcMtime;
      checks.push({
        name: "bundle",
        status: fresh ? "ok" : "fail",
        detail: fresh ? "dist is current" : "dist is older than src",
        fix: fresh ? void 0 : "npm run bundle",
        autoFix: fresh ? void 0 : async () => {
          const r = sh2("npm run bundle --prefix " + JSON.stringify(repo), { timeout: 6e4 });
          if (r.err) throw new Error(r.err);
          return "npm run bundle";
        }
      });
    }
  }
  const hasConfig = Boolean(config.model && config.baseUrl);
  checks.push({
    name: "config",
    status: hasConfig ? "ok" : "fail",
    detail: hasConfig ? `model=${config.model} base=${config.baseUrl}` : "~/.rein/config.json missing or incomplete",
    fix: hasConfig ? void 0 : "rein setup"
  });
  let models = [];
  let reachable = false;
  if (hasConfig) {
    ({ reachable, models } = await checkServerModels(config.baseUrl, config.model));
    if (!reachable) {
      checks.push({ name: "server", status: "fail", detail: `${config.baseUrl} not answering /models (5s)`, fix: "start the model server (ollama serve) or fix baseUrl" });
    } else {
      const listed = models.some((m) => m === config.model || m.startsWith(config.model));
      checks.push({
        name: "server",
        status: listed ? "ok" : "fail",
        detail: `${models.length} model(s) listed` + (listed ? ", configured model present" : `, "${config.model}" NOT listed`),
        fix: listed ? void 0 : `ollama pull ${config.model}`,
        autoFix: listed ? void 0 : async () => {
          const r = sh2(`ollama pull ${JSON.stringify(config.model)}`, { timeout: 3e5 });
          if (r.err) throw new Error(r.err);
          return `ollama pull ${config.model}`;
        }
      });
    }
  }
  const localish = /localhost|127\.0\.0\.1|192\.168\.|10\./.test(config.baseUrl ?? "");
  if (hasConfig && localish) {
    try {
      const profile = await profileHardware();
      const entry = matchCatalog(config.model);
      if (!entry) {
        checks.push({ name: "hardware", status: "ok", detail: `machine: ${profile.cpu} \xB7 ${Math.round(profile.totalMemoryBytes / 2 ** 30)} GB (model not in catalog \u2014 fit unchecked)` });
      } else {
        const fit = bestAssessment(profile, entry);
        let bestPick = "";
        if (fit.verdict === "no") {
          const fitting = CATALOG.map((m) => ({ m, a: bestAssessment(profile, m) })).filter(({ a }) => a.verdict === "fits").sort((x, y) => (y.a.estTokS ?? 0) - (x.a.estTokS ?? 0));
          bestPick = fitting.length ? fitting[0].m.name : "none fits on this machine";
        }
        checks.push({
          name: "hardware",
          status: fit.verdict === "no" ? "warn" : "ok",
          detail: `${entry.name} \u2192 ${fit.verdict} (${(fit.totalBytes / 2 ** 30).toFixed(1)} GiB footprint, est. ${fit.estTokS?.toFixed(0) ?? "?"} tok/s)`,
          fix: fit.verdict === "no" ? `best pick here: ${bestPick} (see rein hardware)` : void 0
        });
      }
    } catch {
      checks.push({ name: "hardware", status: "warn", detail: "hardware profile failed (continuing)" });
    }
  }
  const cfgPath = join2(homedir2(), ".rein", "config.json");
  if (existsSync2(cfgPath) && (config.apiKey || apiKeyFor(config.provider))) {
    const mode = lstatSync(cfgPath).mode & 511;
    checks.push({
      name: "perms",
      status: (mode & 63) === 0 ? "ok" : "warn",
      detail: `config mode ${mode.toString(8)} (apiKey present)`,
      fix: (mode & 63) === 0 ? void 0 : "chmod 600 " + cfgPath,
      autoFix: (mode & 63) === 0 ? void 0 : async () => {
        const r = sh2(`chmod 600 ${JSON.stringify(cfgPath)}`);
        if (r.err) throw new Error(r.err);
        return "chmod 600 " + cfgPath;
      }
    });
  }
  try {
    const { statfsSync } = await import("node:fs");
    const free = statfsSync(homedir2()).bavail * statfsSync(homedir2()).bsize;
    const GiB3 = free / 2 ** 30;
    checks.push({ name: "disk", status: GiB3 >= 1 ? "ok" : "warn", detail: `${GiB3.toFixed(1)} GiB free in $HOME` });
  } catch {
    checks.push({ name: "disk", status: "warn", detail: "could not statfs $HOME" });
  }
  const fixed = [];
  if (opts.fix) {
    for (const c of checks) {
      if (c.status === "fail" && c.autoFix) {
        say(dim(`fixing ${c.name}: ${c.fix ?? ""} \u2026`));
        try {
          const what = await c.autoFix();
          c.status = "ok";
          c.detail += ` (fixed: ${what})`;
          fixed.push(c.name);
          say(green(`  \u2713 ${c.name} repaired`));
        } catch (e) {
          c.detail += ` (fix failed: ${e.message?.slice(0, 80)})`;
          say(red(`  \u2717 ${c.name}: ${e.message?.slice(0, 80)}`));
        }
      }
    }
  }
  const healthy = checks.filter((c) => c.status === "ok").length;
  const result = { healthy, total: checks.length, fixed, checks };
  if (!opts.quiet) {
    for (const c of checks) {
      const mark = c.status === "ok" ? green("\u2713") : c.status === "warn" ? yellow("\u25B3") : red("\u2717");
      const fix = c.fix && c.status !== "ok" ? dim(`  \u2192 ${c.fix}`) : "";
      console.log(`  ${mark} ${c.name.padEnd(10)} ${c.detail}${fix}`);
    }
    const bad = checks.length - healthy;
    const line = bad === 0 ? green(`${healthy}/${checks.length} healthy`) + (fixed.length ? dim(` (${fixed.length} self-healed)`) : "") : red(`${healthy}/${checks.length} healthy, ${bad} problem${bad > 1 ? "s" : ""}`) + yellow(bad > 0 ? " \u2014 run `rein doctor --fix` to auto-repair" : "");
    console.log(line);
  }
  return result;
}
var init_doctor = __esm({
  "src/harness/doctor.ts"() {
    init_ansi();
    init_models();
    init_catalog();
    init_fit();
    init_profile();
  }
});

// src/util/schema.ts
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}
function matches(type, value) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  if (type === "array") return actual === "array";
  if (type === "object") return actual === "object";
  if (type === "null") return actual === "null";
  return actual === type;
}
function validateArgs(schema, args, path2 = "$") {
  if (!schema) return args;
  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(args))) {
    throw new Error(`${path2}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type) {
    if (!matches(schema.type, args)) {
      throw new Error(`${path2}: expected ${schema.type}, got ${typeOf(args)}`);
    }
  }
  if (typeof args === "number") {
    if (schema.minimum !== void 0 && args < schema.minimum) throw new Error(`${path2}: must be >= ${schema.minimum}`);
    if (schema.maximum !== void 0 && args > schema.maximum) throw new Error(`${path2}: must be <= ${schema.maximum}`);
  }
  if (typeOf(args) === "array" && schema.items) {
    for (let i = 0; i < args.length; i++) {
      validateArgs(schema.items, args[i], `${path2}[${i}]`);
    }
  }
  if (typeOf(args) === "object" && schema.properties) {
    const obj = args;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) throw new Error(`${path2}: missing required property "${key}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in obj) validateArgs(sub, obj[key], `${path2}.${key}`);
    }
  }
  return args;
}
var init_schema = __esm({
  "src/util/schema.ts"() {
  }
});

// src/agent/agent-loop.ts
function defaultConvertToLlm(messages) {
  return messages;
}
async function agentLoop(prompts, context, config, signal, emit) {
  const newMessages = [...prompts];
  const ctx = {
    get systemPrompt() {
      return context.systemPrompt;
    },
    messages: [...context.messages, ...prompts],
    tools: context.tools
  };
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }
  const maxTurns = config.maxTurns ?? 60;
  let turns = 0;
  while (true) {
    if (turns >= maxTurns) break;
    let hasMoreToolCalls = true;
    let pending = [];
    while (hasMoreToolCalls || pending.length > 0) {
      turns++;
      if (signal?.aborted) break;
      if (pending.length === 0) {
        pending = await config.getSteeringMessages?.() ?? [];
      }
      for (const message2 of pending) {
        await emit({ type: "message_start", message: message2 });
        await emit({ type: "message_end", message: message2 });
        ctx.messages.push(message2);
        newMessages.push(message2);
      }
      pending = [];
      const message = await streamAssistantResponse(ctx, config, signal, emit);
      ctx.messages.push(message);
      newMessages.push(message);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return newMessages;
      }
      if (turns >= maxTurns) {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return newMessages;
      }
      const toolCalls = message.content.filter((c) => c.type === "toolCall");
      const toolResults = [];
      hasMoreToolCalls = false;
      if (toolCalls.length > 0) {
        const batch = message.stopReason === "length" ? await failTruncatedToolCalls(toolCalls, ctx, emit) : await executeToolCalls(ctx, message, toolCalls, config, signal, emit);
        toolResults.push(...batch.messages);
        hasMoreToolCalls = !batch.terminate;
        for (const result of toolResults) {
          ctx.messages.push(result);
          newMessages.push(result);
        }
      }
      await emit({ type: "turn_end", message, toolResults });
      if (config.shouldStopAfterTurn?.({ message, context: ctx })) {
        await emit({ type: "agent_end", messages: newMessages });
        return newMessages;
      }
      pending = await config.getSteeringMessages?.() ?? [];
    }
    const followUps = await config.getFollowUpMessages?.() ?? [];
    if (followUps.length > 0) {
      pending = followUps;
      continue;
    }
    break;
  }
  await emit({ type: "agent_end", messages: newMessages });
  return newMessages;
}
async function streamAssistantResponse(ctx, config, signal, emit) {
  let messages = ctx.messages;
  if (config.transformContext) messages = await config.transformContext(messages, signal) ?? messages;
  const llmMessages = (config.convertToLlm ?? defaultConvertToLlm)(messages);
  const llmContext = {
    systemPrompt: ctx.systemPrompt,
    messages: llmMessages,
    tools: ctx.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  };
  const response = await config.streamFn(config.model, llmContext, {
    ...config.streamOptions,
    signal
  });
  for await (const event of response) {
    switch (event.type) {
      case "start":
        await emit({ type: "message_start", message: { ...event.partial } });
        break;
      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_end":
        await emit({ type: "message_update", message: { ...event.partial }, event });
        break;
      case "done":
      case "error": {
        const final2 = await response.result();
        await emit({ type: "message_end", message: final2 });
        return final2;
      }
    }
  }
  const final = await response.result();
  await emit({ type: "message_end", message: final });
  return final;
}
async function failTruncatedToolCalls(toolCalls, ctx, emit) {
  const messages = [];
  for (const tc of toolCalls) {
    await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
    const result = {
      content: `Tool call "${tc.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue it with complete arguments.`,
      isError: true
    };
    await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError: true });
    const msg = {
      role: "toolResult",
      toolCallId: tc.id,
      toolName: tc.name,
      content: [{ type: "text", text: result.content }],
      isError: true,
      timestamp: Date.now()
    };
    await emit({ type: "message_start", message: msg });
    await emit({ type: "message_end", message: msg });
    messages.push(msg);
  }
  return { messages, terminate: false };
}
async function executeToolCalls(ctx, assistantMessage, toolCalls, config, signal, emit) {
  const hasSequential = toolCalls.some((tc) => ctx.tools.find((t) => t.name === tc.name)?.executionMode === "sequential");
  if (config.toolExecution === "sequential" || hasSequential) {
    return executeSequential(ctx, assistantMessage, toolCalls, config, signal, emit);
  }
  return executeParallel(ctx, assistantMessage, toolCalls, config, signal, emit);
}
async function runOne(tc, ctx, assistantMessage, config, signal, emit) {
  await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });
  const tool = ctx.tools.find((t) => t.name === tc.name);
  if (!tool) {
    const result2 = { content: `Tool "${tc.name}" not found. Available: ${ctx.tools.map((t) => t.name).join(", ")}`, isError: true };
    await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result: result2, isError: true });
    return { toolCallId: tc.id, toolName: tc.name, result: result2, isError: true };
  }
  let args = tc.arguments ?? {};
  try {
    args = validateArgs(tool.parameters, args);
  } catch (err) {
    const result2 = { content: `Invalid arguments for "${tc.name}": ${err.message}`, isError: true };
    await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result: result2, isError: true });
    return { toolCallId: tc.id, toolName: tc.name, result: result2, isError: true };
  }
  const before = await config.beforeToolCall?.({ assistantMessage, toolCall: tc, args, context: ctx });
  if (before?.block) {
    const result2 = { content: before.reason ?? "Tool execution was blocked", isError: true };
    await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result: result2, isError: true });
    return { toolCallId: tc.id, toolName: tc.name, result: result2, isError: true };
  }
  if (signal?.aborted) {
    const result2 = { content: "Operation aborted", isError: true };
    await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result: result2, isError: true });
    return { toolCallId: tc.id, toolName: tc.name, result: result2, isError: true };
  }
  let result;
  let isError = false;
  try {
    result = await tool.execute(
      tc.id,
      args,
      signal,
      (partial) => {
        void emit({ type: "tool_execution_update", toolCallId: tc.id, toolName: tc.name, partial });
      }
    );
  } catch (err) {
    result = { content: err.message ?? String(err), isError: true };
    isError = true;
  }
  const after = config.afterToolCall?.({ assistantMessage, toolCall: tc, args, result, isError, context: ctx });
  if (after) {
    result = { ...result, ...after };
    isError = after.isError ?? isError;
  }
  await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError });
  return { toolCallId: tc.id, toolName: tc.name, result, isError };
}
async function executeSequential(ctx, assistantMessage, toolCalls, config, signal, emit) {
  const finalized = [];
  for (const tc of toolCalls) {
    if (signal?.aborted) break;
    finalized.push(await runOne(tc, ctx, assistantMessage, config, signal, emit));
  }
  const messages = await toToolResultMessages(finalized, emit);
  return { messages, terminate: allTerminate(finalized) };
}
async function executeParallel(ctx, assistantMessage, toolCalls, config, signal, emit) {
  const ready = [];
  const immediate = [];
  for (const tc of toolCalls) {
    if (signal?.aborted) break;
    ready.push(tc);
  }
  const settled = await Promise.all(ready.map((tc) => runOne(tc, ctx, assistantMessage, config, signal, emit)));
  const finalized = [...immediate, ...settled];
  const messages = await toToolResultMessages(finalized, emit);
  return { messages, terminate: allTerminate(finalized) };
}
async function toToolResultMessages(finalized, emit) {
  const messages = [];
  for (const call2 of finalized) {
    const msg = {
      role: "toolResult",
      toolCallId: call2.toolCallId,
      toolName: call2.toolName,
      content: [{ type: "text", text: call2.result.content }],
      isError: call2.isError,
      timestamp: Date.now()
    };
    await emit({ type: "message_start", message: msg });
    await emit({ type: "message_end", message: msg });
    messages.push(msg);
  }
  return messages;
}
function allTerminate(finalized) {
  return finalized.length > 0 && finalized.every((f) => f.result.terminate === true);
}
var init_agent_loop = __esm({
  "src/agent/agent-loop.ts"() {
    init_schema();
  }
});

// src/ai/event-stream.ts
var EventStream, AssistantMessageEventStream;
var init_event_stream = __esm({
  "src/ai/event-stream.ts"() {
    EventStream = class {
      queue = [];
      waiting = [];
      done = false;
      finalResultPromise;
      resolveFinalResult;
      isComplete;
      extractResult;
      constructor(isComplete, extractResult) {
        this.isComplete = isComplete ?? (() => false);
        this.extractResult = extractResult ?? ((event) => event);
        this.finalResultPromise = new Promise((resolve4) => {
          this.resolveFinalResult = resolve4;
        });
      }
      push(event) {
        if (this.done) return;
        if (this.isComplete(event)) {
          this.done = true;
          try {
            this.resolveFinalResult(this.extractResult(event));
          } catch {
          }
        }
        const waiter = this.waiting.shift();
        if (waiter) waiter({ value: event, done: false });
        else this.queue.push(event);
      }
      end(result) {
        if (this.done) return;
        this.done = true;
        if (result !== void 0) this.resolveFinalResult(result);
        while (this.waiting.length > 0) {
          this.waiting.shift()({ value: void 0, done: true });
        }
      }
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (this.queue.length > 0) yield this.queue.shift();
          else if (this.done) return;
          else {
            const result = await new Promise((resolve4) => this.waiting.push(resolve4));
            if (result.done) return;
            yield result.value;
          }
        }
      }
      get finished() {
        return this.done;
      }
      result() {
        return this.finalResultPromise;
      }
    };
    AssistantMessageEventStream = class extends EventStream {
      constructor() {
        super(
          (event) => event.type === "done" || event.type === "error",
          (event) => {
            if (event.type === "done") return event.message;
            if (event.type === "error") return event.error;
            throw new Error("Unexpected final event type");
          }
        );
      }
    };
  }
});

// src/ai/sse.ts
async function* sseDataLines(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, newline).replace(/\r$/, "");
        buf = buf.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trimStart();
        if (data === "[DONE]") return;
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
var init_sse = __esm({
  "src/ai/sse.ts"() {
  }
});

// src/util/json-salvage.ts
function isControl(c) {
  const cp = c.codePointAt(0);
  return cp >= 0 && cp <= 31;
}
function escapeControl(c) {
  switch (c) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "	":
      return "\\t";
    default:
      return `\\u${c.codePointAt(0).toString(16).padStart(4, "0")}`;
  }
}
function repairJson(json) {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    if (ch === "\\") {
      const next = json[i + 1];
      if (next === void 0) {
        out += "\\\\";
        continue;
      }
      if (next === "u") {
        const hex = json.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += `\\u${hex}`;
          i += 5;
          continue;
        }
      }
      if (VALID_ESCAPES.has(next)) {
        out += `\\${next}`;
        i += 1;
        continue;
      }
      out += "\\\\";
      continue;
    }
    out += isControl(ch) ? escapeControl(ch) : ch;
  }
  return out;
}
function stripTrailingCommas(json) {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < json.length) {
        out += json[i + 1];
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j++;
      if (j < json.length && (json[j] === "}" || json[j] === "]")) continue;
    }
    out += ch;
  }
  return out;
}
function closeOpenBrackets(json) {
  let depth = [];
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth.push(ch);
    else if (ch === "}") {
      if (depth[depth.length - 1] === "{") depth.pop();
    } else if (ch === "]") {
      if (depth[depth.length - 1] === "[") depth.pop();
    }
  }
  let suffix = "";
  if (inString) suffix += '"';
  for (let i = depth.length - 1; i >= 0; i--) suffix += depth[i] === "{" ? "}" : "]";
  return json + suffix;
}
function extractFirstObject(json) {
  const start = json.indexOf("{");
  if (start === -1) return void 0;
  let depth = 0;
  let inString = false;
  for (let i = start; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return json.slice(start, i + 1);
    }
  }
  return void 0;
}
function parseArgsSalvaged(json) {
  if (!json || json.trim() === "") return {};
  const attempts = [];
  const obj = extractFirstObject(json.trim());
  if (obj) attempts.push(obj);
  attempts.push(json, repairJson(json), stripTrailingCommas(repairJson(json)), closeOpenBrackets(stripTrailingCommas(repairJson(json))));
  for (const candidate of attempts) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
    }
  }
  return {};
}
var VALID_ESCAPES;
var init_json_salvage = __esm({
  "src/util/json-salvage.ts"() {
    VALID_ESCAPES = /* @__PURE__ */ new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
  }
});

// src/ai/openai-completions.ts
function toOpenAIMessage(message) {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant": {
      const text = message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      const calls = message.content.filter((c) => c.type === "toolCall");
      const out = { role: "assistant", content: text.length > 0 ? text : null };
      if (calls.length > 0) {
        out.tool_calls = calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }
        }));
      }
      return out;
    }
    case "toolResult":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content.map((c) => c.text).join("\n")
      };
  }
}
function parseTextToolCalls(text) {
  const toolCalls = [];
  let match;
  let cleanText = text;
  let seq = 0;
  while ((match = TOOL_BLOCK_RE.exec(text)) !== null) {
    const name = match[1];
    const rawArgs = match[2];
    const args = parseArgsSalvaged(rawArgs.trim());
    if (Object.keys(args).length === 0) {
      continue;
    }
    toolCalls.push({ type: "toolCall", id: `call_${Date.now()}_${seq++}`, name, arguments: args });
  }
  if (toolCalls.length > 0) {
    cleanText = text.replace(TOOL_BLOCK_RE, (_m) => "").replace(/\n{3,}/g, "\n\n").trim();
  }
  return { toolCalls, cleanText };
}
function stream(model, context, options = {}) {
  const out = new AssistantMessageEventStream();
  void (async () => {
    const message = {
      role: "assistant",
      content: [],
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, totalTokens: 0 },
      stopReason: "pending",
      timestamp: Date.now()
    };
    const emit = (event) => out.push(event);
    try {
      const toolsMode = options.toolsMode ?? "native";
      const hasTools = (context.tools?.length ?? 0) > 0;
      const messages = [];
      const systemParts = [];
      if (context.systemPrompt) systemParts.push(context.systemPrompt);
      if (toolsMode === "text" && hasTools) systemParts.push(TEXT_TOOL_INSTRUCTIONS);
      if (systemParts.length > 0) messages.push({ role: "system", content: systemParts.join("\n\n") });
      for (const m of context.messages) {
        const converted = toOpenAIMessage(m);
        if (Array.isArray(converted)) messages.push(...converted);
        else messages.push(converted);
      }
      const body = {
        model: model.id,
        messages,
        stream: true
      };
      if (typeof options.temperature === "number") body.temperature = options.temperature;
      if (typeof options.topP === "number") body.top_p = options.topP;
      if (typeof options.maxTokens === "number") body.max_tokens = options.maxTokens;
      else body.max_tokens = model.maxTokens || 4096;
      if (options.includeUsage !== false) body.stream_options = { include_usage: true };
      if (options.extra) Object.assign(body, options.extra);
      if (toolsMode === "native" && hasTools) {
        body.tools = (context.tools ?? []).map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters }
        }));
      }
      const headers = {
        "Content-Type": "application/json",
        ...options.headers
      };
      if (options.apiKey) headers["Authorization"] = `Bearer ${options.apiKey}`;
      let response;
      try {
        response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options.signal
        });
      } catch (err) {
        if (err.name === "AbortError") {
          message.stopReason = "aborted";
          emit({ type: "error", reason: "aborted", error: message });
          return;
        }
        throw err;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        message.stopReason = "error";
        message.errorMessage = `HTTP ${response.status} from ${model.baseUrl}: ${text.slice(0, 800)}`;
        emit({ type: "error", reason: "error", error: message });
        return;
      }
      emit({ type: "start", partial: message });
      const ct = (response.headers.get("content-type") ?? "").toLowerCase();
      let dataLines;
      if (ct.includes("json")) {
        const doc = JSON.parse(await response.text());
        if (doc?.choices?.[0]?.message) doc.choices[0].delta = doc.choices[0].message;
        dataLines = [JSON.stringify(doc)];
      } else {
        dataLines = sseDataLines(response.body);
      }
      let textBlock = null;
      let thinkingBlock = null;
      let contentIndex = -1;
      const nextIndex = () => ++contentIndex;
      const textToolCalls = /* @__PURE__ */ new Map();
      let finishReason = null;
      const ensureTextBlock = () => {
        if (!textBlock) {
          textBlock = { type: "text", text: "" };
          message.content.push(textBlock);
          emit({ type: "text_start", contentIndex: nextIndex(), partial: message });
        }
        return textBlock;
      };
      const ensureThinkingBlock = () => {
        if (!thinkingBlock) {
          thinkingBlock = { type: "thinking", thinking: "" };
          message.content.push(thinkingBlock);
          emit({ type: "thinking_start", contentIndex: nextIndex(), partial: message });
        }
        return thinkingBlock;
      };
      for await (const data of dataLines) {
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) {
          const u = {
            input: chunk.usage.prompt_tokens ?? 0,
            output: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0
          };
          if (typeof chunk.usage.completion_tokens_details?.reasoning_tokens === "number") {
            u.reasoning = chunk.usage.completion_tokens_details.reasoning_tokens;
          }
          message.usage = u;
        }
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : void 0;
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          const block = ensureTextBlock();
          block.text += delta.content;
          emit({ type: "text_delta", contentIndex: message.content.indexOf(block), delta: delta.content, partial: message });
        }
        const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : typeof delta.thinking === "string" ? delta.thinking : "";
        if (reasoning) {
          const block = ensureThinkingBlock();
          block.thinking += reasoning;
          emit({ type: "thinking_delta", contentIndex: message.content.indexOf(block), delta: reasoning, partial: message });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            let st = textToolCalls.get(idx);
            if (!st) {
              st = { id: "", name: "", args: "" };
              textToolCalls.set(idx, st);
            }
            if (tc.id) st.id = tc.id;
            if (tc.function?.name) st.name += tc.function.name;
            if (typeof tc.function?.arguments === "string") st.args += tc.function.arguments;
          }
        }
      }
      if (textBlock) emit({ type: "text_end", contentIndex: message.content.indexOf(textBlock), content: textBlock.text, partial: message });
      if (thinkingBlock) emit({ type: "thinking_end", contentIndex: message.content.indexOf(thinkingBlock), content: thinkingBlock.thinking, partial: message });
      const toolCalls = [];
      if (toolsMode === "text" && textBlock) {
        const { toolCalls: parsed, cleanText } = parseTextToolCalls(textBlock.text);
        if (parsed.length > 0) {
          textBlock.text = cleanText;
          for (const tc of parsed) toolCalls.push(tc);
        }
      } else {
        const sorted = [...textToolCalls.entries()].sort((a, b) => a[0] - b[0]);
        for (const [, st] of sorted) {
          toolCalls.push({
            type: "toolCall",
            id: st.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            name: st.name,
            arguments: parseArgsSalvaged(st.args)
          });
        }
      }
      for (const tc of toolCalls) {
        message.content.push(tc);
        emit({ type: "toolcall_end", contentIndex: message.content.indexOf(tc), toolCall: tc, partial: message });
      }
      if (message.usage.totalTokens === 0) {
        const chars = message.content.reduce((n, c) => n + ("text" in c ? c.text.length : "thinking" in c ? c.thinking.length : 0), 0);
        message.usage = { input: 0, output: Math.ceil(chars / 4), totalTokens: Math.ceil(chars / 4) };
      }
      if (finishReason === "tool_calls" || finishReason === "tool_use" || toolCalls.length > 0) {
        message.stopReason = "toolUse";
      } else if (finishReason === "length") {
        message.stopReason = "length";
      } else if (finishReason === "stop" || finishReason === null || finishReason === "content_filter") {
        message.stopReason = "stop";
      } else {
        message.stopReason = finishReason === "aborted" ? "aborted" : "stop";
      }
      if (message.stopReason === "aborted") {
        emit({ type: "error", reason: "aborted", error: message });
      } else {
        emit({ type: "done", reason: message.stopReason, message });
      }
    } catch (err) {
      message.stopReason = "error";
      message.errorMessage = err?.message ?? String(err);
      emit({ type: "error", reason: "error", error: message });
    }
  })();
  return out;
}
var TEXT_TOOL_INSTRUCTIONS, TOOL_BLOCK_RE;
var init_openai_completions = __esm({
  "src/ai/openai-completions.ts"() {
    init_event_stream();
    init_sse();
    init_json_salvage();
    TEXT_TOOL_INSTRUCTIONS = `
To use a tool, write a tool block exactly like this (one block per tool, valid JSON inside):

<tool name="bash">
{"command": "ls -la"}
</tool>

Rules for tool blocks:
- The JSON inside must be a single complete JSON object.
- Put each tool block on its own lines. No markdown fences around them.
- After writing tool blocks, wait for the results before continuing.
`;
    TOOL_BLOCK_RE = /<tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool>/g;
  }
});

// src/ai/compat.ts
import { readFileSync as readFileSync2, writeFileSync, mkdirSync, existsSync as existsSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
function readStore() {
  try {
    if (existsSync3(storePath())) return JSON.parse(readFileSync2(storePath(), "utf8"));
  } catch {
  }
  return {};
}
function keyFor(provider, modelId) {
  return `${provider}/${modelId}`;
}
function decideToolMode(provider, modelId, forced = "auto") {
  const key = keyFor(provider, modelId);
  const store = readStore();
  if (forced !== "auto") {
    const mode = { mode: forced, source: "forced" };
    try {
      mkdirSync(join3(homedir3(), ".rein"), { recursive: true });
      store[key] = mode;
      writeFileSync(storePath(), JSON.stringify(store, null, 2));
    } catch {
    }
    return mode;
  }
  const learned = store[key];
  if (learned?.source === "runtime" || learned?.source === "forced") return learned;
  for (const re of NATIVE_NO) if (re.test(modelId)) return { mode: "text", source: "table" };
  for (const re of NATIVE_OK) if (re.test(modelId)) return { mode: "native", source: "table" };
  if (learned) return learned;
  return { mode: "native", source: "default" };
}
function recordDecision(provider, modelId, mode, source) {
  try {
    mkdirSync(join3(homedir3(), ".rein"), { recursive: true });
    const store = readStore();
    store[keyFor(provider, modelId)] = { mode, source };
    writeFileSync(storePath(), JSON.stringify(store, null, 2));
  } catch {
  }
}
function looksLikeBrokenNativeTools(toolCalls) {
  if (toolCalls.length === 0) return false;
  const allEmpty = toolCalls.every((tc) => Object.keys(tc.arguments ?? {}).length === 0);
  const anyUnnamed = toolCalls.some((tc) => !tc.name);
  return allEmpty || anyUnnamed;
}
var NATIVE_OK, NATIVE_NO, storePath;
var init_compat = __esm({
  "src/ai/compat.ts"() {
    NATIVE_OK = [
      /qwen[23]/i,
      /llama3\.[123]/i,
      /deepseek/i,
      /gpt-[345]/i,
      /gpt-oss/i,
      /mistral/i,
      /mixtral/i,
      /codestral/i,
      /gemma[23]/i,
      /phi[-_]?4/i,
      /granite/i,
      /llama[-_]?4/i,
      /olmo/i,
      /command-r/i,
      /command[-_]?a/i,
      /starcoder2/i,
      /codegemma/i,
      /glm[-_]?4/i,
      /minicpm[-_]?3/i
    ];
    NATIVE_NO = [
      /tinyllama/i,
      /tiny[-_]?dolphin/i,
      /qwen0\.[0-9]+b/i,
      /qwen[12][-_.]?[0-9]+b/i,
      /gemma-?[12]b?/i,
      /phi[-_]?2/i,
      /phi[-_]?3-mini/i,
      /llama3\.2[-_]?1b/i,
      /llama[-_]?1b/i,
      /smollm/i,
      /mistral[-_]?7b[-_]?instruct[-_]?v0\.1/i,
      /falcon[-_]?7b/i,
      /redpajama/i,
      /openchat[-_]?3\.5/i,
      /starcoder[-_]?1b/i
    ];
    storePath = () => join3(homedir3(), ".rein", "capabilities.json");
  }
});

// src/harness/system-prompt.ts
import { existsSync as existsSync4 } from "node:fs";
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join4 } from "node:path";
function readProjectInstructions(cwd) {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const path2 = join4(cwd, name);
    if (existsSync4(path2)) {
      const text = readFileSync3(path2, "utf8").trim();
      if (text) return `Project instructions:
${text}`;
    }
  }
  return void 0;
}
function readLessons(cwd) {
  const path2 = join4(cwd, "LESSONS.md");
  if (!existsSync4(path2)) return void 0;
  const text = readFileSync3(path2, "utf8").trim();
  if (!text) return void 0;
  return `Lessons from previous sessions (trust but verify):
${text.slice(0, 4e3)}`;
}
function buildSystemPrompt(cwd) {
  const parts = [
    WHO,
    "",
    VOICE,
    "",
    WORK,
    "",
    WEB,
    "",
    GATES,
    "",
    SELF_IMPROVE,
    "",
    ENV(cwd, process.platform === "darwin" ? `macOS (${process.arch})` : `${process.platform} (${process.arch})`)
  ];
  const project = readProjectInstructions(cwd);
  if (project) parts.push("", project);
  const lessons = readLessons(cwd);
  if (lessons) parts.push("", lessons);
  return parts.join("\n");
}
function buildImprovePrompt(repoDir) {
  return [
    `You are improving rein \u2014 this agent harness \u2014 in place. The repo is at ${repoDir} and you are working in it.`,
    "",
    VOICE,
    "",
    `Ground rules for self-improvement:
- One focused change per iteration. The smallest change that addresses one named weakness.
- The weakness must be concrete: a line from LESSONS.md ("## harness"), a failing test, or an observed behavior. No vibes-driven refactors.
- After the change, run: node --experimental-strip-types test/smoke.ts \u2014 it must pass. If it doesn't, the change is broken.
- Keep the code dependency-free and the files small. This codebase is a feature, not a cost.
- Update the section of the README you changed, and append one line to LESSONS.md recording what you fixed.
- If you find nothing worth improving, say so plainly and stop. An honest "no change" is a valid result.`
  ].join("\n");
}
var WHO, VOICE, WORK, WEB, GATES, SELF_IMPROVE, ENV;
var init_system_prompt = __esm({
  "src/harness/system-prompt.ts"() {
    WHO = `You are rein \u2014 a coding agent with a small, sharp toolset. You run on local AI by default and are expected to be useful without internet.`;
    VOICE = `How you talk (non-negotiable):
- Like a person, not a product. First person, contractions, no filler.
- No "Great question!", no "Certainly!", no "I hope this helps", no emoji unless the user used some first.
- No throat-clearing. Don't narrate your next step before taking it; just take it, then report what happened.
- Short answer for a small ask. One crisp paragraph beats three sections.
- Have a point of view. If an approach is a bad idea, say so and say why \u2014 the user hired an engineer, not a search engine.
- When something fails, say exactly what failed, what you tried, and what's next. No hedging ("it might be possible that...").
- Match the user's register. Terse user, terse you. Casual user, warm and brief.
- In chat replies, never start with "As an AI" or "As a language model".`;
    WORK = `How you work:
- Read before you write. Look at the actual file or run the actual command before changing anything.
- Small, verifiable steps. After a change, prove it (run it, test it) rather than assuming it works.
- Use the tools for facts: read for file contents, bash for commands and output, grep/find for locating. Don't guess file contents from memory.
- If a tool fails, read the error, change exactly one thing, retry. Don't retry the same failing action three times.
- Keep tool output under control: pipe to head/tail, use offset/limit on big reads, grep before reading huge files.
- When asked to create a file, create it. When asked a question, answer it first, then do the work if any.`;
    WEB = `Web (TinyFish):
- web_search finds pages (fresh, never cached); web_fetch reads one page into clean markdown.
- Search first, then fetch only the 1-2 most promising URLs \u2014 not everything.
- When you report a web-sourced fact, name the URL you got it from.
- If a web tool says the key is missing, say so plainly: set TINYFISH_API_KEY (free at tinyfish.ai), or add it to ~/.rein/config.json under {"tinyfish": {"apiKey": ...}}.`;
    GATES = `Substantial work (unlazy gates):
- When the cost of quietly ending up half-done justifies a ledger: write GATES.md BEFORE implementing \u2014 one observable outcome per gate, each with a CHECK command that prints a success-only marker, and an EXPECT matching that marker. Template: vendor/unlazy/templates/gates-leaf.md.
- Then: gates mode=lint (catch oracles that cannot fail), work, gates mode=approve (runs the approved oracles), and gates mode=reverify before you report done \u2014 re-running is the proof, not remembering it ran.
- Multi-part work: split at natural boundaries; each leaf gets its own ledger (the method is vendor/unlazy/SKILL.md).
- Never report done with an unmet gate. Report met/unmet counts; an abandoned gate is a handoff, not completion. Trivial edit? No ledger needed.`;
    SELF_IMPROVE = `Self-improvement (this is part of the job, not a bonus):
- If you learn something durable in this session \u2014 a quirk of this model, a bug pattern, a command that works, a user preference \u2014 append one line to LESSONS.md in the project root (create it if missing). One line, actionable, no preamble.
- LESSONS.md is shared memory across sessions. Read it before starting non-trivial work.
- If the rein harness itself did something clunky for you (a tool result that was hard to use, a confusing error, a missing flag), note it under a "## harness" section in LESSONS.md \u2014 the rein improve loop reads that file.`;
    ENV = (cwd, platform) => `Environment:
- Working directory: ${cwd}
- Platform: ${platform}
- Today: ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
  }
});

// src/harness/tools/read.ts
import { readFileSync as readFileSync4 } from "node:fs";
var readTool, read_default;
var init_read = __esm({
  "src/harness/tools/read.ts"() {
    readTool = {
      name: "read",
      description: "Read the contents of a file. Use offset/limit for large files. Returns truncated output with a notice when cut.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to read (relative to cwd or absolute)" },
          offset: { type: "integer", minimum: 1, description: "Line number to start reading from (1-indexed)" },
          limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read" }
        },
        required: ["path"]
      },
      execute: async (_id, args) => {
        const path2 = args.path;
        let text;
        try {
          text = readFileSync4(path2, "utf8");
        } catch (err) {
          return { content: `read failed: ${err.message}`, isError: true };
        }
        let lines = text.split("\n");
        const offset = typeof args.offset === "number" ? args.offset : 1;
        const limit = typeof args.limit === "number" ? args.limit : 2e3;
        let sliced = false;
        if (offset > 1 || limit < lines.length) {
          lines = lines.slice(offset - 1, offset - 1 + limit);
          sliced = true;
        }
        let out = lines.map((l, i) => `${String(offset + i).padStart(6)}	${l}`).join("\n");
        const total = text.split("\n").length;
        if (sliced) out += `
[showing lines ${offset}-${offset + lines.length - 1} of ${total} \u2014 use offset/limit for more]`;
        if (out.length > 25e3) {
          const half = 1e4;
          out = out.slice(0, half) + `
\u2026 [${out.length - 2 * half} chars truncated \u2014 read a slice with offset/limit] \u2026
` + out.slice(out.length - half);
        }
        return { content: out };
      }
    };
    read_default = readTool;
  }
});

// src/harness/tools/write.ts
import { writeFileSync as writeFileSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
var writeTool, write_default;
var init_write = __esm({
  "src/harness/tools/write.ts"() {
    writeTool = {
      name: "write",
      description: "Write content to a file. Creates the file if missing, overwrites if present. Parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to write (relative to cwd or absolute)" },
          content: { type: "string", description: "Full content to write" }
        },
        required: ["path", "content"]
      },
      execute: async (_id, args) => {
        const path2 = args.path;
        const content = args.content;
        try {
          mkdirSync2(dirname2(path2), { recursive: true });
          writeFileSync2(path2, content);
        } catch (err) {
          return { content: `write failed: ${err.message}`, isError: true };
        }
        const lines = content.split("\n").length;
        return { content: `Wrote ${content.length} chars (${lines} lines) to ${path2}` };
      }
    };
    write_default = writeTool;
  }
});

// src/harness/tools/edit.ts
import { readFileSync as readFileSync5, writeFileSync as writeFileSync3 } from "node:fs";
function countOccurrences(text, needle) {
  let count = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    count++;
    i = text.indexOf(needle, i + 1);
  }
  return count;
}
var editTool, edit_default;
var init_edit = __esm({
  "src/harness/tools/edit.ts"() {
    editTool = {
      name: "edit",
      description: "Edit a file with exact text replacement. Each edit's oldText must match a unique, non-overlapping region of the original file. For changes near each other, merge them into one edit.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to edit" },
          edits: {
            type: "array",
            description: "One or more targeted replacements",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string", description: "Exact text to find (must be unique in the file)" },
                newText: { type: "string", description: "Replacement text" }
              },
              required: ["oldText", "newText"]
            }
          }
        },
        required: ["path", "edits"]
      },
      execute: async (_id, args) => {
        const path2 = args.path;
        const edits = args.edits;
        let text;
        try {
          text = readFileSync5(path2, "utf8");
        } catch (err) {
          return { content: `edit failed: ${err.message}`, isError: true };
        }
        const ranges = [];
        for (const edit of edits) {
          const first = text.indexOf(edit.oldText);
          if (first === -1) {
            return {
              content: `edit failed: oldText not found in ${path2}. Make sure it matches the file exactly, including whitespace.`,
              isError: true
            };
          }
          const second = text.indexOf(edit.oldText, first + 1);
          if (second !== -1) {
            return {
              content: `edit failed: oldText occurs ${countOccurrences(text, edit.oldText)} times in ${path2}. Add more surrounding context to make it unique.`,
              isError: true
            };
          }
          const range = { start: first, end: first + edit.oldText.length };
          if (ranges.some((r) => range.start < r.end && r.start < range.end)) {
            return { content: `edit failed: edits overlap in ${path2}. Merge nearby changes into one edit.`, isError: true };
          }
          ranges.push(range);
        }
        const ordered = ranges.map((r, i) => ({ r, edit: edits[i] })).sort((a, b) => b.r.start - a.r.start);
        for (const { r, edit } of ordered) {
          text = text.slice(0, r.start) + edit.newText + text.slice(r.end);
        }
        try {
          writeFileSync3(path2, text);
        } catch (err) {
          return { content: `edit failed: ${err.message}`, isError: true };
        }
        return { content: `Replaced ${edits.length} block(s) in ${path2}` };
      }
    };
    edit_default = editTool;
  }
});

// src/util/truncate.ts
function truncateLines(text, maxLines = 500) {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false, originalLength: lines.length };
  const head = lines.slice(0, Math.floor(maxLines / 2));
  const tail = lines.slice(lines.length - Math.floor(maxLines / 2));
  const omitted = lines.length - head.length - tail.length;
  return {
    text: `${head.join("\n")}
\u2026 [${omitted} lines truncated] \u2026
${tail.join("\n")}`,
    truncated: true,
    originalLength: lines.length
  };
}
var init_truncate = __esm({
  "src/util/truncate.ts"() {
  }
});

// src/harness/tools/bash.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var execFileAsync, bashTool, bash_default;
var init_bash = __esm({
  "src/harness/tools/bash.ts"() {
    init_truncate();
    execFileAsync = promisify2(execFile2);
    bashTool = {
      name: "bash",
      description: "Execute a bash command in the working directory. Returns stdout and stderr combined (stderr after stdout). Long output is truncated with head+tail. Use a timeout for slow commands.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to run" },
          timeout: { type: "integer", minimum: 1, maximum: 600, description: "Timeout in seconds (default 120)" }
        },
        required: ["command"]
      },
      executionMode: "sequential",
      execute: async (_id, args, signal) => {
        const command = args.command;
        const timeoutSec = typeof args.timeout === "number" ? args.timeout : 120;
        let stdout2 = "";
        let stderr = "";
        let code = 0;
        let timedOut = false;
        try {
          const result = await execFileAsync("bash", ["-c", command], {
            timeout: timeoutSec * 1e3,
            maxBuffer: 8 * 1024 * 1024,
            signal
          });
          stdout2 = result.stdout;
          stderr = result.stderr;
        } catch (err) {
          const e = err;
          stdout2 = e.stdout ?? "";
          stderr = e.stderr ?? e.message ?? "";
          code = typeof e.code === "number" ? e.code : 1;
          timedOut = e.killed === true;
        }
        let output = "";
        if (stdout2) output += stdout2;
        if (stderr) output += (output ? "\n" : "") + stderr;
        if (output.length === 0) output = "(no output)";
        const truncated = truncateLines(output, 500);
        if (truncated.truncated) output = truncated.text;
        const status2 = timedOut ? ` (timeout after ${timeoutSec}s)` : code !== 0 ? ` [exit ${code}]` : "";
        return {
          content: output + status2,
          isError: code !== 0 || timedOut,
          details: { exitCode: code, timedOut, truncated: truncated.truncated }
        };
      }
    };
    bash_default = bashTool;
  }
});

// src/harness/tools/grep.ts
import { execFile as execFile3 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var execFileAsync2, grepTool, grep_default;
var init_grep = __esm({
  "src/harness/tools/grep.ts"() {
    execFileAsync2 = promisify3(execFile3);
    grepTool = {
      name: "grep",
      description: "Search file contents for a pattern (regex or literal). Returns matching lines as path:line:text. Respects .gitignore in git repos.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex or literal string)" },
          path: { type: "string", description: "Directory or file to search (default: cwd)" },
          glob: { type: "string", description: "Filter files by glob, e.g. '*.ts'" },
          ignoreCase: { type: "boolean", description: "Case-insensitive search (default false)" },
          literal: { type: "boolean", description: "Treat pattern as literal string (default false)" },
          context: { type: "integer", minimum: 0, maximum: 10, description: "Lines to show before and after each match (default 0)" },
          limit: { type: "integer", minimum: 1, description: "Maximum matches (default 100)" }
        },
        required: ["pattern"]
      },
      execute: async (_id, args) => {
        const argsArr = [];
        if (args.ignoreCase) argsArr.push("-i");
        if (args.literal) argsArr.push("-F");
        const context = typeof args.context === "number" ? args.context : 0;
        if (context > 0) argsArr.push("-C", String(context));
        argsArr.push("-n", "--color=never");
        argsArr.push(`-m${typeof args.limit === "number" ? args.limit : 100}`);
        if (args.glob) argsArr.push(`--include=${args.glob}`);
        argsArr.push("--", args.pattern, args.path ?? ".");
        try {
          const { stdout: stdout2, stderr } = await execFileAsync2("grep", argsArr, { maxBuffer: 4 * 1024 * 1024, timeout: 3e4 });
          if (!stdout2 && !stderr) return { content: "No matches" };
          const out = (stdout2 + stderr).trimEnd();
          if (out.length > 15e3) return { content: out.slice(0, 15e3) + "\n\u2026 [output truncated \u2014 narrow the search]", isError: false };
          return { content: out };
        } catch (err) {
          const e = err;
          if (e.code === 1) return { content: "No matches" };
          return { content: `grep failed: ${e.stderr ?? e.message}`, isError: true };
        }
      }
    };
    grep_default = grepTool;
  }
});

// src/harness/tools/find.ts
import { execFile as execFile4 } from "node:child_process";
import { promisify as promisify4 } from "node:util";
function shellQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
var execFileAsync3, findTool, find_default;
var init_find = __esm({
  "src/harness/tools/find.ts"() {
    execFileAsync3 = promisify4(execFile4);
    findTool = {
      name: "find",
      description: "Find files by glob pattern. Returns matching paths relative to the search directory. Respects .gitignore.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. '*.ts' or 'src/**/*.spec.ts'" },
          path: { type: "string", description: "Directory to search in (default: cwd)" },
          limit: { type: "integer", minimum: 1, description: "Maximum results (default 200)" }
        },
        required: ["pattern"]
      },
      execute: async (_id, args) => {
        const limit = typeof args.limit === "number" ? args.limit : 200;
        const path2 = args.path ?? ".";
        try {
          const { stdout: stdout2 } = await execFileAsync3("bash", ["-c", `command -v fd >/dev/null 2>&1 && fd -g ${shellQuote(args.pattern)} --max-results ${limit} . ${shellQuote(path2)} || find ${shellQuote(path2)} -name ${shellQuote(args.pattern)} -print | head -n ${limit}`], { maxBuffer: 4 * 1024 * 1024, timeout: 3e4 });
          const out = stdout2.trimEnd();
          return { content: out || "No matches" };
        } catch (err) {
          return { content: `find failed: ${err.message}`, isError: true };
        }
      }
    };
    find_default = findTool;
  }
});

// src/harness/tools/ls.ts
import { readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { join as join5 } from "node:path";
var lsTool, ls_default;
var init_ls = __esm({
  "src/harness/tools/ls.ts"() {
    lsTool = {
      name: "ls",
      description: "List a directory's contents. Directories get a trailing /. Hidden files included. Use this instead of bash ls.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list (default: cwd)" },
          depth: { type: "integer", minimum: 1, maximum: 3, description: "Recursion depth (default 1)" },
          limit: { type: "integer", minimum: 1, description: "Maximum entries (default 300)" }
        },
        required: []
      },
      execute: async (_id, args) => {
        const path2 = args.path ?? ".";
        const depth = typeof args.depth === "number" ? args.depth : 1;
        const limit = typeof args.limit === "number" ? args.limit : 300;
        const lines = [];
        const walk = (dir, prefix, d) => {
          if (lines.length >= limit) return;
          let names;
          try {
            names = readdirSync2(dir, { withFileTypes: true }).map((e) => e.name).sort();
          } catch (err) {
            lines.push(`${prefix}${dir}: ${err.message}`);
            return;
          }
          for (const name of names) {
            if (lines.length >= limit) {
              lines.push(`\u2026 [truncated at ${limit} entries]`);
              return;
            }
            let isDir = false;
            try {
              isDir = statSync2(join5(dir, name)).isDirectory();
            } catch {
              isDir = false;
            }
            lines.push(`${prefix}${name}${isDir ? "/" : ""}`);
            if (isDir && d > 1) walk(join5(dir, name), prefix + "  ", d - 1);
          }
        };
        walk(path2, "", depth);
        return { content: lines.join("\n") || "(empty)" };
      }
    };
    ls_default = lsTool;
  }
});

// src/harness/tools/web.ts
function tinyfishKey() {
  return process.env.TINYFISH_API_KEY ?? loadConfig().tinyfish?.apiKey ?? "";
}
function searchUrl() {
  return (process.env.TINYFISH_SEARCH_URL ?? "https://api.search.tinyfish.ai").replace(/\/$/, "");
}
function fetchUrl() {
  return (process.env.TINYFISH_FETCH_URL ?? "https://api.fetch.tinyfish.ai").replace(/\/$/, "");
}
function noKeyError(what) {
  return `No TinyFish API key for ${what}. Set TINYFISH_API_KEY (free at tinyfish.ai \u2192 Get API key), or put it in ~/.rein/config.json under {"tinyfish": {"apiKey": "..."}}.`;
}
async function call(opts) {
  const res = await fetch(opts.url, {
    method: opts.method,
    headers: { "X-API-Key": tinyfishKey(), Accept: "application/json", ...opts.body ? { "Content-Type": "application/json" } : {} },
    body: opts.body ? JSON.stringify(opts.body) : void 0,
    signal: opts.signal
  });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
  }
  return { status: res.status, json, raw };
}
var webSearchTool, webFetchTool, web_default;
var init_web = __esm({
  "src/harness/tools/web.ts"() {
    init_models();
    init_truncate();
    webSearchTool = {
      name: "web_search",
      description: "Search the live web (TinyFish). Fresh, structured results \u2014 not cached. Returns a ranked list of {title, url, site, snippet, date?}. Use for finding pages, current events, docs, prices. Then web_fetch a promising URL to read it. Supports site: filtering, recency, news, and research-paper modes.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query. site:domain.com and -site:domain.com work inline." },
          purpose: { type: "string", description: "Why you are searching (the goal the results serve). Improves quality." },
          domain_type: { type: "string", enum: ["web", "news", "research_paper"], description: "web (default), news, or research_paper" },
          recency_minutes: { type: "integer", description: "Only results newer than N minutes (1..5256000). Omit for no freshness window." },
          include_domains: { type: "string", description: "Comma-separated domains to restrict to (e.g. github.com,arxiv.org)" },
          exclude_domains: { type: "string", description: "Comma-separated domains to exclude" },
          location: { type: "string", description: "Country code for geo-targeted results (e.g. US)" },
          language: { type: "string", description: "Result language code (e.g. en)" },
          page: { type: "integer", minimum: 0, maximum: 10, description: "Result page, 0-based (default 0)" }
        },
        required: ["query"]
      },
      execute: async (_id, args, signal) => {
        if (!tinyfishKey()) return { content: noKeyError("web_search"), isError: true };
        const qs = new URLSearchParams();
        qs.set("query", String(args.query));
        const pass = (k, cast) => {
          const v = args[k];
          if (v !== void 0 && v !== null && v !== "") qs.set(k, String(cast ? cast(v) : v));
        };
        pass("purpose");
        pass("domain_type");
        pass("recency_minutes", (v) => Number(v));
        pass("include_domains");
        pass("exclude_domains");
        pass("location");
        pass("language");
        pass("page", (v) => Number(v));
        let r;
        try {
          r = await call({ method: "GET", url: `${searchUrl()}/?${qs.toString()}`, timeoutMs: 3e4, signal });
        } catch (err) {
          return { content: `web_search request failed: ${err.message}`, isError: true };
        }
        if (r.status === 401 || r.status === 403) return { content: `TinyFish rejected the key (HTTP ${r.status}): ${r.raw.slice(0, 200)}`, isError: true };
        if (r.status === 429) return { content: `web_search rate-limited (HTTP 429) \u2014 wait a moment and retry.`, isError: true };
        if (r.status >= 400 || !r.json) return { content: `web_search HTTP ${r.status}: ${r.raw.slice(0, 300)}`, isError: true };
        const results = r.json.results ?? [];
        if (results.length === 0) return { content: `No results for: ${args.query}`, isError: false, details: { count: 0 } };
        const lines = [];
        for (const [i, it] of results.entries()) {
          const date = it.date ? ` (${it.date})` : "";
          lines.push(`${i + 1}. ${it.title ?? "(untitled)"}${date}`);
          lines.push(`   ${it.url}`);
          if (it.snippet) lines.push(`   ${it.snippet}`);
        }
        const truncated = truncateLines(lines.join("\n"), 80);
        return { content: (r.json.total_results ?? results.length) + " results for: " + args.query + "\n" + truncated.text, isError: false, details: { count: results.length, truncated: truncated.truncated } };
      }
    };
    webFetchTool = {
      name: "web_fetch",
      description: "Fetch any URL and get clean, LLM-ready markdown (TinyFetch). Runs a real browser behind the scenes, so it handles JS-heavy pages. Returns the page title, final URL, and extracted text (truncated). Use after web_search to read a specific page. One URL per call for the cleanest result.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The http(s) URL to fetch" },
          purpose: { type: "string", description: "Why you are fetching this page (improves extraction)" },
          max_chars: { type: "integer", minimum: 500, maximum: 2e5, description: "Max characters of page text to return (default 20000)" }
        },
        required: ["url"]
      },
      execute: async (_id, args, signal) => {
        if (!tinyfishKey()) return { content: noKeyError("web_fetch"), isError: true };
        const url = String(args.url);
        const maxChars = typeof args.max_chars === "number" ? args.max_chars : 2e4;
        const body = { urls: [url], format: "markdown" };
        if (typeof args.purpose === "string" && args.purpose.trim()) body.purpose = args.purpose.trim();
        let r;
        try {
          r = await call({ method: "POST", url: fetchUrl(), body, timeoutMs: 15e4, signal });
        } catch (err) {
          return { content: `web_fetch request failed: ${err.message}`, isError: true };
        }
        if (r.status === 401 || r.status === 403) return { content: `TinyFish rejected the key (HTTP ${r.status}): ${r.raw.slice(0, 200)}`, isError: true };
        if (r.status === 429) return { content: `web_fetch rate-limited (HTTP 429) \u2014 wait a moment and retry.`, isError: true };
        if (r.status >= 400 || !r.json) return { content: `web_fetch HTTP ${r.status}: ${r.raw.slice(0, 300)}`, isError: true };
        const results = r.json.results ?? [];
        const errors = r.json.errors ?? [];
        const page = results.find((x) => x.url === url) ?? results[0];
        if (!page) {
          const e = errors[0];
          return { content: `web_fetch failed for ${url}: ${e ? `${e.error}${e.status ? " (HTTP " + e.status + ")" : ""}` : "no result"}`, isError: true };
        }
        const head = [];
        head.push(`Title: ${page.title ?? "(untitled)"}`);
        if (page.final_url && page.final_url !== url) head.push(`Final URL: ${page.final_url}`);
        if (page.published_date) head.push(`Published: ${page.published_date}`);
        const text = typeof page.text === "string" ? page.text : JSON.stringify(page.text ?? "");
        const bodyOut = truncateLines(text, Math.floor(maxChars / 20));
        return {
          content: head.join("\n") + "\n\n" + (bodyOut.text || "(no extractable text)"),
          isError: false,
          details: { finalUrl: page.final_url, chars: text.length, truncated: bodyOut.truncated }
        };
      }
    };
    web_default = [webSearchTool, webFetchTool];
  }
});

// src/harness/tools/gates.ts
var gates_exports = {};
__export(gates_exports, {
  default: () => gates_default
});
import { execFile as execFile5 } from "node:child_process";
import { promisify as promisify5 } from "node:util";
import { existsSync as existsSync5 } from "node:fs";
import { dirname as dirname3, isAbsolute, join as join6, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var execFileAsync4, here, UNLAZY_CANDIDATES, UNLAZY_DIR, MODES, gatesTool, gates_default;
var init_gates = __esm({
  "src/harness/tools/gates.ts"() {
    init_truncate();
    execFileAsync4 = promisify5(execFile5);
    here = dirname3(fileURLToPath(import.meta.url));
    UNLAZY_CANDIDATES = [
      resolve(here, "..", "..", "..", "vendor", "unlazy"),
      resolve(here, "..", "vendor", "unlazy")
    ];
    UNLAZY_DIR = UNLAZY_CANDIDATES.find((dir) => existsSync5(join6(dir, "scripts", "gate-check.mjs"))) ?? UNLAZY_CANDIDATES[1];
    MODES = /* @__PURE__ */ new Set(["status", "approve", "reverify", "lint"]);
    gatesTool = {
      name: "gates",
      description: "unlazy completion gates: run the acceptance ledger (GATES.md). mode=lint checks the ledger for oracles that cannot fail; mode=status reports met/unmet without executing anything; mode=approve approves each exact pending CHECK/EXPECT/CWD oracle and runs it; mode=reverify re-runs every runnable gate and demotes stale evidence. For substantial work, write GATES.md from vendor/unlazy/templates/gates-leaf.md BEFORE implementing, lint it, then work, then reverify before reporting done. Untested claims are not evidence \u2014 a checked box without EVIDENCE counts as unmet.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["status", "approve", "reverify", "lint"], description: "What to do with the ledger" },
          file: { type: "string", description: "Ledger file (default GATES.md). Absolute or relative to root." },
          root: { type: "string", description: "Working directory for the checker (default: current working directory)" }
        },
        required: ["mode"]
      },
      execute: async (_id, args, signal) => {
        const mode = args.mode;
        if (!MODES.has(mode)) return { content: `Unknown mode: ${mode}. Use one of: status, approve, reverify, lint.`, isError: true };
        const file = args.file ? String(args.file) : "GATES.md";
        const root = args.root ? resolve(String(args.root)) : process.cwd();
        const ledgerPath = isAbsolute(file) ? file : join6(root, file);
        if (!existsSync5(ledgerPath)) {
          return { content: `Ledger not found: ${ledgerPath}. Write it first (template: vendor/unlazy/templates/gates-leaf.md), then run gates with mode=lint.`, isError: true };
        }
        const scriptPath = join6(UNLAZY_DIR, "scripts", mode === "lint" ? "gate-lint.mjs" : "gate-check.mjs");
        const cmdArgs = mode === "lint" ? [scriptPath, ledgerPath] : [scriptPath, `--${mode}`, ledgerPath];
        let stdout2 = "";
        let stderr = "";
        let code = 0;
        try {
          const result = await execFileAsync4(process.execPath, cmdArgs, {
            cwd: root,
            timeout: 6e5,
            maxBuffer: 8 * 1024 * 1024,
            signal
          });
          stdout2 = result.stdout;
          stderr = result.stderr;
        } catch (err) {
          const e = err;
          stdout2 = e.stdout ?? "";
          stderr = e.stderr ?? e.message ?? "";
          code = typeof e.code === "number" ? e.code : 1;
        }
        const output = [stdout2, stderr].filter(Boolean).join("\n") || "(no output)";
        const truncated = truncateLines(output, 200);
        const tail = ` [gates:${mode} exit ${code}]`;
        const isError = code === 0 ? false : mode === "status" ? code >= 2 : true;
        return {
          content: truncated.text + (truncated.truncated ? " \u2026[truncated]" : "") + tail,
          isError,
          details: { mode, exitCode: code }
        };
      }
    };
    gates_default = gatesTool;
  }
});

// src/harness/tools/index.ts
var TOOLS;
var init_tools = __esm({
  "src/harness/tools/index.ts"() {
    init_read();
    init_write();
    init_edit();
    init_bash();
    init_grep();
    init_find();
    init_ls();
    init_web();
    init_gates();
    TOOLS = [read_default, write_default, edit_default, bash_default, grep_default, find_default, ls_default, web_default[0], web_default[1], gates_default];
  }
});

// src/harness/nodeterm.ts
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
function token() {
  const dir = process.env.NODETERM_NODE_TOKEN_DIR;
  const id = process.env.NODETERM_NODE_ID;
  if (!dir || !id) return void 0;
  try {
    const t = fs.readFileSync(path.join(dir, id), "utf8").trim();
    return t || void 0;
  } catch {
    return void 0;
  }
}
function postEvent(payload, extra = {}) {
  const nodeId = process.env.NODETERM_NODE_ID;
  const sock = process.env.NODETERM_HOOK_SOCK;
  const port = process.env.NODETERM_HOOK_PORT;
  if (!nodeId || !sock && !port) return;
  const fields = {
    nodeId,
    version: process.env.NODETERM_HOOK_VERSION ?? "1",
    payload: JSON.stringify(payload),
    ...extra
  };
  const body = Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Content-Length": String(Buffer.byteLength(body))
  };
  const tk = token();
  if (tk) headers["X-Nodeterm-Node-Token"] = tk;
  const reqPath = `/hook/${encodeURIComponent(AGENT_ID)}`;
  const opts = sock ? { socketPath: sock, path: reqPath, method: "POST", headers, timeout: 1500 } : { host: "127.0.0.1", port: Number(port), path: reqPath, method: "POST", headers, timeout: 1500 };
  try {
    const req = http.request(opts);
    req.on("error", () => {
    });
    req.on("timeout", () => req.destroy());
    req.end(body);
  } catch {
  }
}
function setTitle(text) {
  if (!process.stdout.isTTY) return;
  const clean = text.replace(/[\n\r\x1b]/g, " ");
  if (process.env.TMUX) {
    process.stdout.write(`\x1BPtmux;set-title ${clean}\x1B\\`);
  } else {
    process.stdout.write(`\x1B]0;${clean}\x07`);
  }
}
function requestApproval(toolName, toolInput, timeoutSec) {
  const wait = Math.max(1, Number(timeoutSec ?? process.env.NODETERM_PERM_WAIT_SECS ?? 45));
  const nodeId = process.env.NODETERM_NODE_ID ?? "node";
  const pendingId = `${nodeId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dir = pendingDir();
  const requestFile = path.join(dir, `${pendingId}.json`);
  const answerFile = path.join(dir, `${pendingId}.answer`);
  const request2 = {
    hook_event_name: "PermissionRequest",
    hookSpecificOutput: { hookEventName: "PermissionRequest" },
    tool_name: toolName,
    tool_input: toolInput,
    node_id: nodeId
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(requestFile, JSON.stringify(request2, null, 1), { mode: 384 });
  } catch {
    postEvent(request2);
    return Promise.resolve("timeout");
  }
  postEvent(request2, { nodeterm_pending_id: pendingId });
  const deadline = Date.now() + wait * 1e3;
  return new Promise((resolve4) => {
    const tick = () => {
      let answer = "";
      try {
        answer = fs.readFileSync(answerFile, "utf8").trim().toLowerCase();
      } catch {
        answer = "";
      }
      if (answer === "allow" || answer === "deny") {
        for (const f of [requestFile, answerFile]) {
          try {
            fs.rmSync(f, { force: true });
          } catch {
          }
        }
        postEvent(
          { hook_event_name: "PostToolUse", tool_name: toolName, hookSpecificOutput: { hookEventName: "PostToolUse" } },
          { nodeterm_answered: answer }
        );
        resolve4(answer);
        return;
      }
      if (Date.now() >= deadline) {
        try {
          fs.rmSync(requestFile, { force: true });
        } catch {
        }
        resolve4("timeout");
        return;
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  });
}
var AGENT_ID, active, pendingDir, status;
var init_nodeterm = __esm({
  "src/harness/nodeterm.ts"() {
    AGENT_ID = "rein";
    active = () => !!(process.env.NODETERM_NODE_ID && (process.env.NODETERM_HOOK_PORT || process.env.NODETERM_HOOK_SOCK));
    pendingDir = () => process.env.NODETERM_PENDING_DIR ?? path.join(os.homedir(), ".nodeterm", "pending");
    status = {
      turnStart: (prompt) => postEvent({ hook_event_name: "UserPromptSubmit", prompt, hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }),
      toolStart: (toolName, toolInput) => postEvent({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, hookSpecificOutput: { hookEventName: "PreToolUse" } }),
      toolEnd: (toolName) => postEvent({ hook_event_name: "PostToolUse", tool_name: toolName, hookSpecificOutput: { hookEventName: "PostToolUse" } }),
      done: () => postEvent({ hook_event_name: "Stop", hookSpecificOutput: { hookEventName: "Stop" } })
    };
  }
});

// src/harness/runner.ts
var runner_exports = {};
__export(runner_exports, {
  createRunner: () => createRunner
});
async function createRunner(opts) {
  const model = await resolveModel({
    model: opts.modelOverride,
    baseUrl: opts.baseUrlOverride,
    provider: opts.providerOverride
  });
  const apiKey = apiKeyFor(opts.providerOverride ?? (opts.baseUrlOverride ? void 0 : model.provider));
  const config = loadConfig();
  const forcedMode = opts.toolsMode ?? config.toolsMode ?? "auto";
  const decision = decideToolMode(model.provider, model.id, forcedMode);
  const basePrompt = opts.systemPrompt ?? buildSystemPrompt(opts.cwd);
  const tools = opts.tools ?? TOOLS;
  let systemPrompt = decision.mode === "text" ? basePrompt + TEXT_TOOL_INSTRUCTIONS : basePrompt;
  const steering = [];
  const context = { systemPrompt, messages: [], tools };
  const askTools = [...opts.askTools ?? []];
  const summarizeArgs = (args) => {
    const s = JSON.stringify(args);
    return s.length > 100 ? s.slice(0, 100) + "\u2026" : s;
  };
  const runner = {
    model,
    apiKey,
    toolsMode: decision.mode,
    toolsModeSource: decision.source,
    get systemPrompt() {
      return systemPrompt;
    },
    set systemPrompt(v) {
      systemPrompt = v;
      context.systemPrompt = v;
    },
    tools,
    askTools,
    context,
    steer(message) {
      steering.push(message);
    },
    run: (prompt, runOpts) => agentLoop(
      [prompt],
      runner.context,
      {
        model,
        streamFn: (m, ctx, o) => stream(m, ctx, { ...o, apiKey, temperature: opts.temperature ?? config.temperature, maxTokens: config.maxTokens, toolsMode: runner.toolsMode }),
        maxTurns: opts.maxTurns ?? 60,
        getSteeringMessages: () => steering.splice(0, steering.length),
        beforeToolCall: async (info) => {
          if (!askTools.includes(info.toolCall.name)) return void 0;
          const name = info.toolCall.name;
          const args = info.args ?? {};
          if (active()) {
            setTitle(`rein \xB7 needs you: ${name}`);
            const verdict = await requestApproval(name, args);
            if (verdict === "allow") return void 0;
            if (verdict === "deny") return { block: true, reason: `Denied: ${name} ${summarizeArgs(args)} (canvas/phone said no)` };
            console.error(`
[approval] ${name}: no answer in time \u2014 proceeding (fail-open)
`);
            return void 0;
          }
          const ok = await runner.askFallback?.(name, args) ?? false;
          return ok ? void 0 : { block: true, reason: `Denied: ${name} ${summarizeArgs(args)}` };
        }
      },
      runOpts?.signal,
      async (event) => {
        switch (event.type) {
          case "agent_start":
            status.turnStart(String(prompt.content ?? ""));
            setTitle("rein \xB7 working");
            break;
          case "tool_execution_start":
            status.toolStart(event.toolName, event.args ?? {});
            setTitle(`rein \xB7 ${event.toolName}`);
            break;
          case "tool_execution_end":
            status.toolEnd(event.toolName);
            break;
          case "agent_end":
            status.done();
            setTitle("rein \xB7 idle");
            break;
        }
        if (event.type === "turn_end") {
          await maybeFallBackToTextMode(runner, event.message);
        }
      }
    ).then((newMessages) => {
      context.messages.push(...newMessages);
      return newMessages;
    })
  };
  return runner;
}
async function maybeFallBackToTextMode(runner, message) {
  if (runner.toolsMode === "text") return;
  const toolCalls = message.content.filter((c) => c.type === "toolCall");
  if (message.stopReason !== "toolUse" || toolCalls.length === 0) return;
  if (!looksLikeBrokenNativeTools(toolCalls)) return;
  runner.toolsMode = "text";
  runner.toolsModeSource = "runtime";
  if (!runner.systemPrompt.includes("<tool name=")) {
    runner.systemPrompt = runner.systemPrompt + TEXT_TOOL_INSTRUCTIONS;
  }
  recordDecision(runner.model.provider, runner.model.id, "text", "runtime");
  console.error(
    `
[compat] ${runner.model.id} didn't produce usable tool arguments \u2014 using the text tool protocol from here on. This choice is remembered for next time.
`
  );
}
var init_runner = __esm({
  "src/harness/runner.ts"() {
    init_agent_loop();
    init_openai_completions();
    init_compat();
    init_models();
    init_system_prompt();
    init_tools();
    init_nodeterm();
  }
});

// src/harness/improve.ts
var improve_exports = {};
__export(improve_exports, {
  runImproveLoop: () => runImproveLoop
});
import { execFileSync as execFileSync2 } from "node:child_process";
import { cpSync, existsSync as existsSync6, mkdtempSync, readFileSync as readFileSync7, appendFileSync, rmSync as rmSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join8, dirname as dirname4, resolve as resolve2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { randomUUID as randomUUID2 } from "node:crypto";
function sh3(cmd, cwd) {
  return execFileSync2("bash", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
}
function gitAvailable(cwd) {
  try {
    sh3("git rev-parse --is-inside-work-tree", cwd);
    return true;
  } catch {
    return false;
  }
}
function runSmokeTest(repoDir) {
  const run = (dir2) => execFileSync2("node", ["--experimental-strip-types", "test/smoke.ts"], {
    cwd: dir2,
    encoding: "utf8",
    timeout: 12e4,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const underNodeModules = repoDir.split(/[\\/]/).includes("node_modules");
  const dir = underNodeModules ? mkdtempSync(join8(tmpdir(), "rein-smoke-")) : repoDir;
  if (dir !== repoDir) for (const name of ["src", "test", "vendor"]) cpSync(join8(repoDir, name), join8(dir, name), { recursive: true });
  try {
    const out = run(dir);
    if (dir !== repoDir) rmSync2(dir, { recursive: true, force: true });
    return { pass: true, output: out };
  } catch (err) {
    if (dir !== repoDir) rmSync2(dir, { recursive: true, force: true });
    return { pass: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}
function harnessLessons(repoDir) {
  const path2 = join8(repoDir, "LESSONS.md");
  if (!existsSync6(path2)) return "";
  const text = readFileSync7(path2, "utf8");
  const m = text.match(/## harness\s*\n([\s\S]*?)(?=\n## |$)/);
  return m?.[1]?.trim() ?? "";
}
async function runImproveLoop(opts) {
  const repoDir = REIN_REPO;
  const maxIters = opts.maxIterations ?? 5;
  const goal = opts.goal ?? "";
  const useGit = gitAvailable(repoDir);
  if (!useGit) {
    console.log(yellow(`not a git repo (${repoDir}) \u2014 running without keep/discard; review changes manually`));
  }
  const runner = await createRunner({
    ...opts,
    cwd: repoDir,
    systemPrompt: buildImprovePrompt(repoDir),
    maxTurns: 40
  });
  console.log(
    gray(
      `rein improve \xB7 target: ${repoDir}
model: ${runner.model.provider}/${runner.model.id} \xB7 max ${maxIters} iterations \xB7 ${useGit ? "git keep/discard" : "no git"}
`
    )
  );
  const lessons = harnessLessons(repoDir);
  const queueText = [
    goal ? `The user's goal this run: ${goal}` : "No explicit goal. Work through the harness weaknesses below.",
    "",
    lessons ? `Known harness weaknesses (from LESSONS.md):
${lessons}` : "(no harness lessons recorded yet \u2014 look for the weakest part of the harness by reading the code)"
  ].join("\n");
  let iterations = 0;
  let improved = 0;
  while (iterations < maxIters) {
    iterations++;
    const tag = randomUUID2().slice(0, 8);
    console.log(`
${bold(`iteration ${iterations}/${maxIters}`)} ${dim(tag)}`);
    const prompt = iterations === 1 ? queueText + "\n\nPick the single most concrete weakness and fix it with the smallest change that works. Then run the smoke test and report the result as: RESULT: improved | no-change | failed" : "Continue: pick the next concrete weakness (not the one you just fixed). Same rules. Report as: RESULT: improved | no-change | failed";
    let outcome = "failed";
    let report = "";
    try {
      const messages = await runner.run({ role: "user", content: prompt, timestamp: Date.now() });
      const lastText = messages.filter((m) => m.role === "assistant").at(-1)?.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      report = lastText ?? "";
      if (/RESULT:\s*improved/i.test(report)) outcome = "improved";
      else if (/RESULT:\s*no-change/i.test(report)) outcome = "no-change";
    } catch (err) {
      console.log(red(`run failed: ${err.message}`));
      outcome = "failed";
    }
    const dirty = useGit ? sh3("git status --porcelain", repoDir) : "unknown";
    if (outcome === "improved") {
      if (!useGit || dirty && dirty.length > 0) {
        const test = runSmokeTest(repoDir);
        if (test.pass) {
          if (useGit) {
            sh3(`git add -A && git commit -m "rein improve: ${tag} (auto)"`, repoDir);
          }
          appendFileSync(join8(repoDir, "LESSONS.md"), `
- [improve ${tag}] fixed: ${firstLine(report)}
`);
          improved++;
          console.log(green(`kept ${dim(tag)} \u2014 smoke test passed${useGit ? " \xB7 committed" : ""}`));
        } else {
          if (useGit) sh3("git checkout . && git clean -fd", repoDir);
          console.log(red(`discarded ${dim(tag)} \u2014 smoke test failed`));
          console.log(dim(test.output.slice(-600)));
          appendFileSync(join8(repoDir, "LESSONS.md"), `
- [improve ${tag}] tried and failed: ${firstLine(report)}
`);
        }
      } else {
        console.log(yellow(`${dim(tag)} claimed improved but the tree is clean \u2014 counting as no-change`));
        outcome = "no-change";
      }
    } else if (outcome === "no-change") {
      if (useGit && dirty) sh3("git checkout . && git clean -fd", repoDir);
      console.log(gray(`${dim(tag)}: no change worth making \u2014 ${firstLine(report) || "no report"}`));
    } else {
      if (useGit) sh3("git checkout . && git clean -fd", repoDir);
      console.log(red(`${dim(tag)}: failed \u2014 ${firstLine(report) || (report ? report.slice(0, 120) : "no report")}`));
    }
    if (outcome === "no-change") {
      console.log(gray("agent found nothing more to improve \u2014 stopping"));
      break;
    }
  }
  console.log(`
${bold("done")}: ${improved} improvement(s) kept out of ${iterations} iteration(s)`);
}
function firstLine(text) {
  return (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim().slice(0, 160);
}
var here2, REIN_REPO;
var init_improve = __esm({
  "src/harness/improve.ts"() {
    init_ansi();
    init_runner();
    init_system_prompt();
    here2 = dirname4(fileURLToPath2(import.meta.url));
    REIN_REPO = [here2, resolve2(here2, ".."), resolve2(here2, "..", "..")].find((dir) => existsSync6(join8(dir, "test", "smoke.ts"))) ?? resolve2(here2, "..", "..");
  }
});

// src/harness/heartbeat.ts
var heartbeat_exports = {};
__export(heartbeat_exports, {
  HEARTBEAT_TEMPLATE: () => HEARTBEAT_TEMPLATE,
  parseHeartbeat: () => parseHeartbeat,
  runHeartbeat: () => runHeartbeat
});
import { appendFileSync as appendFileSync2, existsSync as existsSync7, mkdirSync as mkdirSync4, readFileSync as readFileSync8, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { isAbsolute as isAbsolute2, join as join9, resolve as resolve3 } from "node:path";
function parseHeartbeat(text) {
  const tasks = [];
  let improveGoal;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const m = line.match(/^#\s*improve\s*:\s*(.+)$/i);
      if (m) improveGoal = m[1].trim();
      continue;
    }
    tasks.push(line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, ""));
  }
  return { tasks, improveGoal };
}
function resolveHeartbeatFile(explicit) {
  if (explicit) return isAbsolute2(explicit) ? explicit : resolve3(explicit);
  const local = resolve3(process.cwd(), "HEARTBEAT.md");
  if (existsSync7(local)) return local;
  return join9(homedir5(), ".rein", "HEARTBEAT.md");
}
function logBeat(result) {
  const dir = join9(homedir5(), ".rein");
  mkdirSync4(dir, { recursive: true });
  const path2 = join9(dir, "heartbeat.log");
  appendFileSync2(path2, JSON.stringify({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    file: result.file,
    doctor: result.doctor,
    tasks: result.tasks.map((t) => ({ ok: t.ok, line: t.line.slice(0, 120), text: t.text.slice(0, 400), error: t.error })),
    improve: result.improve,
    durationMs: result.durationMs
  }) + "\n");
  return path2;
}
async function runHeartbeat(opts = {}) {
  const started = Date.now();
  const say = (s) => {
    if (!opts.quiet) console.log(s);
  };
  if (opts.init) {
    const path2 = opts.file ? isAbsolute2(opts.file) ? opts.file : resolve3(opts.file) : resolve3(process.cwd(), "HEARTBEAT.md");
    writeFileSync5(path2, HEARTBEAT_TEMPLATE);
    say(green(`wrote ${path2} \u2014 edit it, then run: rein heartbeat`));
    return 0;
  }
  const file = resolveHeartbeatFile(opts.file);
  if (!existsSync7(file)) {
    say(red(`no HEARTBEAT.md (looked in cwd and ~/.rein)`));
    say(dim(`create one: rein heartbeat --init --file ${file}`));
    return 1;
  }
  const { tasks, improveGoal } = parseHeartbeat(readFileSync8(file, "utf8"));
  say(bold(`heartbeat \xB7 ${file}`) + dim(` \xB7 ${(/* @__PURE__ */ new Date()).toISOString()}`));
  say(`
${bold("1/4 self-heal")}`);
  const doctor = await runDoctor({ fix: true, quiet: opts.quiet });
  say(dim(`   doctor: ${doctor.healthy}/${doctor.total} healthy${doctor.fixed.length ? ` (${doctor.fixed.length} repaired)` : ""}`));
  say(`
${bold("2/4 tasks")}`);
  const results = [];
  if (tasks.length === 0) {
    say(yellow("   idle \u2014 HEARTBEAT.md has no tasks (self-heal only)"));
  } else if (!opts.model && !process.env.REIN_BASE_URL && !existsSync7(join9(homedir5(), ".rein", "config.json"))) {
    say(red(`   ${tasks.length} task(s) queued but no model configured \u2014 run: rein setup`));
    for (const line of tasks) results.push({ line, ok: false, text: "", error: "no model configured" });
  } else {
    const runner = await createRunner({ ...opts, cwd: process.cwd() });
    for (let i = 0; i < tasks.length; i++) {
      const line = tasks[i];
      say(`   ${i + 1}/${tasks.length} ${dim(line.slice(0, 80))}`);
      try {
        const messages = await runner.run({ role: "user", content: line, timestamp: Date.now() });
        const last = messages.filter((m) => m.role === "assistant").at(-1);
        const text = (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
        const ok = !last || last.stopReason !== "error";
        results.push({ line, ok, text: text.slice(0, 500), error: last?.stopReason === "error" ? last.errorMessage : void 0 });
        say(ok ? green(`   \u2713 ${text.slice(0, 100)}`) : red(`   \u2717 ${last?.errorMessage ?? "error"}`));
      } catch (e) {
        results.push({ line, ok: false, text: "", error: e.message?.slice(0, 200) });
        say(red(`   \u2717 ${e.message?.slice(0, 100)}`));
      }
    }
  }
  say(`
${bold("3/4 self-advance")}`);
  const goal = opts.improveGoal ?? (opts.improve ? "pick the weakest part of the harness and improve it" : improveGoal);
  let improveNote = null;
  if (goal) {
    say(dim(`   goal: ${goal}`));
    try {
      await runImproveLoop({ ...opts, cwd: process.cwd(), goal, maxIterations: 1, dryRun: false });
      improveNote = goal;
    } catch (e) {
      improveNote = `${goal} (failed: ${e.message?.slice(0, 80)})`;
      say(red(`   self-advance failed: ${e.message?.slice(0, 100)}`));
    }
  } else {
    say(yellow("   skipped \u2014 set a goal with `# improve: <goal>` in HEARTBEAT.md or --improve"));
  }
  const logPath = logBeat({
    file,
    tasks: results,
    doctor: { healthy: doctor.healthy, total: doctor.total, fixed: doctor.fixed },
    improve: improveNote,
    durationMs: Date.now() - started
  });
  say(`
${bold("4/4 memory")}` + dim(`   beat logged \u2192 ${logPath}`));
  const failed = results.filter((t) => !t.ok).length;
  say(`
${failed === 0 ? green("beat complete") : red(`beat complete \u2014 ${failed} task(s) failed`)} ${dim(`(${((Date.now() - started) / 1e3).toFixed(1)}s)`)}`);
  return failed === 0 ? 0 : 1;
}
var HEARTBEAT_TEMPLATE;
var init_heartbeat = __esm({
  "src/harness/heartbeat.ts"() {
    init_ansi();
    init_doctor();
    init_runner();
    init_improve();
    HEARTBEAT_TEMPLATE = `# HEARTBEAT.md \u2014 what the agent does on every \`rein heartbeat\`.
#
# Rules:
#   - one task per line (leading -, * or a number is fine)
#   - lines starting with # are comments \u2014 the agent never sees them
#   - empty or comments only \u2192 idle beat: self-heal + log, no work
#   - "# improve: <goal>" \u2192 after the tasks, run ONE self-improvement iteration with that goal
#
# Examples:
# - confirm the model server still answers (run: rein doctor)
# - scan ~/.rein/heartbeat.log for failed beats and summarize any pattern
# # improve: keep the harness local-first and fast
`;
  }
});

// src/harness/setup.ts
var setup_exports = {};
__export(setup_exports, {
  runSetup: () => runSetup
});
import { existsSync as existsSync8, mkdirSync as mkdirSync5, readFileSync as readFileSync9, writeFileSync as writeFileSync6 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { join as join10 } from "node:path";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
function configPath() {
  return join10(homedir6(), ".rein", "config.json");
}
function saveConfig(patch) {
  mkdirSync5(join10(homedir6(), ".rein"), { recursive: true });
  let existing = {};
  try {
    if (existsSync8(configPath())) existing = JSON.parse(readFileSync9(configPath(), "utf8"));
  } catch {
  }
  writeFileSync6(configPath(), JSON.stringify({ ...existing, ...patch }, null, 2) + "\n", { mode: 384 });
}
function promptRl() {
  if (rl) return rl;
  const r = readline.createInterface({ input: stdin, output: stdout });
  rl = r;
  r.on("line", (line) => {
    const text = line.trim();
    if (lineWaiter) {
      const w = lineWaiter;
      lineWaiter = void 0;
      w(text);
    } else {
      lineQueue.push(text);
    }
  });
  r.on("close", () => {
    if (!manualClose) inputClosed = true;
    manualClose = false;
    if (lineWaiter) {
      const w = lineWaiter;
      lineWaiter = void 0;
      w("");
    }
  });
  return r;
}
async function askLine(prompt, def = "") {
  promptRl();
  stdout.write(prompt);
  if (lineQueue.length > 0) return lineQueue.shift() || def;
  if (inputClosed) return def;
  return new Promise((resolve4) => {
    lineWaiter = (text) => resolve4(text || def);
  });
}
async function askChoice(prompt, count, def = 1) {
  for (; ; ) {
    const answer = (await askLine(prompt)).trim();
    if (answer === "") return def - 1;
    const n = Number.parseInt(answer, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= count) return n - 1;
    stdout.write(C.yellow("  pick a number from the list\n"));
  }
}
async function askSecret(prompt) {
  if (!stdin.isTTY) return void 0;
  manualClose = true;
  rl?.close();
  rl = void 0;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(prompt);
  let value = "";
  await new Promise((resolve4) => {
    stdin.on("data", (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.pause();
          resolve4();
        } else if (ch === "" || ch === "") {
          stdout.write("\n");
          process.exit(ch === "" ? 130 : 143);
        } else if (ch === "\x7F") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
        } else if (ch >= " ") {
          value += ch;
          stdout.write("*");
        }
      }
    });
  });
  stdout.write("\n");
  if (wasRaw !== void 0) stdin.setRawMode(wasRaw);
  return value;
}
async function fitMarks(ids) {
  const out = /* @__PURE__ */ new Map();
  try {
    const { matchCatalog: matchCatalog2 } = await Promise.resolve().then(() => (init_catalog(), catalog_exports));
    const { assessCatalog: assessCatalog2, verdictMark: verdictMark2 } = await Promise.resolve().then(() => (init_fit(), fit_exports));
    const { all } = await assessCatalog2();
    for (const id of ids) {
      const cm = matchCatalog2(id);
      if (!cm) continue;
      const hit = all.find((x) => x.model.id === cm.id);
      if (hit) out.set(id, verdictMark2(hit.a));
    }
  } catch {
  }
  return out;
}
async function testConnection(baseUrl, model, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2e4);
  const started = Date.now();
  try {
    const res = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", ...apiKey ? { authorization: `Bearer ${apiKey}` } : {} },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 8,
        temperature: 0
      })
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 160);
      return { ok: false, detail: `HTTP ${res.status}${body ? ` \u2014 ${body}` : ""}` };
    }
    const json = await res.json().catch(() => ({}));
    const reply = json?.choices?.[0]?.message?.content?.trim() ?? "(empty)";
    return { ok: true, detail: `model answered "${reply}" in ${Date.now() - started}ms` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
async function printStatus() {
  const config = loadConfig();
  const servers = await discoverLocalServers();
  console.log(`config: ${configPath()}`);
  if (config.baseUrl || config.model) {
    console.log(`  model:   ${config.model ?? "(unset)"}`);
    console.log(`  baseUrl: ${config.baseUrl ?? "(unset)"}`);
    console.log(`  apiKey:  ${config.apiKey ? `${config.apiKey.slice(0, 7)}\u2026` : "(none)"}`);
  } else {
    console.log("  (no config yet \u2014 run `rein setup`)");
  }
  console.log("\nlocal servers:");
  if (servers.length === 0) console.log("  (none running)");
  for (const s of servers) console.log(`  ${s.provider.padEnd(10)} ${s.baseUrl}  ${s.models?.length ?? 0} model(s)`);
  if (config.baseUrl && config.model) {
    const r = await testConnection(config.baseUrl, config.model, config.apiKey);
    console.log(`
connection: ${r.ok ? C.green("\u2713 " + r.detail) : C.red("\u2717 " + r.detail)}`);
  }
}
async function runSetup(opts) {
  if (opts.status) {
    await printStatus();
    return 0;
  }
  console.log(C.bold("rein setup") + " \u2014 configure your model\n");
  try {
    const { profileHardware: profileHardware2, summarizeHardware: summarizeHardware2 } = await Promise.resolve().then(() => (init_profile(), profile_exports));
    console.log(C.dim(`machine: ${summarizeHardware2(await profileHardware2())}`) + "\n");
  } catch {
  }
  const servers = await discoverLocalServers();
  if (servers.length > 0) {
    console.log("local servers detected:");
    servers.forEach((s, i) => {
      const models = (s.models ?? []).slice(0, 4).join(", ") + ((s.models ?? []).length > 4 ? ", \u2026" : "");
      console.log(`  ${C.green(String(i + 1))}. ${s.provider.padEnd(10)} ${C.dim(s.baseUrl)}  ${C.dim(models)}`);
    });
  } else {
    console.log(C.yellow("no local AI servers detected") + C.dim(" (ollama / LM Studio / llama.cpp / vLLM)"));
  }
  console.log("");
  const choices = [];
  for (const s of servers) {
    choices.push({ label: `${s.provider} (local)`, baseUrl: s.baseUrl, model: pickDefaultModelId(s.models ?? []), needsKey: false });
  }
  for (const [name, p] of Object.entries(PROVIDER_PRESETS).slice(4)) {
    choices.push({ label: `${name} (cloud)`, baseUrl: p.baseUrl, needsKey: true, keyEnv: p.keyEnv });
  }
  choices.push({ label: "custom OpenAI-compatible endpoint", baseUrl: "", needsKey: true });
  const customIndex = choices.length - 1;
  let pick;
  if (opts.yes) {
    const config = loadConfig();
    pick = servers.length > 0 ? choices[0] : config.baseUrl && config.model ? { label: "existing config", baseUrl: config.baseUrl, model: config.model, needsKey: false } : choices[customIndex];
    console.log(C.dim(`  (--yes) picked: ${pick.label}`));
  } else {
    console.log(choices.map((c, i) => `  ${i + 1}. ${c.label}`).join("\n") + "\n");
    const defIdx = servers.length > 0 ? 0 : customIndex;
    const idx = await askChoice(`choose provider [${defIdx + 1}]: `, choices.length, defIdx + 1);
    pick = choices[idx];
  }
  let baseUrl = pick.baseUrl ?? "";
  let model = pick.model;
  let apiKey;
  if (baseUrl === "") {
    baseUrl = (await askLine("base URL (OpenAI-compatible, e.g. http://localhost:11434/v1): ")).replace(/\/$/, "");
  }
  if (!baseUrl) {
    console.log(C.red("no base URL \u2014 nothing to configure"));
    return 1;
  }
  if (!model) {
    try {
      const res = await fetch(baseUrl + "/models", { signal: AbortSignal.timeout(3e3) });
      if (res.ok) {
        const json = await res.json();
        const ids = (json?.data ?? []).map((m) => m.id).filter(Boolean);
        if (ids.length > 0) {
          const marks = await fitMarks(ids);
          console.log(`models on ${baseUrl}  ${C.dim("(fit marks from your hardware)")}:`);
          ids.slice(0, 20).forEach((id, i) => console.log(`  ${i + 1}. ${id}${marks.get(id) ? C.dim(marks.get(id)) : ""}`));
          const preferred = pickDefaultModelId(ids);
          const defIdx = Math.max(0, ids.indexOf(preferred ?? ""));
          if (!opts.yes) {
            const n = await askChoice(`choose model [${defIdx + 1}]: `, ids.length, defIdx + 1);
            model = ids[n];
          } else {
            model = ids[defIdx];
          }
        }
      }
    } catch {
    }
    if (!model && !opts.yes) model = await askLine("model id: ");
  }
  if (!model) {
    console.log(C.red("no model id available \u2014 start a server or pick one manually, then re-run `rein setup`"));
    return 1;
  }
  if (pick.needsKey) {
    const envKey = pick.keyEnv ? process.env[pick.keyEnv] : void 0;
    if (envKey) {
      apiKey = envKey;
      console.log(C.dim(`  using ${pick.keyEnv} from environment`));
    } else if (!opts.yes) {
      const secret = await askSecret("API key (Enter to skip): ");
      if (secret) apiKey = secret;
    }
  }
  console.log(`
model:   ${model}`);
  console.log(`baseURL: ${baseUrl}`);
  if (apiKey) console.log(`apiKey:  ${apiKey.slice(0, 7)}\u2026`);
  const test = await testConnection(baseUrl, model, apiKey);
  if (test.ok) {
    console.log(C.green(`\u2713 connection test passed \u2014 ${test.detail}`));
  } else {
    console.log(C.yellow(`\u26A0 connection test failed \u2014 ${test.detail}`));
    if (!opts.yes) {
      const keep = await askLine("save the config anyway? [y/N]: ");
      if (!/^y(es)?$/i.test(keep)) {
        console.log("not saved. Fix the endpoint and run `rein setup` again.");
        return 1;
      }
    }
  }
  saveConfig({ baseUrl, model, ...apiKey ? { apiKey } : {} });
  console.log(`
${C.green("\u2713 config saved to " + configPath())}`);
  console.log(`
try it:`);
  console.log(`  rein -p "hello, what model are you?"`);
  console.log(`  rein            # interactive session in this directory`);
  return 0;
}
var C, lineQueue, lineWaiter, inputClosed, manualClose, rl;
var init_setup = __esm({
  "src/harness/setup.ts"() {
    init_models();
    C = {
      dim: (s) => `\x1B[2m${s}\x1B[0m`,
      green: (s) => `\x1B[32m${s}\x1B[0m`,
      red: (s) => `\x1B[31m${s}\x1B[0m`,
      yellow: (s) => `\x1B[33m${s}\x1B[0m`,
      bold: (s) => `\x1B[1m${s}\x1B[0m`
    };
    lineQueue = [];
    inputClosed = false;
    manualClose = false;
  }
});

// src/harness/loop.ts
var loop_exports = {};
__export(loop_exports, {
  gitAvailable: () => gitAvailable2,
  runExperimentLoop: () => runExperimentLoop
});
import { execFileSync as execFileSync3 } from "node:child_process";
import { existsSync as existsSync9, readFileSync as readFileSync10, appendFileSync as appendFileSync3 } from "node:fs";
import { join as join11 } from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";
function sh4(cmd, cwd) {
  return execFileSync3("bash", ["-c", cmd], { cwd, encoding: "utf8" }).trim();
}
function gitAvailable2(cwd) {
  try {
    sh4("git rev-parse --is-inside-work-tree", cwd);
    return true;
  } catch {
    return false;
  }
}
function readMetric(output) {
  const m = output.match(/METRIC=(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : void 0;
}
function readMetricCommand(metricFile) {
  const text = readFileSync10(metricFile, "utf8");
  const m = text.match(/```\n([^\n`]+)\n```/);
  if (m) return m[1].trim();
  return text.trim().split("\n").filter((l) => l.trim() && !l.startsWith("#"))[0] ?? "";
}
async function runExperimentLoop(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const taskFile = opts.taskFile ?? "TASK.md";
  const metricFile = opts.metricFile ?? "METRIC.md";
  const taskPath = join11(cwd, taskFile);
  const metricPath = join11(cwd, metricFile);
  if (!existsSync9(taskPath)) {
    throw new Error(`No ${taskFile} in ${cwd} \u2014 write what to improve, then re-run.`);
  }
  if (!existsSync9(metricPath)) {
    throw new Error(`No ${metricFile} in ${cwd} \u2014 put the metric command in a fenced code block (three backticks) and what METRIC= means, then re-run.`);
  }
  const task = readFileSync10(taskPath, "utf8");
  const metricDoc = readFileSync10(metricPath, "utf8");
  const metricCmd = readMetricCommand(metricDoc);
  const useGit = gitAvailable2(cwd);
  const maxIters = opts.maxIterations ?? 10;
  const runMetric = () => {
    try {
      const out = execFileSync3("bash", ["-c", metricCmd], { cwd, encoding: "utf8", timeout: 3e5 });
      return readMetric(out);
    } catch (err) {
      console.log(dim(`metric run failed: ${err.stderr ?? err.message}`.slice(0, 300)));
      return void 0;
    }
  };
  const runner = await createRunner({ ...opts, cwd, maxTurns: 40 });
  let best = runMetric();
  console.log(
    gray(
      `rein loop \xB7 ${cwd}
model: ${runner.model.provider}/${runner.model.id}
baseline METRIC=${best ?? "n/a"} \xB7 max ${maxIters} iterations \xB7 ${useGit ? "git keep/discard" : "no git"}
`
    )
  );
  const prompt = `
You are in an autonomous experiment loop. Read the task below, make ONE concrete improvement, then stop so the metric can be measured.

TASK:
${task.slice(0, 4e3)}

METRIC (how success is measured \u2014 you cannot see the metric yourself; the loop runs it):
${metricDoc.slice(0, 2e3)}

Rules:
- One improvement per iteration. Smallest change with a plausible metric impact.
- Do not change the metric command or its parsing.
- Do not read this file again \u2014 act on it.
`.trim();
  let kept = 0;
  let discarded = 0;
  let stale = 0;
  for (let i = 0; i < maxIters; i++) {
    const tag = randomUUID3().slice(0, 8);
    console.log(`
${bold(`iteration ${i + 1}/${maxIters}`)} ${dim(tag)}`);
    try {
      await runner.run({ role: "user", content: i === 0 ? prompt : "Next iteration: one more improvement, different angle. If nothing better is plausible, say RESULT: no-change and stop.", timestamp: Date.now() });
    } catch (err) {
      console.log(red(`run failed: ${err.message}`));
    }
    const dirty = useGit ? sh4("git status --porcelain", cwd) : "";
    if (!dirty) {
      console.log(gray(`${dim(tag)}: no changes made`));
      if (++stale >= 3) {
        console.log(gray("three iterations without changes \u2014 stopping"));
        break;
      }
      continue;
    }
    const metric = runMetric();
    if (metric === void 0) {
      console.log(yellow(`${dim(tag)}: metric could not be parsed \u2014 discarding`));
      if (useGit) sh4("git checkout . && git clean -fd", cwd);
      discarded++;
      continue;
    }
    if (best === void 0 || metric > best) {
      best = metric;
      if (useGit) sh4(`git add -A && git commit -m "loop: ${tag} METRIC=${metric}"`, cwd);
      kept++;
      console.log(green(`${dim(tag)}: METRIC ${metric} (new best) \u2014 kept${useGit ? " \xB7 committed" : ""}`));
    } else {
      if (useGit) sh4("git checkout . && git clean -fd", cwd);
      discarded++;
      console.log(gray(`${dim(tag)}: METRIC ${metric} (best was ${best}) \u2014 discarded`));
    }
  }
  const summary = `
loop complete: best METRIC=${best ?? "n/a"} \xB7 ${kept} kept \xB7 ${discarded} discarded`;
  console.log(bold(summary));
  appendFileSync3(join11(cwd, "LESSONS.md"), `
- [loop ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}] ${summary}
`);
}
var init_loop = __esm({
  "src/harness/loop.ts"() {
    init_ansi();
    init_runner();
  }
});

// src/agent/session.ts
import { appendFileSync as appendFileSync4, existsSync as existsSync10, mkdirSync as mkdirSync6, readFileSync as readFileSync11, readdirSync as readdirSync3 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { join as join12 } from "node:path";
function ensureDir() {
  mkdirSync6(DIR, { recursive: true });
}
function newSessionId() {
  const d = /* @__PURE__ */ new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `session-${d.getTime()}-${rand}`;
}
function sessionPath(id) {
  return join12(DIR, `${id}.jsonl`);
}
function createSession(opts) {
  ensureDir();
  const id = opts.id ?? newSessionId();
  const header = {
    type: "header",
    version: 1,
    id,
    created: (/* @__PURE__ */ new Date()).toISOString(),
    model: opts.model,
    provider: opts.provider,
    cwd: opts.cwd
  };
  const path2 = sessionPath(id);
  if (existsSync10(path2)) {
    appendFileSync4(path2, JSON.stringify(header) + "\n");
    return id;
  }
  appendFileSync4(path2, JSON.stringify(header) + "\n");
  return id;
}
function appendMessage(sessionId, message) {
  ensureDir();
  appendFileSync4(sessionPath(sessionId), JSON.stringify(message) + "\n");
}
function appendEntries(sessionId, messages) {
  for (const m of messages) appendMessage(sessionId, m);
}
function loadSession(sessionId) {
  const path2 = sessionPath(sessionId);
  if (!existsSync10(path2)) throw new Error(`No such session: ${sessionId}`);
  const lines = readFileSync11(path2, "utf8").split("\n").filter((l) => l.trim().length > 0);
  let header = null;
  const messages = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "header") {
        if (!header) header = obj;
      } else if (obj.role) {
        messages.push(obj);
      }
    } catch {
    }
  }
  return { header, messages };
}
function listSessions(limit = 20) {
  try {
    const files2 = readdirSync3(DIR).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out = [];
  for (const file of files.reverse()) {
    const id = file.replace(/\.jsonl$/, "");
    const { header, messages } = loadSession(id);
    let updated = header?.created ?? "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const ts = messages[i].timestamp;
      if (typeof ts === "number") {
        updated = new Date(ts).toISOString();
        break;
      }
    }
    out.push({
      id,
      created: header?.created ?? "",
      updated,
      provider: header?.provider,
      model: header?.model,
      cwd: header?.cwd,
      messageCount: messages.length
    });
  }
  out.sort((a, b) => a.updated < b.updated ? 1 : -1);
  return out.slice(0, limit);
}
function branchSession(sourceId, upToMessageIndex, newId) {
  const { messages } = loadSession(sourceId);
  const prefix = upToMessageIndex === void 0 ? messages : messages.slice(0, upToMessageIndex + 1);
  const id = newId ?? newSessionId();
  ensureDir();
  const path2 = sessionPath(id);
  const header = JSON.parse(readFileSync11(sessionPath(sourceId), "utf8").split("\n")[0] ?? "{}");
  appendFileSync4(
    path2,
    JSON.stringify({ ...header, id, created: (/* @__PURE__ */ new Date()).toISOString() }) + "\n"
  );
  for (const m of prefix) appendMessage(id, m);
  return id;
}
var DIR;
var init_session = __esm({
  "src/agent/session.ts"() {
    DIR = join12(homedir7(), ".rein", "sessions");
  }
});

// src/harness/print.ts
var print_exports = {};
__export(print_exports, {
  runPrint: () => runPrint
});
async function runPrint(opts) {
  const query = opts.query ?? process.argv.find((a) => a.length > 1 && !a.startsWith("-")) ?? "";
  if (!query) {
    console.error('no query given. Usage: rein -p "what to do"');
    return 2;
  }
  const runner = await createRunner(opts);
  if (opts.json) {
    const out = runner.run.bind(runner);
    runner.run = (prompt, runOpts) => out(prompt, runOpts).then((messages) => {
      for (const m of messages) {
        process.stdout.write(JSON.stringify({ event: "message", message: m }) + "\n");
      }
      return messages;
    });
  }
  let exitCode = 0;
  try {
    const messages = await runner.run({ role: "user", content: query, timestamp: Date.now() });
    if (opts.save) {
      const sessionId = createSession({ model: runner.model.id, provider: runner.model.provider, cwd: process.cwd() });
      appendEntries(sessionId, messages);
      process.stderr.write(dim(`session ${sessionId}
`));
    }
    if (!opts.json) {
      const last = messages.filter((m) => m.role === "assistant").at(-1);
      const text = last?.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (text) console.log(text);
      if (last && last.stopReason === "error") {
        console.error(red(last.errorMessage ?? "error"));
        exitCode = 1;
      }
    }
  } catch (err) {
    console.error(red(err.message));
    exitCode = 1;
  }
  return exitCode;
}
var init_print = __esm({
  "src/harness/print.ts"() {
    init_session();
    init_ansi();
    init_runner();
  }
});

// src/harness/repl.ts
var repl_exports = {};
__export(repl_exports, {
  startRepl: () => startRepl
});
import * as readline2 from "node:readline";
async function startRepl(opts) {
  const { runner } = opts;
  let sessionId = opts.resumeSessionId ?? createSession({ model: runner.model.id, provider: runner.model.provider, cwd: process.cwd() });
  const rl2 = readline2.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: dim("\u276F ") });
  console.log(
    gray(
      `rein \xB7 ${runner.model.provider}/${runner.model.id} \xB7 tools: ${runner.toolsMode} (${runner.toolsModeSource}) \xB7 session ${sessionId.slice(-8)}
`
    )
  );
  if (active()) {
    console.log(gray("nodeterm node detected \u2014 status badges on; approvals can be answered from the canvas or the phone."));
  }
  let busy = false;
  let currentText = "";
  let thinkingOn = false;
  const flushLine = () => {
    if (currentText.trim()) {
      process.stdout.write("\n" + currentText.trimEnd() + "\n");
    }
    currentText = "";
  };
  const onEvent = (event) => {
    switch (event.type) {
      case "message_update": {
        const e = event.event;
        if (e.type === "text_delta") {
          if (thinkingOn) {
            process.stdout.write("\n");
            thinkingOn = false;
          }
          process.stdout.write(e.delta);
          currentText += e.delta;
        } else if (e.type === "thinking_delta") {
          if (!thinkingOn) {
            process.stdout.write("\n" + gray("\xB7 thinking\u2026 "));
            thinkingOn = true;
          }
        }
        break;
      }
      case "message_end": {
        flushLine();
        break;
      }
      case "tool_execution_start": {
        if (thinkingOn) {
          process.stdout.write("\n");
          thinkingOn = false;
        }
        const args = JSON.stringify(event.args ?? {});
        process.stdout.write("\n" + cyan("\u26A1 ") + bold(event.toolName) + " " + dim(args.length > 120 ? args.slice(0, 120) + "\u2026" : args) + "\n");
        break;
      }
      case "tool_execution_end": {
        const mark = event.isError ? red("\u2717") : green("\u2713");
        const preview = (event.result?.content ?? "").replace(/\n/g, " ").slice(0, 100);
        process.stdout.write(dim(`  ${mark} ${preview}${(event.result?.content ?? "").length > 100 ? "\u2026" : ""}
`));
        break;
      }
    }
  };
  const originalRun = runner.run.bind(runner);
  runner.run = (prompt, runOpts) => {
    busy = true;
    return originalRun(prompt, runOpts).then((messages) => {
      appendEntries(sessionId, messages);
      return messages;
    }).finally(() => {
      busy = false;
    });
  };
  const handleCommand = async (line) => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "help":
        console.log(
          [
            "  /help            this list",
            "  /new             start a fresh session",
            "  /model           show the active model + tool mode",
            "  /tools <list>    show available tools",
            "  /ask [tools]   tools that need approval (y/N here, or canvas/phone)",
            "  /sessions        list recent sessions",
            "  /resume <id>     continue a previous session (reloads its messages)",
            "  /branch          branch the current session and continue there",
            "  /quit            exit"
          ].join("\n")
        );
        return true;
      case "model":
        console.log(
          gray(
            `model: ${runner.model.provider}/${runner.model.id}
base: ${runner.model.baseUrl}
tools: ${runner.toolsMode} (source: ${runner.toolsModeSource})`
          )
        );
        return true;
      case "tools":
        for (const t of runner.tools) {
          console.log(`  ${bold(t.name)} ${dim(t.description.split(".")[0])}`);
        }
        return true;
      case "ask": {
        if (!arg) {
          console.log(gray(`tools needing approval: ${runner.askTools.length ? runner.askTools.join(", ") : "(none)"}`));
          return true;
        }
        if (arg === "clear") {
          runner.askTools.length = 0;
          console.log(gray("approval set cleared \u2014 all tools run automatically"));
          return true;
        }
        const names = arg.split(",").map((s) => s.trim()).filter(Boolean);
        const known = new Set(runner.tools.map((t) => t.name));
        const bad = names.filter((n) => !known.has(n));
        if (bad.length) {
          console.log(yellow(`unknown tool(s): ${bad.join(", ")} \u2014 try /tools`));
          return true;
        }
        runner.askTools.length = 0;
        runner.askTools.push(...names);
        console.log(gray(`${names.join(", ")} now need approval (canvas/phone or [y/N] here)`));
        return true;
      }
      case "new":
        sessionId = createSession({ model: runner.model.id, provider: runner.model.provider, cwd: process.cwd() });
        runner.context.messages = [];
        console.log(gray(`fresh session ${sessionId.slice(-8)}`));
        return true;
      case "sessions":
        for (const s of listSessions(10)) {
          console.log(`  ${s.id.slice(-12)}  ${gray(s.updated)}  ${dim(s.provider ?? "?")}/${dim(s.model ?? "?")}  ${s.messageCount} msgs`);
        }
        return true;
      case "resume": {
        if (!arg) {
          console.log(yellow("usage: /resume <session id>"));
          return true;
        }
        const { messages } = loadSession(arg);
        sessionId = arg;
        runner.context.messages = [...messages];
        console.log(gray(`resumed ${arg} with ${messages.length} messages`));
        return true;
      }
      case "branch": {
        const id = branchSession(sessionId);
        sessionId = id;
        console.log(gray(`branched to ${id.slice(-8)}`));
        return true;
      }
      case "quit":
      case "exit":
        return false;
      default:
        console.log(yellow(`unknown command: /${cmd} \u2014 try /help`));
        return true;
    }
  };
  let resolveLine = null;
  let inputClosed2 = false;
  const lineQueue2 = [];
  rl2.on("line", (line) => {
    if (resolveLine) {
      const r = resolveLine;
      resolveLine = null;
      r(line);
    } else {
      lineQueue2.push(line);
    }
  });
  rl2.on("close", () => {
    inputClosed2 = true;
    if (resolveLine) {
      const r = resolveLine;
      resolveLine = null;
      r("");
    }
  });
  runner.askFallback = async (name, args) => {
    if (!process.stdin.isTTY) return false;
    const s = JSON.stringify(args);
    process.stdout.write(`
\u26A1 approve ${bold(name)} ${dim(s.length > 100 ? s.slice(0, 100) + "\u2026" : s)} \u2014 [y/N] `);
    const line = await ask() ?? "";
    return /^y(es)?$/i.test(line.trim());
  };
  const ask = () => {
    if (lineQueue2.length > 0) return Promise.resolve(lineQueue2.shift());
    if (inputClosed2) return Promise.resolve(null);
    return new Promise((resolve4) => {
      resolveLine = (line) => resolve4(line);
      if (!rl2.closed) rl2.prompt();
    });
  };
  if (runner.context.messages.length === 0) {
    console.log(gray("ask me anything, or /help for commands. while I'm working, just type \u2014 I'll fold it in."));
  }
  let first = true;
  while (true) {
    const line = await ask();
    if (line === null) break;
    if (!line) continue;
    if (line.startsWith("/")) {
      const keep = await handleCommand(line);
      if (!keep) break;
      continue;
    }
    const userMsg = { role: "user", content: line, timestamp: Date.now() };
    if (busy) {
      runner.steer(userMsg);
      console.log(gray("(queued \u2014 I'll fold that in after the current step)"));
      continue;
    }
    try {
      const started = Date.now();
      await runner.run(userMsg);
      if (process.stdout.isTTY) process.stdout.write("\n");
      const secs = ((Date.now() - started) / 1e3).toFixed(1);
      const usage2 = runner.context.messages[runner.context.messages.length - 1];
      const tokens = usage2?.usage?.output;
      console.log(gray(`${secs}s${tokens ? ` \xB7 ${tokens} out-tokens` : ""}`));
    } catch (err) {
      console.log(red(`something broke: ${err.message}`));
    }
    if (first) first = false;
  }
  if (!rl2.closed) rl2.close();
}
var init_repl = __esm({
  "src/harness/repl.ts"() {
    init_session();
    init_ansi();
    init_nodeterm();
  }
});

// src/cli.ts
init_models();
import { readFileSync as readFileSync12 } from "node:fs";
async function printHardwareSection() {
  try {
    const { summarizeHardware: summarizeHardware2 } = await Promise.resolve().then(() => (init_profile(), profile_exports));
    const { assessCatalog: assessCatalog2 } = await Promise.resolve().then(() => (init_fit(), fit_exports));
    const { profile, all } = await assessCatalog2();
    const ranked = all.filter((x) => x.a.verdict !== "no").sort((a, b) => (b.a.estTokS ?? 0) - (a.a.estTokS ?? 0) || b.model.params - a.model.params).slice(0, 5);
    if (ranked.length === 0) return;
    console.log("\nyour machine:");
    console.log(`  ${summarizeHardware2(profile)}`);
    console.log("top local picks (see `rein hardware` for the full table):");
    for (const { model: m, a } of ranked) {
      const mark = a.verdict === "fits" ? `~${a.estTokS ?? "?"} tok/s` : "tight";
      console.log(`  ${m.name.padEnd(28)} ${String(mark).padEnd(12)} ${m.ollama ?? ""}`);
    }
  } catch {
  }
}
function cliVersion() {
  try {
    return JSON.parse(readFileSync12(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
function usage() {
  console.log(`rein \u2014 minimal local-first agent harness

Usage:
  rein                          start an interactive session in this directory
  rein -p, --print "query"      one-shot: run the query, print the answer, exit
  rein -p "query" --json        one-shot, raw event stream (JSON lines)
  rein -p "query" --save        one-shot, persist the session (resume with --resume <id>)
  rein loop                     autonomous experiment loop (needs TASK.md + METRIC.md)
  rein improve [goal]           self-improvement loop on the rein repo
  rein gates [file]             unlazy gates: --mode lint|status|approve|reverify (default approve)
  rein models                   show detected local servers and provider presets
  rein hardware [--json]        profile this machine + what it can run (tok/s estimates)
  rein doctor [--fix]           auto-detect the whole stack; --fix self-repairs (pull/bundle/pull-model/chmod)
  rein heartbeat [--init]       self-sustaining beat: self-heal \u2192 HEARTBEAT.md tasks \u2192 self-advance
                                (--improve adds one self-improvement iteration; idle if no tasks)
  rein setup                    interactive onboarding: provider \u2192 model \u2192 key
                                \u2192 connection test \u2192 saves ~/.rein/config.json
  rein setup --yes              non-interactive (first local server / existing config)
  rein setup --status           show config, detected servers, test the connection

Model selection (highest wins):
  --model <id> --base-url <url>    explicit endpoint
  --provider <name> --model <id>   preset (openai, deepseek, groq, together, openrouter, mistral, ...)
  REIN_BASE_URL / REIN_MODEL       environment
  ~/.rein/config.json              {"model": "...", "baseUrl": "...", "apiKey": "..."}
  auto-detect                      Ollama, LM Studio, llama.cpp, vLLM (in that order)

Options:
  --tools <auto|native|text>       tool protocol (auto = capability table + runtime fallback)
  --max-turns <n>                  safety cap per prompt (default 60)
  --temperature <t>                sampling temperature
  --max-iterations <n>             loop/improve: max iterations
  --task-file <f>                  loop: task file (default TASK.md)
  --metric-file <f>                loop: metric file (default METRIC.md)
  --resume <id>                    resume a session (REPL)
  --ask <tools>                    tools that need approval: bash,write
                                    (REPL: /ask; nodeterm: canvas/phone answers)
  --no-tools                       run with no tools (pure chat)
  -h, --help                       this help
  -v, --version                    print version`);
}
function parseArgs(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== void 0 && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith("-") && a.length === 2) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== void 0 && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}
async function main(argv = process.argv.slice(2)) {
  const { _, flags } = parseArgs(argv);
  if (flags.help === true || _[0] === "help") {
    usage();
    return;
  }
  if (flags.version === true || flags.v === true || _[0] === "--version") {
    console.log(`rein ${cliVersion()}`);
    return;
  }
  const common = {
    cwd: process.cwd(),
    modelOverride: typeof flags.model === "string" ? flags.model : void 0,
    baseUrlOverride: typeof flags["base-url"] === "string" ? flags["base-url"] : void 0,
    providerOverride: typeof flags.provider === "string" ? flags.provider : void 0,
    toolsMode: typeof flags.tools === "string" ? flags.tools : void 0,
    maxTurns: typeof flags["max-turns"] === "string" ? parseInt(flags["max-turns"]) : void 0,
    temperature: typeof flags.temperature === "string" ? parseFloat(flags.temperature) : void 0,
    askTools: typeof flags.ask === "string" ? flags.ask.split(",").map((s) => s.trim()).filter(Boolean) : void 0
  };
  if (_[0] === "models" || _[0] === "model") {
    const { discoverLocalServers: discoverLocalServers2, PROVIDER_PRESETS: PROVIDER_PRESETS2 } = await Promise.resolve().then(() => (init_models(), models_exports));
    const servers = await discoverLocalServers2();
    console.log("local servers detected:");
    if (servers.length === 0) console.log("  (none running \u2014 start ollama / LM Studio / llama.cpp / vLLM)");
    for (const s of servers) {
      console.log(`  ${s.provider.padEnd(10)} ${s.baseUrl}`);
      for (const m of s.models ?? []) console.log(`     ${m}`);
    }
    console.log("\nprovider presets:");
    for (const [name, p] of Object.entries(PROVIDER_PRESETS2)) {
      console.log(`  ${name.padEnd(12)} ${p.baseUrl}  (key: ${p.keyEnv})`);
    }
    const config = loadConfig();
    if (config.model || config.baseUrl) console.log(`
config: ~/.rein/config.json \u2192 ${JSON.stringify({ model: config.model, baseUrl: config.baseUrl })}`);
    await printHardwareSection();
    return;
  }
  if (_[0] === "hardware") {
    const { printHardwareReport: printHardwareReport2 } = await Promise.resolve().then(() => (init_report(), report_exports));
    return printHardwareReport2({ json: flags.json === true });
  }
  if (_[0] === "doctor") {
    const { runDoctor: runDoctor2 } = await Promise.resolve().then(() => (init_doctor(), doctor_exports));
    const r = await runDoctor2({ fix: flags.fix === true });
    process.exitCode = r.healthy === r.total ? 0 : 1;
    return;
  }
  if (_[0] === "heartbeat" || _[0] === "hb") {
    const { runHeartbeat: runHeartbeat2 } = await Promise.resolve().then(() => (init_heartbeat(), heartbeat_exports));
    const code = await runHeartbeat2({
      ...common,
      file: typeof flags.file === "string" ? flags.file : void 0,
      improve: flags.improve === true,
      init: flags.init === true
    });
    process.exitCode = code;
    return;
  }
  if (_[0] === "setup") {
    const { runSetup: runSetup2 } = await Promise.resolve().then(() => (init_setup(), setup_exports));
    const code = await runSetup2({ yes: flags.yes === true, status: flags.status === true });
    process.exitCode = code;
    return;
  }
  if (_[0] === "loop") {
    const { runExperimentLoop: runExperimentLoop2 } = await Promise.resolve().then(() => (init_loop(), loop_exports));
    await runExperimentLoop2({
      ...common,
      taskFile: typeof flags["task-file"] === "string" ? flags["task-file"] : void 0,
      metricFile: typeof flags["metric-file"] === "string" ? flags["metric-file"] : void 0,
      maxIterations: typeof flags["max-iterations"] === "string" ? parseInt(flags["max-iterations"]) : void 0
    });
    return;
  }
  if (_[0] === "gates") {
    const { default: gatesTool2 } = await Promise.resolve().then(() => (init_gates(), gates_exports));
    const mode = typeof flags.mode === "string" ? flags.mode : "approve";
    const r = await gatesTool2.execute("cli", { mode, file: _.slice(1)[0] });
    console.log(r.content);
    process.exitCode = r.isError ? 1 : 0;
    return;
  }
  if (_[0] === "improve") {
    const goal = _.slice(1).join(" ");
    const { runImproveLoop: runImproveLoop2 } = await Promise.resolve().then(() => (init_improve(), improve_exports));
    await runImproveLoop2({
      ...common,
      goal: goal || void 0,
      maxIterations: typeof flags["max-iterations"] === "string" ? parseInt(flags["max-iterations"]) : 5
    });
    return;
  }
  if ("print" in flags || "p" in flags) {
    const { runPrint: runPrint2 } = await Promise.resolve().then(() => (init_print(), print_exports));
    const query = typeof flags.print === "string" ? flags.print : typeof flags.p === "string" ? flags.p : _.join(" ");
    const code = await runPrint2({
      ...common,
      query,
      json: flags.json === true,
      save: flags.save === true,
      tools: flags["no-tools"] === true ? [] : void 0
    });
    process.exitCode = code;
    return;
  }
  const { createRunner: createRunner2 } = await Promise.resolve().then(() => (init_runner(), runner_exports));
  const { startRepl: startRepl2 } = await Promise.resolve().then(() => (init_repl(), repl_exports));
  const runner = await createRunner2({ ...common, tools: flags["no-tools"] === true ? [] : void 0, askTools: common.askTools });
  await startRepl2({ runner, resumeSessionId: typeof flags.resume === "string" ? flags.resume : void 0 });
}

// bin/rein.js
main(process.argv.slice(2)).catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
