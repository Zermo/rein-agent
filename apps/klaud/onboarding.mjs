/** Native first-run state. Inspection never starts processes or returns user content. */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}\.jsonl$/;
const RECEIPT = ".klaudbot-home.json";
const MAX_JSON = 2 * 1024 * 1024;
const MAX_FILES = 20_000, MAX_BYTES = 2 * 1024 ** 3;
const files = ["config.json", "SOUL.md", "USER.md", "AGENTS.md", "profile.yaml", "klaud/bots.json", "klaud/shell.json", "klaud/prefs.json", "klaud/run-settings.json",
  "cli-auth/codex/auth.json", "cli-auth/copilot/config.json", "cli-auth/copilot/gh/hosts.yml", "cli-auth/grok/auth.json", "cli-auth/grok/credentials.json"];
const directories = ["history", "notes", "profiles", ".pi/notes", "workspace/.pi/notes"];
const plainObject = value => value && typeof value === "object" && !Array.isArray(value);
const absent = error => error?.code === "ENOENT";
function inspectPath(path, kind, optional = false) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (optional && absent(error)) return; throw new Error("Klaudbot could not read its private setup storage."); }
  if (stat.isSymbolicLink() || !(kind === "directory" ? stat.isDirectory() : stat.isFile()) || process.getuid && stat.uid !== process.getuid()) throw new Error("Setup requires ordinary files and directories owned by this user; symbolic links are not migrated.");
  return stat;
}
function checkedPath(root, name, kind, optional = false) {
  inspectPath(root, "directory");
  const path = join(root, name), parts = relative(root, path).split(sep);
  if (parts.includes("..")) throw new Error("Invalid private storage path.");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = join(cursor, part);
    if (!inspectPath(cursor, "directory", optional)) return;
  }
  return inspectPath(path, kind, optional);
}
function readJson(root, name, optional = false) {
  const stat = checkedPath(root, name, "file", optional);
  if (!stat) return;
  if (stat.size > MAX_JSON) throw new Error("A setup configuration file is too large. Its contents have been preserved.");
  const fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(fd);
    if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size) throw new Error("Private setup storage changed while reading it. Retry setup.");
    const buffer = Buffer.alloc(Math.min(MAX_JSON + 1, stat.size + 1));
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length !== stat.size || fstatSync(fd).mtimeMs !== stat.mtimeMs) throw new Error("Private setup storage changed while reading it. Retry setup.");
    const text = buffer.subarray(0, length).toString("utf8");
    if (name === "config.json" && !text.trim()) return {};
    let value;
    try { value = JSON.parse(text); } catch { throw new Error("A setup configuration file is malformed. Repair it or choose a fresh setup; the original is unchanged."); }
    if (!plainObject(value)) throw new Error("A setup configuration file must contain a JSON object. The original is unchanged.");
    return value;
  } finally { closeSync(fd); }
}
function privateWrite(root, name, value) {
  inspectPath(root, "directory");
  const target = join(root, name);
  checkedPath(root, name, "file", true);
  const temporary = join(root, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd);
    checkedPath(root, name, "file", true);
    renameSync(temporary, target);
  } finally { closeSync(fd); rmSync(temporary, { force: true }); }
}
function registry(root) {
  const value = readJson(root, "klaud/bots.json", true);
  if (!value) return { version: 1, bots: [] };
  const ids = new Set(), sessions = new Set();
  if (value.version !== 1 || !Array.isArray(value.bots) || value.bots.length > 10_000) throw new Error("The existing bot registry needs repair before migration. The original is unchanged.");
  for (const bot of value.bots) {
    if (!plainObject(bot) || !/^klaud-bot-[a-f0-9]{8}$/.test(bot.id) || typeof bot.sessionId !== "string" || !SESSION.test(`${bot.sessionId}.jsonl`) || typeof bot.name !== "string" || !bot.name.trim() || bot.name !== bot.name.trim() || bot.name.length > 64 || /[\x00-\x1f\x7f-\x9f]/.test(bot.name) || typeof bot.created !== "string" || !Number.isFinite(Date.parse(bot.created)) || new Date(bot.created).toISOString() !== bot.created || ids.has(bot.id) || sessions.has(bot.sessionId)) throw new Error("The existing bot registry needs repair before migration. The original is unchanged.");
    ids.add(bot.id); sessions.add(bot.sessionId);
  }
  return value;
}
function sessionFiles(root) {
  if (!checkedPath(root, "sessions", "directory", true)) return [];
  const names = readdirSync(join(root, "sessions")).filter(name => SESSION.test(name));
  if (names.length > 10_000) throw new Error("This installation has too many sessions for assisted migration. The original is unchanged.");
  return names.filter(name => checkedPath(root, `sessions/${name}`, "file"));
}
function sessionHeader(root, file) {
  const stat = checkedPath(root, `sessions/${file}`, "file");
  const fd = openSync(join(root, "sessions", file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(fd);
    if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error("Session storage changed during migration. Close the previous harness and retry.");
    const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    const length = readSync(fd, buffer, 0, buffer.length, 0), text = buffer.subarray(0, length).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0 && stat.size > length) return;
    let header; try { header = JSON.parse(newline < 0 ? text : text.slice(0, newline)); } catch { return; }
    if (header?.type === "header" && header.version === 1 && header.id === file.slice(0, -6) && header.purpose !== "autonomy") return header;
  } finally { closeSync(fd); }
}
function inspectExisting(root) {
  const empty = { found: false, configured: false, sessionCount: 0, botCount: 0, profileFound: false };
  try { if (!inspectPath(root, "directory", true)) return empty; } catch { return { ...empty, found: true }; }
  // Invalid content is never echoed. A fresh start must remain available even when old files need repair.
  let config, bots = 0, sessions = 0;
  try { config = readJson(root, "config.json", true); } catch { /* Migration revalidates and refuses malformed config. */ }
  try { bots = registry(root).bots.length; } catch { /* Counts are a hint, not validation. */ }
  try { sessions = sessionFiles(root).length; } catch { /* Unsafe paths are rejected during migration. */ }
  const found = ["config.json", "sessions", "profile.yaml", "klaud", "SOUL.md", "notes"].some(name => existsSync(join(root, name)));
  let profileFound = false;
  try { profileFound = !!checkedPath(root, "profile.yaml", "file", true); } catch { /* Keep fresh setup available when old profile storage is unsafe. */ }
  return { found, configured: typeof config?.model === "string" && !!config.model.trim() && (typeof config.baseUrl === "string" && !!config.baseUrl.trim() || config.auth?.type === "cli"), sessionCount: sessions, botCount: bots, profileFound };
}
function validateMarker(value) {
  if (!value || value.version !== 1 || !["migrate", "fresh"].includes(value.choice) || typeof value.completed !== "boolean" || typeof value.prepared !== "boolean" || !/^[a-f0-9-]{36}$/.test(value.transaction) || value.completed && !value.prepared) throw new Error("Klaudbot's setup record needs repair. Existing data has been preserved.");
  return value;
}

