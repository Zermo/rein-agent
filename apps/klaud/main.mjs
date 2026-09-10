import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, lstatSync, openSync, closeSync, readFileSync, fstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyDelta, applyShellPatch, frontendTools, replayEvents, requestRoute, sseEvents, validateConnection, validateMessages, validateState } from "./model.mjs";
import { stopChild } from "./lifecycle.mjs";
import { localRuntimeEnvironment, prepareLocalRuntime } from "./runtime-paths.mjs";
import { accountVerificationUrl, createOnboarding, onboardingEnvironment } from "./onboarding.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const rendererUrl = pathToFileURL(join(directory, "dist/index.html")).href;
const appIconPath = join(directory, "icon.png");
const trayIconPath = busy => join(directory, `tray-${busy ? "working" : "ready"}${process.platform === "darwin" ? "Template" : ""}.png`);
const environment = process.env.REIN_KLAUD_URL && process.env.REIN_KLAUD_TOKEN ? { mode: "remote", url: process.env.REIN_KLAUD_URL, token: process.env.REIN_KLAUD_TOKEN } : undefined;
delete process.env.REIN_KLAUD_TOKEN;
// Product rename must preserve the existing Electron cookies, preferences and storage.
app.setPath("userData", join(app.getPath("appData"), "rein-klaʊd"));
process.title = "klaʊdbot";
app.setName("klaʊdbot");
app.setAppUserModelId("org.zermo.rein-klaud");
const onboarding = createOnboarding({ userHome: homedir(), userData: app.getPath("userData"), sourceHome: process.env.REIN_HOME });
let window, tray, connection, state, activeRun, ownedServe, starting, onboardingPreparing = false, sequence = 0, quitting = false, shutdown = false;
const send = event => { event.sequence = ++sequence; if (window && !window.isDestroyed()) window.webContents.send("klaud:event", event); };
const show = () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); } };
const safeError = error => String(error?.message || "Request failed.").replaceAll(connection?.token || "\0", "[redacted]").slice(0, 1000);

