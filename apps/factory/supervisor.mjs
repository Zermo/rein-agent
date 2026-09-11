// Mastra Factory supervisor: the shared state contract for starting, stopping,
// inspecting, and opening the Factory server. Both the native app and
// `rein os factory` drive the server through this module, so whichever
// surface started it can also stop it and report its status.
// Keep this module Electron-free so the test suite and the Rein CLI run it
// under plain Node.
import { appendFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// State contract: paths, pid file, port, and readiness probes.
// ---------------------------------------------------------------------------

export function stateDirFor({ env = process.env, userHome = "" } = {}) {
  const home = env.HOME?.trim() || userHome;
  if (!home) throw new Error("Missing user home for the Mastra Factory state paths.");
  return join(home, ".local", "state", "rein-factory");
}

export function projectDirFor({ env = process.env, userHome = "" } = {}) {
  const explicit = env.FACTORY_PROJECT?.trim();
  if (explicit) return explicit;
  const home = env.HOME?.trim() || userHome;
  if (!home) throw new Error("Missing user home for the Mastra Factory project directory.");
  return join(home, ".local", "share", "rein-factory");
}

export function serverPort({ env = process.env } = {}) {
  const port = Number(env.FACTORY_PORT?.trim() || 4111);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("FACTORY_PORT must be a whole number between 1 and 65535.");
  return port;
}

export function serverUrlFor(port) {
  return `http://127.0.0.1:${port}`;
}

export function readPidFile(pidFile) {
  try {
    if (!lstatSync(pidFile).isFile()) return undefined;
    const raw = readFileSync(pidFile, "utf8").trim();
    if (!/^\d{1,10}$/.test(raw)) return undefined;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function writePidFile(pidFile, pid) {
  mkdirSync(join(pidFile, ".."), { recursive: true });
  writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 });
}

export function clearPidFile(pidFile) {
  rmSync(pidFile, { force: true });
}

export function isPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function logTail(logFile, bytes = 4096) {
  try {
    return readFileSync(logFile, "utf8").slice(-bytes).trim();
  } catch {
    return "";
  }
}

export async function probeUrl(url, timeoutMs = 1500) {
  try {
    const response = await fetch(url + "/", { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function statePaths({ env = process.env, userHome = "" } = {}) {
  const stateDir = stateDirFor({ env, userHome });
  return {
    stateDir,
    projectDir: projectDirFor({ env, userHome }),
    pidFile: join(stateDir, "server.pid"),
    logFile: join(stateDir, "server.log"),
  };
}

// ---------------------------------------------------------------------------
// Supervisor commands: status, start, stop, open.
// ---------------------------------------------------------------------------

export async function serverStatus({ env = process.env, userHome = "", port, timeoutMs = 1500 } = {}) {
  const paths = statePaths({ env, userHome });
  const resolvedPort = port ?? serverPort({ env });
  const url = serverUrlFor(resolvedPort);
  const pid = readPidFile(paths.pidFile);
  const code = await probeUrl(url, timeoutMs);
  const reachable = code !== undefined;
  const owned = pid !== undefined && isPidAlive(pid);
  // running: this supervisor owns a live server. external: a server answers
  // on the port but no pid file claims it (started outside the supervisor).
  const state = reachable ? (owned ? "running" : "external") : "stopped";
  return { state, url, port: resolvedPort, pid, reachable, owned, projectDir: paths.projectDir, logFile: paths.logFile, recentLog: owned || reachable ? undefined : logTail(paths.logFile) };
}

// The built server (production profile) always requires DATABASE_URL; the
// dev profile runs the single-machine libSQL storage instead.
function databaseUrlConfigured(projectDir, env) {
  if (env.DATABASE_URL?.trim()) return true;
  try {
    return /(^|\n)\s*DATABASE_URL=\S+/m.test(readFileSync(join(projectDir, ".env"), "utf8"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Start lock: serializes concurrent starts (app + CLI) so only one spawns.
// ---------------------------------------------------------------------------

function startLockFile(paths) {
  return join(paths.stateDir, "start.lock");
}

// Acquire the start lock with O_EXCL. A lock whose holder pid is gone is
// stale (the holder crashed before releasing) and is taken over.
export function tryAcquireStartLock(paths) {
  mkdirSync(paths.stateDir, { recursive: true });
  const lockFile = startLockFile(paths);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = openSync(lockFile, "wx");
      try { writeFileSync(descriptor, `${process.pid}\n`); } finally { closeSync(descriptor); }
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const holder = readPidFile(lockFile);
      if (holder !== undefined && isPidAlive(holder)) return false;
      rmSync(lockFile, { force: true });
    }
  }
  return false;
}

export function releaseStartLock(paths) {
  rmSync(startLockFile(paths), { force: true });
}

// Run fn while holding the start lock. A concurrent start holds it; wait for
// it to finish (its server becomes reachable, then fn attaches) or time out.
export async function withStartLock(paths, timeoutMs, fn) {
  // The holder keeps the lock for its own readiness wait (timeoutMs) plus, on
  // failure, a graceful stop. Allow a fixed window beyond that — capped so a
  // small timeout (tests) does not pay a large fixed wait — before giving up.
  const grace = Math.min(10_000, Math.max(1_000, timeoutMs));
  const deadline = Date.now() + timeoutMs + grace;
  for (;;) {
    if (tryAcquireStartLock(paths)) {
      try {
        return await fn();
      } finally {
        releaseStartLock(paths);
      }
    }
    await sleep(500);
    if (Date.now() > deadline) throw new Error("Timed out waiting for another Mastra Factory start to finish.");
  }
}

export async function startServer({
  env = process.env, userHome = "", port, timeoutMs = 120_000, attachIfRunning = false, mode = "production", log = () => {},
} = {}) {
  if (mode !== "production" && mode !== "dev") throw new Error("mode must be production or dev.");
  const paths = statePaths({ env, userHome });
  const resolvedPort = port ?? serverPort({ env });
  const url = serverUrlFor(resolvedPort);
  // The status check, spawn, pid publication, and readiness wait are one
  // critical section. The start lock keeps two supervisors (app + CLI) from
  // both reading "stopped" and both spawning; a waiter attaches to the winner.
  return withStartLock(paths, timeoutMs, async () => {
    const current = await serverStatus({ env, userHome, port: resolvedPort });
    if (current.state !== "stopped") {
      if (attachIfRunning) {
        log(`Using the Mastra Factory server already at ${url}${current.pid ? ` (pid ${current.pid})` : ""}.`);
        return { pid: current.pid, url, state: current.state };
      }
      if (current.state === "running") throw new Error(`A Mastra Factory server is already running (pid ${current.pid}). Stop it first: rein os factory stop`);
      throw new Error(`A server is already answering on ${url} but this supervisor does not own it. Stop it where it was started.`);
    }
    if (!existsSync(join(paths.projectDir, "package.json"))) throw new Error("The Mastra Factory project is not set up. Run: rein os factory setup");
    if (!existsSync(join(paths.projectDir, "node_modules"))) throw new Error("The Mastra Factory dependencies are not installed. Run: rein os factory setup");
    if (mode === "production" && !databaseUrlConfigured(paths.projectDir, env)) {
      throw new Error("The production profile requires DATABASE_URL (Postgres). Set it in the project .env or the environment — or run the single-machine profile: rein os factory dev");
    }
    if (hasBuildScript(paths.projectDir) && !existsSync(join(paths.projectDir, ".mastra", "output")) && mode === "production") {
      // `mastra start` runs the built server; build it once when it is missing.
      await buildProject(paths.projectDir, { log });
    }
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const script = mode === "dev" ? "dev" : "start";
    // Detached: the server becomes its own process group, so the pid file is a
    // group id and stopServer can end npm, the shell, and the server together.
    const child = spawn(npm, ["run", script], {
      cwd: paths.projectDir,
      env: { ...env, PORT: String(resolvedPort), NODE_ENV: mode === "dev" ? "development" : "production" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    const sink = chunk => appendFileSync(paths.logFile, chunk);
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    // The pipes would otherwise pin the caller's event loop: a CLI that starts
    // the server and exits must not wait on them. The app keeps the child.
    child.stdout.unref();
    child.stderr.unref();
    child.once("error", error => log(`Server spawn error: ${error.message}`));
    child.unref();
    const pid = child.pid;
    if (!pid) throw new Error("The Mastra Factory server did not spawn.");
    writePidFile(paths.pidFile, pid);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) {
        clearPidFile(paths.pidFile);
        throw new Error(`The Mastra Factory server exited before it was ready.\n${logTail(paths.logFile) || "No server output was captured."}`);
      }
      const code = await probeUrl(url, 1500);
      if (code !== undefined && code >= 200 && code < 400) {
        log(`Mastra Factory is running at ${url} (pid ${pid}).`);
        return { pid, url, state: "running" };
      }
      await sleep(500);
    }
    await stopServer({ env, userHome });
    throw new Error(`The Mastra Factory server did not become ready within ${Math.round(timeoutMs / 1000)}s.\n${logTail(paths.logFile) || "No server output was captured."}`);
  });
}

export async function stopServer({ env = process.env, userHome = "", graceMs = 5000, log = () => {} } = {}) {
  const paths = statePaths({ env, userHome });
  const pid = readPidFile(paths.pidFile);
  if (pid === undefined) throw new Error("No Mastra Factory server is registered with this supervisor.");
  if (!isPidAlive(pid)) {
    clearPidFile(paths.pidFile);
    log("Cleared the stale pid file.");
    return { pid, state: "stopped" };
  }
  const signal = name => {
    // Group kill first (a detached spawn makes the pid a group id); a plain
    // kill covers servers whose child shares another process's group.
    try { process.kill(-pid, name); } catch { try { process.kill(pid, name); } catch { /* gone */ } }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isPidAlive(pid)) await sleep(100);
  if (isPidAlive(pid)) signal("SIGKILL");
  await sleep(100);
  clearPidFile(paths.pidFile);
  log(`Stopped the Mastra Factory server (pid ${pid}).`);
  return { pid, state: "stopped" };
}

export async function openServer({ env = process.env, userHome = "", open, port, timeoutMs = 120_000, mode, log = () => {} } = {}) {
  const paths = statePaths({ env, userHome });
  const resolvedPort = port ?? serverPort({ env });
  const url = serverUrlFor(resolvedPort);
  const status = await serverStatus({ env, userHome, port: resolvedPort });
  // Default to the profile the machine is configured for: Postgres when
  // DATABASE_URL is present, otherwise the single-machine dev profile.
  const resolvedMode = mode ?? (databaseUrlConfigured(paths.projectDir, env) ? "production" : "dev");
  if (status.state === "stopped") await startServer({ env, userHome, port: resolvedPort, timeoutMs, mode: resolvedMode, log });
  if (!open) throw new Error("No opener was provided for the Mastra Factory URL.");
  await open(url);
  return { url, started: status.state === "stopped", mode: resolvedMode };
}

function hasBuildScript(projectDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
    return typeof pkg?.scripts?.build === "string";
  } catch {
    return false;
  }
}

// One-time dependency install for the generated project. Shared by the native
// app and `rein os factory setup` so both install the same way.
export async function installDependencies(projectDir, { log = () => {} } = {}) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  log("Installing Mastra Factory dependencies (one time).");
  await new Promise((resolve, reject) => {
    const child = spawn(npm, ["install", "--no-audit", "--no-fund"], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", error => reject(new Error(error.message)));
    child.once("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`Dependency install finished with exit code ${code}.\nSee ${projectDir} for details.`));
    });
  });
  log("Dependency install finished.");
}

// One-time server build for the generated project (`mastra start` runs the
// built server from .mastra/output). Shared by both surfaces.
// The build inlines the NODE_ENV-based storage gate, so build for the
// self-hosted single-machine profile (libSQL fallback); a runtime
// DATABASE_URL still selects Postgres when present.
export async function buildProject(projectDir, { log = () => {} } = {}) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  log("Building the Mastra Factory server (one time).");
  await new Promise((resolve, reject) => {
    const child = spawn(npm, ["run", "build"], { cwd: projectDir, env: { ...process.env, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", error => reject(new Error(error.message)));
    child.once("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`The Mastra Factory build finished with exit code ${code}.\nSee ${projectDir} for details.`));
    });
  });
  log("Mastra Factory build finished.");
}
