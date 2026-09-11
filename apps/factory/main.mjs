// Mastra Factory for Dareecho: a native window and supervisor that hosts the
// Mastra Factory server alongside Dareecho. It does not rebrand Factory —
// the name, UI, and icon stay Mastra's (see NOTICE).
import { app, BrowserWindow, Menu, dialog, nativeImage, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProject, installDependencies, probeUrl, projectDirFor, serverPort, serverUrlFor, serverStatus, startServer, stopServer } from "./supervisor.mjs";
import { inspectProject, provisionProject, resolveTemplateDir } from "./provision.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const port = serverPort({ env: process.env });
const serverUrl = serverUrlFor(port);
const startTimeoutMs = Number(process.env.FACTORY_START_TIMEOUT_MS?.trim() || 120_000);
const userHome = homedir();
const templateDir = resolveTemplateDir({ appDirectory: directory, packaged: app.isPackaged, resourcesPath: process.resourcesPath });

// Product identity: the app is Mastra Factory; Dareecho is the host.
app.setPath("userData", join(app.getPath("appData"), "rein-factory"));
app.setName("Mastra Factory");
app.setAppUserModelId("org.zermo.mastra-factory");
process.title = "mastra-factory";

let window, starting = false, quitting = false, shutdown = false;
const log = text => console.log(`[mastra-factory] ${text}`);
const safeError = error => String(error?.message || "The operation failed.").slice(0, 2000);
const show = () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); } };

function menuServerStatus() {
  // The supervisor's status is shared with `rein os factory status`.
  return probeUrl(serverUrl, 500).then(code => (code !== undefined ? "Running" : "Stopped"));
}
function rebuildMenu() {
  if (!window) return;
  void menuServerStatus().then(status => {
    if (!window || window.isDestroyed()) return;
    Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Mastra Factory", submenu: [
      { label: "About Mastra Factory", click: showAbout },
      { type: "separator" },
      { label: "Open Mastra Factory", click: show },
      { label: "Reload", click: () => window?.reload() },
      { label: "Restart server", click: restartServer, enabled: status === "Running" },
      { type: "separator" },
      { label: `Server: ${status}`, enabled: false },
      { role: "quit", label: "Quit Mastra Factory" },
    ] },
    { role: "editMenu" }, { role: "windowMenu" },
  ]));
  });
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

async function startSupervised() {
  if (starting) return;
  starting = true;
  try {
    // Production when the machine has a database, single-machine otherwise.
    const mode = process.env.DATABASE_URL?.trim() ? "production" : "dev";
    await startServer({ env: process.env, userHome, port, timeoutMs: startTimeoutMs, attachIfRunning: true, mode, log });
  } finally {
    starting = false;
  }
}
async function stopSupervised() {
  try {
    await stopServer({ env: process.env, userHome, log });
  } catch {
    /* A server this app did not start stays up when the window quits. */
  }
}
async function restartServer() {
  await stopSupervised();
  try {
    await startSupervised();
  } catch (error) {
    dialog.showMessageBox(window, { type: "error", title: "Mastra Factory", message: "The server restart failed.", detail: safeError(error), buttons: ["OK"], noLink: true });
  }
  rebuildMenu();
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
      void stopSupervised().finally(() => {
        window?.destroy();
        setImmediate(() => { shutdown = true; app.quit(); });
      });
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.quit());
    await app.whenReady();
    const appIcon = nativeImage.createFromPath(join(directory, "icon.png"));
    if (process.platform === "darwin" && !appIcon.isEmpty()) app.dock.setIcon(appIcon);

    const setup = await (async () => {
      const projectDir = projectDirFor({ env: process.env, userHome });
      const state = inspectProject({ projectDir, templateDir });
      if (!state.templateOk) throw new Error("The bundled Mastra Factory template is missing. Reinstall the app.");
      provisionProject({ projectDir, templateDir, databaseUrl: process.env.DATABASE_URL, log });
      if (!state.installed) await installDependencies(projectDir, { log });
      if (!existsSync(join(projectDir, ".mastra", "output"))) await buildProject(projectDir, { log });
      await startSupervised();
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