function trayIcon(busy = false) {
  const icon = nativeImage.createFromPath(trayIconPath(busy));
  icon.setTemplateImage(process.platform === "darwin");
  return icon;
}
function updateTray() {
  const mode = state?.shell.chrome.tray ?? "normal";
  if (mode === "hidden") { tray?.destroy(); tray = undefined; return; }
  const busy = mode === "normal" && !!activeRun;
  if (!tray) { tray = new Tray(trayIcon(busy)); tray.on("click", show); }
  tray.setImage(trayIcon(busy));
  tray.setToolTip(busy ? "klaʊdbot · Running" : "klaʊdbot");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open klaʊdbot", click: show },
    ...(mode === "normal" ? [{ label: activeRun ? "Running" : "Ready", enabled: false }] : []),
    { type: "separator" }, { label: "Quit klaʊdbot", click: () => app.quit() },
  ]));
}
function adoptState(value, publish = false) {
  state = validateState(value);
  if (activeRun) for (const [id, pending] of activeRun.pending) {
    if ((pending.kind === "klaud.approval" || pending.toolName === "confirmAction") && !state.approvals.some(item => item.id === id)) activeRun.pending.delete(id);
  }
  updateTray();
  if (publish) send({ type: "STATE_SNAPSHOT", snapshot: state });
  return state;
}
async function http(method, path, body, signal = AbortSignal.timeout(15_000)) {
  if (!connection) throw new Error("Connect to rein serve first.");
  const response = await fetch(connection.url + path, {
    method, redirect: "error", signal,
    headers: { Authorization: `Bearer ${connection.token}`, Origin: connection.url, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    // These authenticated setup endpoints return deliberately safe validation errors.
    // Keep ordinary model/tool responses opaque; they may contain private content.
    let detail;
    if (/^\/(?:setup(?:\/(?:probe|discover|hardware))?|accounts(?:\/provider|\/logins(?:\/[a-f0-9-]+)?)?)$/.test(path)
      && response.headers.get("content-type")?.split(";")[0].trim() === "application/json" && response.body) {
      const reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 8192) break;
          chunks.push(Buffer.from(next.value));
        }
        if (bytes <= 8192) {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1
            && typeof value.error === "string" && value.error.trim() && value.error.length <= 2048) {
            detail = value.error.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
            for (const secret of [connection?.token, body?.apiKey]) if (typeof secret === "string" && secret) detail = detail.replaceAll(secret, "[redacted]");
            detail = detail.replace(/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization)\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]");
          }
        }
      } catch { /* Malformed, oversized, or interrupted responses use the generic failure. */ }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } else await response.body?.cancel();
    throw new Error(detail || `rein serve returned HTTP ${response.status}. ${response.status === 401 ? "Check the bearer token." : response.status === 501 ? "This backend does not support that operation yet." : "The request was rejected."}`);
  }
  return response;
}
async function json(method, path, body) {
  const response = await http(method, path, body), reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error("Backend response is too large.");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function refresh(publish = false) { return adoptState(await json("GET", "/state"), publish); }
async function stopOwnedServe() {
  const child = ownedServe; ownedServe = undefined;
  await stopChild(child);
}
async function startLocal() {
  if (quitting) throw new Error("The app is quitting.");
  const { entry, cwd, home } = prepareLocalRuntime({ packaged: app.isPackaged, appDirectory: directory, resourcesPath: process.resourcesPath, userHome: homedir(), reinHome: onboarding.home(), isolated: true });
  const child = spawn(process.execPath, [entry, "serve", "--port", "0"], {
    cwd, env: localRuntimeEnvironment({ packaged: app.isPackaged, environment: onboardingEnvironment(process.env), home, userHome: homedir() }), stdio: ["ignore", "pipe", "pipe"],
  });
  ownedServe = child;
  // Output is parsed privately. Neither stdout nor stderr is copied into app logs.
  child.stderr.resume();
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("Local rein serve did not become ready.")); }, 15_000);
    const cleanup = () => { clearTimeout(timer); child.stdout.removeListener("data", data); child.removeListener("error", fail); child.removeListener("exit", exited); };
    const fail = () => { cleanup(); reject(new Error("I couldn't start local rein serve.")); };
    const exited = () => { cleanup(); reject(new Error("Local rein serve exited before it was ready.")); };
    const data = chunk => {
      output = (output + chunk.toString("utf8")).slice(-8192);
      const found = output.match(/http:\/\/127\.0\.0\.1:([1-9]\d*)\b/);
      if (found) { cleanup(); child.stdout.resume(); resolve(found[0]); }
    };
    child.stdout.on("data", data); child.once("error", fail); child.once("exit", exited);
  });
  const file = join(home, "klaud", `serve-${new URL(url).port}.token`);
  for (const path of [home, dirname(file)]) if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("Invalid Rein token directory.");
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let token;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 513 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error("The Rein token file must be private and owned by this user.");
    token = readFileSync(descriptor, "utf8").trim();
  } finally { closeSync(descriptor); }
  child.once("exit", () => {
    if (ownedServe !== child || quitting) return;
    ownedServe = undefined; connection = undefined;
    send({ type: "CONNECTION_ERROR", message: "Local rein serve stopped. Reconnect to continue." });
  });
  return validateConnection(url, token);
}
async function connect(options) {
  if (activeRun) throw new Error("Stop the current run before reconnecting.");
  if (starting) throw new Error("A connection is already starting.");
  starting = true;
  try {
    if (!options || !["local", "remote"].includes(options.mode)) throw new Error("Choose local serve or URL + token.");
    // Validate user input before stopping an owned process.
    const candidate = options.mode === "remote" ? validateConnection(options.url, options.token) : undefined;
    await stopOwnedServe();
    if (quitting) throw new Error("The app is quitting.");
    connection = candidate || await startLocal();
    if (quitting) throw new Error("The app is quitting.");
    await refresh();
    return { connected: true, url: connection.url, state, run: null };
  } catch (error) { connection = undefined; state = undefined; await stopOwnedServe(); throw error; }
  finally { starting = false; }
}
async function startRun(input) {
  if (activeRun) throw new Error("A run is already active.");
  if (!input || typeof input.threadId !== "string" || !input.threadId || input.threadId.length > 160 || typeof input.message !== "string" || !input.message.trim() || input.message.length > 128 * 1024 || typeof input.botId !== "string" || !state?.bots.some(bot => bot.id === input.botId && bot.sessionId === input.threadId)) throw new Error("Choose a bot and enter a message.");
  let ready;
  const run = { id: undefined, botId: input.botId, controller: new AbortController(), pending: new Map(), events: [], eventBytes: 0, terminal: false, baseline: [], ready: new Promise(resolve => { ready = resolve; }) };
  activeRun = run; updateTray();
  try {
    try {
      const history = await json("GET", `/bots/${encodeURIComponent(input.botId)}/messages`);
      run.baseline = validateMessages(history.messages);
    } catch {
      // A missing or oversized UI history cannot stop the runner from using its durable session.
      run.replayTruncated = true;
    }
    if (quitting || run.controller.signal.aborted) throw new Error("Run cancelled.");
    run.baseline.push({ id: `pending-user-${randomUUID()}`, role: "user", content: input.message });
  } catch (error) { activeRun = undefined; updateTray(); throw error; }
  finally { ready(); }
  void (async () => {
    try {
      const response = await http("POST", "/run", { threadId: input.threadId, botId: input.botId, message: input.message, tools: frontendTools }, run.controller.signal);
      if (!response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("Expected an AG-UI event stream.");
      for await (const event of sseEvents(response.body)) {
        if (event.type === "RUN_STARTED") {
          if (typeof event.runId !== "string" || !/^[a-f0-9-]+$/.test(event.runId)) throw new Error("Invalid run identifier.");
          run.id = event.runId;
        }
        if (event.type === "STATE_SNAPSHOT") adoptState(event.snapshot);
        if (event.type === "STATE_DELTA") {
          try { adoptState(applyDelta(state, event.delta)); }
          catch { await refresh(true); continue; }
        }
        if (event.type === "CUSTOM" && ["klaud.frontend_tool", "klaud.approval"].includes(event.name)) {
          const value = event.value, id = value?.toolCallId ?? value?.id;
          if (value?.runId !== run.id || typeof id !== "string" || !id || id.length > 160 || run.pending.has(id)) throw new Error("Invalid pending action.");
          if (event.name === "klaud.frontend_tool" && !frontendTools.some(tool => tool.name === value.toolName)) throw new Error("Unknown frontend tool.");
          run.pending.set(id, { ...value, kind: event.name, event });
        }
        if (event.type === "TOOL_CALL_RESULT") run.pending.delete(event.providerToolCallId ?? event.toolCallId);
        if (["RUN_FINISHED", "RUN_ERROR"].includes(event.type)) run.terminal = true;
        if (!run.replayTruncated) {
          run.events.push(event); run.eventBytes += JSON.stringify(event).length;
          // ponytail: bound reload replay memory, without stopping or slowing a healthy run.
          if (run.eventBytes > 8 * 1024 * 1024) { run.events = []; run.replayTruncated = true; }
        }
        send(event);
      }
      if (!run.terminal) throw new Error("The backend stream ended before the run finished.");
    } catch (error) { send({ type: "RUN_ERROR", runId: run.id, message: run.controller.signal.aborted ? "Run cancelled." : safeError(error) }); }
    finally {
      if (activeRun === run) activeRun = undefined;
      updateTray(); send({ type: "RUN_SETTLED", botId: run.botId });
      if (connection && !quitting) await refresh(true).catch(() => {});
    }
  })();
  return { started: true };
}
function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererUrl) throw new Error("Untrusted renderer.");
}
function handle(name, callback) {
  ipcMain.handle(`klaud:${name}`, async (event, ...args) => {
    trusted(event);
    try { return await callback(...args); } catch (error) { throw new Error(safeError(error)); }
  });
}
async function answerTool(input) {
  const run = activeRun, pending = run?.pending.get(input?.toolCallId);
  if (!run?.id || input.runId !== run.id || pending?.kind !== "klaud.frontend_tool" || typeof input.result !== "string" || input.result.length > 128 * 1024 || input.isError !== undefined && typeof input.isError !== "boolean") throw new Error("No matching pending frontend tool.");
  if (pending.toolName === "confirmAction") throw new Error("Use the confirmation dialog for this action.");
  const response = await json("POST", `/runs/${run.id}/tools/${encodeURIComponent(input.toolCallId)}`, { result: input.result, isError: input.isError === true });
  run.pending.delete(input.toolCallId);
  await refresh(true);
  return response;
}
async function confirmPending(id) {
  const run = activeRun, pending = run?.pending.get(id);
  if (!run?.id || !pending || pending.prompting || !(pending.kind === "klaud.approval" || pending.toolName === "confirmAction")) throw new Error("No matching pending confirmation.");
  pending.prompting = true;
  try {
    show();
    const action = pending.kind === "klaud.approval" ? pending.summary : pending.args?.action;
    if (typeof action !== "string" || action.length > 4000) throw new Error("Invalid confirmation text.");
    const { response } = await dialog.showMessageBox(window, {
      type: "question", title: "klaʊdbot", message: pending.kind === "klaud.approval" ? `Allow ${String(pending.tool).slice(0, 100)}?` : "Confirm this action?",
      detail: action, buttons: ["Deny", "Allow"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (activeRun !== run || !run.pending.has(id)) throw new Error("This action is no longer pending.");
    const allow = response === 1;
    if (pending.kind === "klaud.approval") await json("POST", `/runs/${run.id}/approvals/${encodeURIComponent(id)}`, { allow });
    else await json("POST", `/runs/${run.id}/tools/${encodeURIComponent(id)}`, { result: JSON.stringify({ confirmed: allow }) });
    run.pending.delete(id); await refresh(true);
    return { confirmed: allow };
  } finally { pending.prompting = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  // Finish evaluating the ESM entry before waiting for Electron's ready event.
  void (async () => {
  app.on("second-instance", show);
  app.on("activate", show);
  app.on("window-all-closed", () => {});
  app.on("before-quit", event => {
    if (shutdown) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    activeRun?.controller.abort();
    void stopOwnedServe().finally(() => {
      tray?.destroy();
      // Let macOS finish the prevented native Quit before resuming it.
      setImmediate(() => { shutdown = true; app.quit(); });
    });
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.quit());
  await app.whenReady();
  const appIcon = nativeImage.createFromPath(appIconPath);
  if (process.platform === "darwin" && !appIcon.isEmpty()) app.dock.setIcon(appIcon);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "klaʊdbot", submenu: [{ label: "Open klaʊdbot", click: show }, { type: "separator" }, { role: "quit", label: "Quit klaʊdbot" }] },
    { role: "editMenu" }, { role: "windowMenu" },
  ]));
  window = new BrowserWindow({
    width: 1100, height: 780, minWidth: 720, minHeight: 520, title: "klaʊdbot", backgroundColor: "#151b22", icon: appIcon,
    webPreferences: { preload: join(directory, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false },
  });
  window.on("close", event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  const initialConnection = (async () => {
    const setup = onboarding.inspect();
    // Resume local onboarding against its owned home until the final step is saved.
    if (setup.prepared) return connect(setup.completed && environment ? environment : { mode: "local" });
  })().catch(error => ({ error: safeError(error) }));
  handle("onboarding-inspect", () => onboarding.inspect());
  handle("onboarding-prepare", async input => {
    if (!input || Object.keys(input).length !== 1 || !["migrate", "fresh"].includes(input.choice)) throw new Error("Choose migration or a fresh setup.");
    if (activeRun || onboardingPreparing || starting) throw new Error("Wait for the current operation before preparing setup.");
    const setup = onboarding.inspect();
    if (setup.completed) throw new Error("Initial setup is complete. Use Settings to change your bot.");
    if (connection && (!ownedServe || !setup.prepared || setup.choice !== input.choice)) throw new Error("Disconnect before preparing a different home.");
    onboardingPreparing = true;
    try {
      await onboarding.prepare(input.choice);
      if (connection && ownedServe) return { connected: true, url: connection.url, state, run: null };
      return await connect({ mode: "local" });
    } finally { onboardingPreparing = false; }
  });
  handle("onboarding-complete", () => {
    if (!connection || !ownedServe || !state?.bots.length || activeRun || onboardingPreparing || starting) throw new Error("Connect your local home and create or select a bot before finishing setup.");
    return onboarding.complete();
  });
  handle("open-account-auth", async url => { await shell.openExternal(accountVerificationUrl(url)); return { opened: true }; });
  handle("status", async () => {
    const initial = await initialConnection;
    await activeRun?.ready;
    return { connected: !!connection, url: connection?.url, state, error: initial?.error, sequence, run: activeRun ? { id: activeRun.id, botId: activeRun.botId, baseline: activeRun.baseline, replayTruncated: !!activeRun.replayTruncated, events: replayEvents(activeRun) } : null };
  });
  handle("connect", connect);
  handle("request", async (operation, input) => {
    const route = requestRoute(operation, input);
    if (operation === "patchShell") applyShellPatch(state?.shell, route.body.patch);
    const result = await json(route.method, route.path, route.body);
    if (["state", "patchShell", "setPref"].includes(operation)) return adoptState(result, true);
    if (operation === "createBot") await refresh(true);
    return result;
  });
  handle("run", startRun);
  handle("cancel", async () => {
    const run = activeRun;
    if (!run) return { cancelled: false };
    try { if (run.id) await json("POST", `/runs/${run.id}/cancel`, {}); }
    finally { run.controller.abort(); }
    return { cancelled: true };
  });
  handle("tool-result", answerTool);
  handle("confirm", confirmPending);
  updateTray();
  await window.loadURL(rendererUrl);
  })().catch(error => { console.error(safeError(error)); app.quit(); });
}