/** Source path is private native state; it is never sent to the renderer. */
export function createOnboarding({ userHome, userData, sourceHome, beforePublish }) {
  const source = resolve(sourceHome || join(userHome, ".rein"));
  const target = resolve(userHome, ".klaudbot"), data = resolve(userData), markerName = "klaudbot-onboarding.json";
  let busy = false;
  const marker = () => {
    if (!inspectPath(data, "directory", true)) return;
    const value = readJson(data, markerName, true);
    return value && validateMarker(value);
  };
  const receipt = () => readJson(target, RECEIPT, true);
  const selected = () => {
    const saved = marker();
    if (!saved) return;
    if (!inspectPath(target, "directory", true)) {
      if (saved.prepared) throw new Error("Klaudbot's prepared home is missing. Restore it before continuing.");
      return saved;
    }
    const value = receipt();
    if (!value || value.transaction !== saved.transaction || value.choice !== saved.choice) throw new Error("The existing Klaudbot home does not belong to this setup. It has been preserved.");
    return { ...saved, prepared: true };
  };
  const saveMarker = value => { mkdirSync(data, { recursive: true, mode: 0o700 }); privateWrite(data, markerName, value); };
  const inspect = () => {
    const saved = selected();
    return { version: 1, completed: saved?.completed ?? false, prepared: saved?.prepared ?? false, ...(saved ? { choice: saved.choice } : {}), existing: inspectExisting(source) };
  };
  async function copy(sourceName, stage, budget) {
    const stat = checkedPath(source, sourceName, "file", true);
    if (!stat) return;
    if (++budget.files > MAX_FILES || (budget.bytes += stat.size) > MAX_BYTES || stat.size > 512 * 1024 ** 2) throw new Error("This installation is too large for assisted migration. The original is unchanged.");
    const destination = join(stage, sourceName);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const input = await open(join(source, sourceName), constants.O_RDONLY | constants.O_NOFOLLOW);
    let output;
    try {
      const current = await input.stat();
      if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size) throw new Error("The previous harness changed during migration. Close it and retry.");
      output = await open(destination, "wx", 0o600);
      const chunk = Buffer.alloc(512 * 1024); let position = 0;
      while (position < stat.size) {
        const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
        if (!bytesRead) throw new Error("The previous harness changed during migration. Close it and retry.");
        let offset = 0;
        while (offset < bytesRead) { const result = await output.write(chunk, offset, bytesRead - offset); offset += result.bytesWritten; }
        position += bytesRead;
      }
      const after = await input.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("The previous harness changed during migration. Close it and retry.");
      await output.sync();
      budget.records.push({ name: sourceName, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev });
    } finally { await input.close(); await output?.close(); }
  }
  async function copyTree(name, stage, budget, depth = 0) {
    if (!checkedPath(source, name, "directory", true)) return;
    if (depth > 20) throw new Error("A migration directory is nested too deeply. The original is unchanged.");
    for (const entry of readdirSync(join(source, name), { withFileTypes: true })) {
      if (entry.name.startsWith(".") || /(?:\.lock|\.pid|\.sock|\.token|\.tmp)$/.test(entry.name)) continue;
      const next = `${name}/${entry.name}`;
      if (entry.isDirectory()) await copyTree(next, stage, budget, depth + 1);
      else await copy(next, stage, budget);
    }
  }
  const prepare = async choice => {
    if (!["migrate", "fresh"].includes(choice)) throw new Error("Choose migration or a fresh setup.");
    if (busy) throw new Error("Setup is already preparing your private home.");
    busy = true; let stage;
    try {
      const saved = selected();
      if (saved?.completed) throw new Error("Initial setup is complete. Use Settings to change your bot.");
      if (saved && saved.choice !== choice) throw new Error("This setup already has a home. Continue the selected setup; existing data will not be reset.");
      if (saved?.prepared) return target;
      if (source === target || source.startsWith(target + sep) || target.startsWith(source + sep)) throw new Error("The previous harness and Klaudbot need separate private homes.");
      inspectPath(resolve(userHome), "directory");
      if (inspectPath(target, "directory", true)) throw new Error("A Klaudbot home already exists. It has been preserved; no automatic reset is allowed.");
      const transaction = saved?.transaction ?? randomUUID();
      stage = join(userHome, `.klaudbot-setup-${transaction}`);
      let pending = saved;
      if (pending) {
        inspectPath(stage, "directory");
        const value = readJson(stage, RECEIPT);
        if (value?.transaction !== transaction || value.choice !== choice) throw new Error("The interrupted setup needs repair. Existing files are preserved.");
      } else {
        mkdirSync(stage, { mode: 0o700 });
        if (choice === "migrate") {
          if (!inspectExisting(source).found) throw new Error("No previous Rein installation was found. Choose a fresh setup.");
          readJson(source, "config.json", true); // Validate before copying any user configuration.
          const previousBots = registry(source), sessions = sessionFiles(source), budget = { files: 0, bytes: 0, records: [] };
          for (const file of files) await copy(file, stage, budget);
          for (const file of sessions) await copy(`sessions/${file}`, stage, budget);
          for (const directory of directories) await copyTree(directory, stage, budget);
          const known = new Set(previousBots.bots.map(bot => bot.sessionId));
          for (const file of sessions) {
            const sessionId = file.slice(0, -6);
            if (known.has(sessionId) || !sessionHeader(source, file)) continue;
            let id; do { id = `klaud-bot-${randomUUID().slice(0, 8)}`; } while (previousBots.bots.some(bot => bot.id === id));
            previousBots.bots.push({ id, sessionId, name: `Imported session ${previousBots.bots.length + 1}`, created: new Date().toISOString() });
          }
          for (const record of budget.records) {
            const current = checkedPath(source, record.name, "file");
            if (["size", "mtimeMs", "ino", "dev"].some(key => current[key] !== record[key])) throw new Error("The previous harness changed during migration. Close it and retry.");
          }
          readJson(stage, "config.json", true);
          if (previousBots.bots.length) {
            mkdirSync(join(stage, "klaud"), { recursive: true, mode: 0o700 });
            privateWrite(join(stage, "klaud"), "bots.json", previousBots);
          }
        }
        pending = { version: 1, choice, completed: false, prepared: false, transaction };
        privateWrite(stage, RECEIPT, { version: 1, choice, transaction });
        await beforePublish?.(); // Test injection only: fail before publishing, never accepted from IPC.
        saveMarker(pending);
      }
      if (inspectPath(target, "directory", true)) throw new Error("A Klaudbot home appeared during setup. It has been preserved.");
      renameSync(stage, target); stage = undefined;
      saveMarker({ ...pending, prepared: true });
      return target;
    } catch (error) {
      // Once a durable intent exists, leave its staging directory available for safe resume.
      if (stage && !marker()) rmSync(stage, { recursive: true, force: true });
      if (error instanceof Error && !error.code) throw error;
      throw new Error("Klaudbot could not prepare its private home. The original harness is unchanged; retry setup.");
    } finally { busy = false; }
  };
  return {
    inspect, prepare,
    home() { const saved = selected(); if (!saved?.prepared) throw new Error("Complete the first setup step before starting Klaudbot."); return target; },
    complete() {
      if (busy) throw new Error("Setup is still preparing your home.");
      const saved = selected();
      if (!saved?.prepared) throw new Error("Prepare your bot home before completing setup.");
      saveMarker({ ...saved, completed: true });
      return inspect();
    },
  };
}

