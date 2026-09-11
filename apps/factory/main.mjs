// Mastra Factory for Dareecho: a native window and supervisor that hosts the
// Mastra Factory server alongside Dareecho. It does not rebrand Factory —
// the name, UI, and icon stay Mastra's (see NOTICE).
import { app, BrowserWindow, Menu, dialog, nativeImage, shell } from "electron";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stopChild } from "./lifecycle.mjs";
import { inspectProject, provisionProject, resolveProjectDir, resolveTemplateDir } from "./provision.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.FACTORY_PORT?.trim() || 4111);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  console.error("FACTORY_PORT must be a whole number between 1 and 65535.");
  process.exit(1);
}
const serverUrl = `http://127.0.0.1:${port}`;
const startTimeoutMs = Number(process.env.FACTORY_START_TIMEOUT_MS?.trim() || 120_000);
const projectDir = resolveProjectDir({ env: process.env, userHome: homedir() });
const templateDir = resolveTemplateDir({ appDirectory: directory, packaged: app.isPackaged, resourcesPath: process.resourcesPath });

// Product identity: the app is Mastra Factory; Dareecho is the host.
app.setPath("userData", join(app.getPath("appData"), "rein-factory"));
app.setName("Mastra Factory");
app.setAppUserModelId("org.zermo.mastra-factory");
process.title = "mastra-factory";

let window, server, owned = false, starting = false, quitting = false, shutdown = false, serverOutput = "";
const log = text => console.log(`[mastra-factory] ${text}`);
const safeError = error => String(error?.message || "The operation failed.").slice(0, 2000);
const tail = (bytes = 4096) => serverOutput.slice(-bytes).trim();
const show = () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); } };

function serverStatus() {
  return server && (server.exitCode === null && server.signalCode === null) ? "running" : "stopped";
}
function menuServerStatus() {
  return serverStatus() === "running" ? "Running" : "Stopped";
}
function rebuildMenu() {
  if (!window) return;
  const status = menuServerStatus();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Mastra Factory", submenu: [
      { label: "About Mastra Factory", click: showAbout },
      { type: "separator" },
      { label: "Open Mastra Factory", click: show },
      { label: "Reload", click: () => window?.reload() },
      { label: "Restart server", click: restartServer, enabled: serverStatus() === "running" },
      { type: "separator" },
      { label: `Server: ${status}`, enabled: false },
      { role: "quit", label: "Quit Mastra Factory" },
    ] },
    { role: "editMenu" }, { role: "windowMenu" },
  ]));
}
function showAbout() {
  dialog.showMessageBox(window, {
    type: "info",
    title: "Mastra Factory",
    message: `Mastra Factory ${app.getVersion()}`,
    detail: "An open-source environment for building software with coding agents, by Mastra (Apache-2.0).\n\nHosted by Dareecho. This wrapper does not rebrand Factory; the name, interface, and icon are Mastra's.\n\nUpstream: github.com/mastra-ai/mastra (mastracode/factory)",
    buttons: ["OK"],
    defaultId: 0,
    noLink: true,
  });
}

function attachOutput(child) {
  const drain = stream => stream.on("data", chunk => { serverOutput = (serverOutput + chunk.toString("utf8")).slice(-32 * 1024); });
  drain(child.stdout);
  drain(child.stderr);
}
async function probe() {
  try {
    const response = await fetch(serverUrl + "/", { method: "GET", redirect: "manual", signal: AbortSignal.timeout(1500) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
}
async function startServer() {
  if (server || starting) return;
  starting = true;
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npm, ["run", "start"], {
      cwd: projectDir,
      // Without DATABASE_URL the server needs NODE_ENV=development for
      // single-machine libSQL storage; with it, production semantics apply.
      env: { ...process.env, PORT: String(port), NODE_ENV: process.env.DATABASE_URL?.trim() ? "production" : "development" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server = child;
    owned = true;
    attachOutput(child);
    child.once("error", error => log(`Server spawn error: ${error.message}`));
    child.once("exit", (code, signal) => {
      log(`Server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
      if (owned) owned = false;
      rebuildMenu();
    });
    const deadline = Date.now() + startTimeoutMs;
    let lastStatus;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(tail() || "The Mastra Factory server exited before it was ready.");
      lastStatus = await probe();
      if (lastStatus && lastStatus >= 200 && lastStatus < 400) { log(`Server ready at ${serverUrl} (HTTP ${lastStatus}).`); return; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`The Mastra Factory server did not become ready within ${Math.round(startTimeoutMs / 1000)}s.\n${tail()}`);
  } catch (error) {
    await stopChild(server);
    server = undefined;
    owned = false;
    throw error;
  } finally {
    starting = false;
  }
}
async function stopServer() {
  const child = server;
  server = undefined;
  if (owned && child) await stopChild(child);
  owned = false;
}
async function restartServer() {
  await stopServer();
  try {
    await startServer();
  } catch (error) {
    dialog.showMessageBox(window, { type: "error", title: "Mastra Factory", message: "The server restart failed.", detail: safeError(error), buttons: ["OK"], noLink: true });
  }
  rebuildMenu();
}
async function installDependencies() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  log("Installing Mastra Factory dependencies (one time).");
  await new Promise((resolve, reject) => {
    const child = spawn(npm, ["install", "--no-audit", "--no-fund"], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] });
    attachOutput(child);
    child.once("error", error => reject(new Error(error.message)));
    child.once("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`Dependency install finished with exit code ${code}.\n${tail()}`));
    });
  });
  log("Dependency install finished.");
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  void (async () => {
    app.on("second-instance", show);
    app.on("activate", show);
    app.on("window-all-closed", () => {});
    app.on("before-quit", event => {
      if (shutdown) return;
      event.preventDefault();
      if (quitting) return;
      quitting = true;
      void stopServer().finally(() => {
        window?.destroy();
        setImmediate(() => { shutdown = true; app.quit(); });
      });
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.quit());
    await app.whenReady();
    const appIcon = nativeImage.createFromPath(join(directory, "icon.png"));
    if (process.platform === "darwin" && !appIcon.isEmpty()) app.dock.setIcon(appIcon);

    const setup = await (async () => {
      const state = inspectProject({ projectDir, templateDir });
      if (!state.templateOk) throw new Error("The bundled Mastra Factory template is missing. Reinstall the app.");
      provisionProject({ projectDir, templateDir, databaseUrl: process.env.DATABASE_URL, log });
      if (!state.installed) await installDependencies();
      const existing = await probe();
      if (existing && existing >= 200 && existing < 400) { log(`Using the already-running server at ${serverUrl}.`); return; }
      await startServer();
    })().catch(error => {
      dialog.showMessageBox({ type: "error", title: "Mastra Factory", message: "Mastra Factory could not start.", detail: safeError(error), buttons: ["OK"], noLink: true });
      app.quit();
      return;
    });
    if (!setup) return;

    window = new BrowserWindow({
      width: 1240, height: 820, minWidth: 900, minHeight: 600, title: "Mastra Factory", backgroundColor: "#101014", icon: appIcon,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false },
    });
    // Factory's UI opens external links (GitHub, Linear, Slack). Keep them in
    // the user's browser; in-window navigation stays on the Factory origin.
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
      return { action: "deny" };
    });
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.on("close", event => { if (!quitting) { event.preventDefault(); window.hide(); } });
    rebuildMenu();
    await window.loadURL(serverUrl);
  })().catch(error => { console.error(safeError(error)); app.quit(); });
}