/** An explicit fresh home must not inherit the old harness's model, routing, or credentials. */
export function onboardingEnvironment(environment) {
  const next = { ...environment };
  for (const key of Object.keys(next)) if (/^(?:REIN_(?:BASE_URL|MODEL|API|API_KEY|SSH_HOST|HOME)|OPENAI_(?:API_KEY|BASE_URL|API_BASE)|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|XAI_API_KEY|OPENROUTER_API_KEY|OLLAMA_API_KEY|LMSTUDIO_API_KEY|LLAMACPP_API_KEY|VLLM_API_KEY|DEEPSEEK_API_KEY|GROQ_API_KEY|TOGETHER_API_KEY|MISTRAL_API_KEY|FIREWORKS_API_KEY|CEREBRAS_API_KEY|HF_TOKEN)$/.test(key)) delete next[key];
  return next;
}

export function accountVerificationUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Use the verification page supplied by the official CLI.");
  let url; try { url = new URL(value); } catch { throw new Error("Use the verification page supplied by the official CLI."); }
  const official = url.origin === "https://auth.openai.com" && url.pathname === "/codex/device"
    || url.origin === "https://github.com" && url.pathname === "/login/device"
    || url.origin === "https://auth.x.ai" && /^\/[A-Za-z0-9/_-]{1,128}$/.test(url.pathname);
  if (!official || url.username || url.password || url.hash || [...url.searchParams].length > 1 || [...url.searchParams].some(([key, code]) => !["code", "user_code"].includes(key) || !/^[A-Z0-9]{3,12}(?:-[A-Z0-9]{3,4})?$/.test(code))) throw new Error("Use the verification page supplied by the official CLI.");
  return url.href;
}
