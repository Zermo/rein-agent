import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyDelta, applyShellPatch, presentTranscript, publicProgress, readTranscriptView, saveTranscriptView, updateTranscript, validateActivity, validateMessages, validateRunSettings, validateState } from "./model.mjs";
import { createSoundEngine, readSoundEnabled } from "./sounds.mjs";

import { BotAvatar, AvatarPicker } from "./avatars.jsx";
import { avatarForBot } from "./avatar-catalog.mjs";
import { SetupWizard } from "./setup-wizard.jsx";

const api = window.klaud;
const errorText = error => String(error?.message || "Something went wrong.").replace(/^Error invoking remote method '[^']+': Error: /, "");
const rainPreference = "rein.klaud.rain-enabled";
function readRainEnabled() {
  try { return localStorage.getItem(rainPreference) !== "false"; } catch { return true; }
}

function RainFrame({ paused }) {
  return <div className="rain-frame" data-paused={paused} aria-hidden="true">
    <svg className="rain-cloud" viewBox="0 0 32 16" shapeRendering="crispEdges"><path fill="currentColor" d="M2 8h4V4h6V2h8v2h6v4h4v6H2Z"/><path className="rain-cloud-cutout" d="M10 6h4V4h4v2h4v2h-4V6h-4v2h-4Z"/></svg>
    <span className="rain-drops">{Array.from({ length: 12 }, (_, index) => <i key={index}/>)}</span>
  </div>;
}

function ActivitySignal({ phase = "ready", toolName, className = "", lines = [] }) {
  const labels = { ready: "Ready", working: "Working", thinking: "Thinking", responding: "Typing", presenting: "Showing", journaling: "Journaling", autonomy: "Autonomy work", tool: toolName ? `Running ${toolName}` : "Running tool" };
  const label = labels[phase] ?? labels.working;
  const [open, setOpen] = useState(false);
  const tail = useRef(null);
  useEffect(() => { if (open && tail.current) tail.current.scrollTop = tail.current.scrollHeight; }, [open, lines]);
  return <div className={`activity-wrap ${className}`}>
    <button type="button" className={`activity ${phase === "ready" ? "ready" : "working"}`} data-phase={phase} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(value => !value)}>
      <span className="activity-signal" aria-hidden="true"><i/><i/><i/></span><span className="activity-label" title={label}>{label}</span>
    </button>
    {open && <div className="activity-drop" ref={tail} role="log" aria-label={`${label} stream`}>
      <p className="activity-drop-head">{label} · live tail</p>
      {lines.length ? <ol>{lines.map((line, index) => <li key={index}>{line}</li>)}</ol> : <p className="muted">No stream yet.</p>}
    </div>}
  </div>;
}

function inspectHits(text, cwd) {
  if (typeof text !== "string") return [];
  const hits = [];
  const re = /(?:`([^`]+\.(?:png|svg|html?|jpe?g|webp))`|([A-Za-z0-9_./-]+\.(?:png|svg|html?|jpe?g|webp)))/gi;
  const root = typeof cwd === "string" ? cwd.replace(/\/$/, "") : "";
  for (const match of text.matchAll(re)) {
    let rel = match[1] || match[2];
    if (rel.startsWith("/")) {
      if (root && (rel === root || rel.startsWith(root + "/"))) rel = rel.slice(root.length + 1);
      else rel = rel.split("/").filter(Boolean).pop() || "";
    } else rel = rel.replace(/^\.\//, "");
    if (rel && !rel.includes("..")) hits.push(rel);
  }
  return [...new Set(hits)];
}

function latestShownRel(messages, cwd) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item?.role !== "tool" || item.status === "running") continue;
    const hits = inspectHits(item.content || "", cwd).filter(rel => /\.(png|svg|html?|jpe?g|webp)$/i.test(rel));
    if (hits.length) return hits[hits.length - 1];
  }
  return "";
}

function groupTurns(messages) {
  const rows = [];
  let pending = [];
  let lastUser = null;
  const nodeFor = (item) => ({
    id: item.id,
    kind: item.role,
    label: item.role === "user" ? "You" : item.role === "tool" ? (item.toolName || "tool") : "Reply",
    text: String(item.thinking ? `${item.thinking}\n${item.content || ""}` : (item.content || item.arguments || "")).slice(0, 8000),
  });
  for (const item of Array.isArray(messages) ? messages : []) {
    if (item.role === "user") { lastUser = item; pending = []; rows.push(item); }
    else if (item.role === "tool") pending.push(item);
    else {
      rows.push({ ...item, path: [lastUser && nodeFor(lastUser), ...pending.map(nodeFor), nodeFor(item)].filter(Boolean) });
      pending = [];
    }
  }
  if (pending.length) {
    const last = rows.at(-1);
    const extra = pending.map(nodeFor);
    if (last?.role === "assistant") last.path = [...(last.path || []), ...extra];
    else rows.push({ id: "live-path", role: "assistant", content: "…", path: [lastUser && nodeFor(lastUser), ...extra].filter(Boolean) });
  }
  return rows;
}

function ReplyBody({ text, live }) {
  const body = String(text || "");
  const inner = <div className="message-text">{body}</div>;
  const long = body.length > 900 || body.split("\n").length > 14;
  if (!long) return inner;
  return <details className="reply-fold" open><summary>{live ? "Streaming reply" : "Reply"}</summary>{inner}</details>;
}

function InspectPreview({ inspect }) {
  if (!inspect) return null;
  const type = String(inspect.type || "");
  if (inspect.url && (inspect.kind === "image" || type.startsWith("image/") || type.includes("svg"))) return <img src={inspect.url} alt={inspect.name || ""}/>;
  if (inspect.url && (inspect.kind === "html" || type.includes("html"))) return <iframe title={inspect.name || "preview"} src={inspect.url} sandbox=""/>;
  return <pre className="inspect-text">{inspect.text || inspect.name || ""}</pre>;
}

function ShownDoc({ botId, rel, onOpen }) {
  const [doc, setDoc] = useState(null);
  useEffect(() => {
    let gone = false; const acc = { url: "" };
    if (!botId || !api.inspect || !rel) { setDoc(null); return; }
    setDoc(null);
    void api.inspect(botId, rel).then(next => {
      if (gone) { if (next?.url) URL.revokeObjectURL(next.url); return; }
      acc.url = next?.url || "";
      setDoc(next);
    }).catch(error => { if (!gone) setDoc({ kind: "text", text: String(error?.message || "Could not open"), name: String(rel).split("/").pop(), rel }); });
    return () => { gone = true; if (acc.url) URL.revokeObjectURL(acc.url); };
  }, [botId, rel]);
  if (!rel) return null;
  const open = () => onOpen?.(rel);
  return <figure className="shown-doc">
    <figcaption>
      <span>{doc?.name || String(rel).split("/").pop()}</span>
      <button type="button" onClick={open}>Open on computer</button>
    </figcaption>
    <div className="shown-doc-body" onClick={open}>{doc ? <InspectPreview inspect={doc}/> : <p className="muted">Loading…</p>}</div>
  </figure>;
}

function App() {
  const [onboarding, setOnboarding] = useState(null), [setupOpened, setSetupOpened] = useState(false);
  const [botAvatar, setBotAvatar] = useState("aviator");
  const [connection, setConnection] = useState(null), [state, setState] = useState(null), [error, setError] = useState("");
  const browserOrigin = api.canStartLocal === false;
  const houseLogin = browserOrigin && typeof location !== "undefined" && location.hostname === "openbot.zermo.org";
  const [mode, setMode] = useState(browserOrigin ? "remote" : "local"), [url, setUrl] = useState(browserOrigin ? location.origin : "http://127.0.0.1:4317"), [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false), [view, setView] = useState("chat"), [selected, setSelected] = useState("");
  const [chats, setChats] = useState({}), [message, setMessage] = useState(""), [botName, setBotName] = useState("");
  const [inspect, setInspect] = useState(null);
  const [computerFiles, setComputerFiles] = useState([]);
  const [computerOpen, setComputerOpen] = useState(false);
  const [computerHeld, setComputerHeld] = useState(false);
  const [pathFocus, setPathFocus] = useState(null);
  const [pathNodes, setPathNodes] = useState([]);
  const [railTab, setRailTab] = useState("computer");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState(null);
  const [actionLog, setActionLog] = useState([]);
  const pushLog = line => setActionLog(rows => [...rows.slice(-79), `${new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}  ${line}`]);
  const [autonomyActivity, setAutonomyActivity] = useState(null);
  const [soundEnabled, setSoundEnabled] = useState(() => readSoundEnabled());
  const [rainEnabled, setRainEnabled] = useState(() => readRainEnabled());
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const [transcriptView, setTranscriptView] = useState(() => readTranscriptView());
  const [runSettings, setRunSettings] = useState(null), [settingsError, setSettingsError] = useState(""), [savingRunSettings, setSavingRunSettings] = useState(false);
  const stateRef = useRef(null), runBot = useRef(null), selectedRef = useRef(""), processed = useRef(new Set()), transcript = useRef(null);
  const pendingLoads = useRef(new Map());
  const [historyBefore, setHistoryBefore] = useState({}), [loadingHistory, setLoadingHistory] = useState(false);
  const lastSequence = useRef(0);
  const prependedHistory = useRef(false);
  const recovering = useRef(false);
  const sound = useRef(null);
  const soundedReplies = useRef(new Set());
  function adopt(value) {
    const next = validateState(value);
    stateRef.current = next; setState(next);
    if (!selectedRef.current || !next.bots.some(bot => bot.id === selectedRef.current)) {
      const id = next.bots.find(bot => bot.id === next.prefs.lastBotId)?.id ?? next.bots[0]?.id ?? "";
      selectedRef.current = id; setSelected(id);
    }
    return next;
  }
  async function refresh() { return adopt(await api.request("state")); }
  async function loadMessages(botId, before) {
    if (!botId) return;
    const marker = {}; pendingLoads.current.set(botId, marker);
    const result = await api.request("messages", { id: botId, ...(before === undefined ? {} : { before }) });
    const messages = validateMessages(result.messages);
    if (pendingLoads.current.get(botId) === marker) {
      if (before !== undefined) prependedHistory.current = true;
      setHistoryBefore(previous => ({ ...previous, [botId]: result.before ?? null }));
      setChats(previous => {
        const local = previous[botId] || [];
        const extras = local.filter(item => !messages.some(older => older.id === item.id));
        return { ...previous, [botId]: before === undefined ? [...messages, ...extras] : [...messages, ...local.filter(item => !messages.some(older => older.id === item.id))] };
      });
    }
  }
  async function earlier() {
    setLoadingHistory(true);
    try { await loadMessages(selectedRef.current, historyBefore[selectedRef.current]); }
    catch (error) { setError(errorText(error)); } finally { setLoadingHistory(false); }
  }
  async function chooseBot(id, persist = true) {
    selectedRef.current = id; setSelected(id); setView("chat"); setError("");
    if (runBot.current !== id) await loadMessages(id);
    if (persist) adopt(await api.request("setPref", { key: "lastBotId", value: id }));
  }
  function updateMessage(id, update) {
    const botId = runBot.current;
    if (!botId) return;
    // A stale history fetch must not overwrite the streaming message.
    pendingLoads.current.delete(botId);
    setChats(previous => {
      const messages = [...(previous[botId] || [])], index = messages.findIndex(item => item.id === id);
      const next = update(index < 0 ? undefined : messages[index]);
      if (index < 0) messages.push(next); else messages[index] = next;
      return { ...previous, [botId]: messages };
    });
  }
  function transcriptEvent(event) {
    const botId = runBot.current;
    if (!botId) return;
    // Validate before React executes its updater so malformed events reach onEvent's error handler.
    updateTranscript([], event);
    pendingLoads.current.delete(botId);
    setChats(previous => ({ ...previous, [botId]: updateTranscript(previous[botId] || [], event) }));
  }
  async function frontend(event) {
    const value = event.value, key = `${value.runId}:${value.toolCallId ?? value.id}`;
    if (processed.current.has(key)) return;
    processed.current.add(key);
    if (event.name === "klaud.approval" || value.toolName === "confirmAction") { await api.confirm(value.id ?? value.toolCallId); return; }
    let result, isError = false;
    try {
      const args = value.args;
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid frontend tool arguments.");
      switch (value.toolName) {
        case "patchShell":
          applyShellPatch(stateRef.current.shell, args.patch);
          result = adopt(await api.request("patchShell", { patch: args.patch })).shell;
          break;
        case "setPref":
          if (args.key !== "lastBotId" || !stateRef.current.bots.some(bot => bot.id === args.value)) throw new Error("Choose an existing bot.");
          // serve persists the preference when this tool result is acknowledged.
          await chooseBot(args.value, false); result = { key: args.key, value: args.value };
          break;
        case "navigateTo":
          if (!["bots", "chat", "settings"].includes(args.dest)) throw new Error("Invalid navigation destination.");
          setView(args.dest); result = { dest: args.dest }; break;
        default: throw new Error("Unknown frontend tool.");
      }
    } catch (error) { isError = true; result = { error: errorText(error) }; }
    await api.toolResult({ runId: value.runId, toolCallId: value.toolCallId, result: JSON.stringify(result), isError });
  }
  async function onEvent(event, replay = false) {
    if (!replay && event.sequence <= lastSequence.current) return;
    if (!replay && Number.isInteger(event.sequence)) lastSequence.current = event.sequence;
    if (recovering.current && (event.type.startsWith("TEXT_MESSAGE_") || event.type.startsWith("TOOL_CALL_"))) return;
    try {
      switch (event.type) {
        case "STATE_SNAPSHOT":
          try { adopt(event.snapshot); } catch { await refresh(); }
          break;
        case "STATE_DELTA":
          try { adopt(applyDelta(stateRef.current, event.delta)); } catch { await refresh(); }
          break;
        case "TEXT_MESSAGE_START":
        case "TEXT_MESSAGE_END":
          transcriptEvent(event); break;
        case "TEXT_MESSAGE_CONTENT":
          transcriptEvent(event);
          if (!replay && event.delta?.trim() && !soundedReplies.current.has(event.messageId)) {
            soundedReplies.current.add(event.messageId); sound.current?.play("reply");
          }
          break;
        case "TOOL_CALL_START":
          transcriptEvent(event);
          if (!replay) { sound.current?.play("tool"); pushLog(`${event.toolCallName || event.toolName || "tool"} start`); }
          break;
        case "TOOL_CALL_ARGS":
          transcriptEvent(event); break;
        case "TOOL_CALL_RESULT":
          transcriptEvent(event);
          if (!replay) pushLog(`${event.toolCallName || event.toolName || "tool"} ${event.isError ? "failed" : "done"}`);
          break;
        case "CUSTOM":
          if (event.name === "klaud.progress") { const next = publicProgress(event.value); setProgress(next); if (next) pushLog(`${next.phase}${next.toolName ? " · " + next.toolName : ""} · turn ${next.turn}`); break; }
          if (["klaud.frontend_tool", "klaud.approval"].includes(event.name)) await frontend(event); break;
        case "RUN_ERROR": setError(String(event.message || "Run failed.")); break;
        case "RUN_SETTLED":
          runBot.current = null; setBusy(false); setProgress(null); processed.current.clear(); recovering.current = false; setNotice("");
          if (!replay) sound.current?.play("ready");
          await loadMessages(event.botId); break;
        case "CONNECTION_ERROR": setConnection(null); setError(String(event.message)); runBot.current = null; setBusy(false); setProgress(null); recovering.current = false; setNotice(""); break;
      }
    } catch (error) { setError(errorText(error)); }
  }
  useEffect(() => {
    const updateVisibility = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);
  useEffect(() => {
    const engine = createSoundEngine({ enabled: soundEnabled });
    sound.current = engine;
    const controlFor = target => target instanceof Element ? target.closest("button, input, select, textarea, summary, [data-sound-control]") : null;
    const usable = control => control && !control.matches(":disabled, [aria-disabled='true']");
    const hover = event => {
      const control = controlFor(event.target);
      if (!usable(control) || control.contains(event.relatedTarget) || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
      engine.play("hover");
    };
    const pointer = event => {
      const control = controlFor(event.target);
      if (usable(control)) void engine.playFromEvent("click", event);
    };
    const key = event => {
      const control = controlFor(event.target);
      if (!usable(control) || event.repeat || ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
      void engine.unlock(event).then(unlocked => {
        if (unlocked) engine.play(control.matches("input:not([type='radio']):not([type='checkbox']), textarea") ? "key" : "click");
      });
    };
    document.addEventListener("pointerover", hover);
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerover", hover);
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
      sound.current = null;
      void engine.destroy();
    };
  }, []);
  useEffect(() => {
    const inspect = api?.onboardingInspect;
    if (typeof inspect !== "function") {
      setOnboarding({ version: 1, completed: true, prepared: true, browser: true });
      return;
    }
    void inspect().then(setOnboarding).catch(error => setError(errorText(error)));
  }, []);
  const autoAttach = useRef(false);
  useEffect(() => {
    if (!browserOrigin || connection || autoAttach.current || !onboarding?.completed) return;
    autoAttach.current = true;
    setConnecting(true);
    void api.connect({}).then(status => {
      recovering.current = false; setNotice(""); setConnection(status.url); adopt(status.state);
      return loadMessages(selectedRef.current);
    }).catch(error => {
      const text = errorText(error);
      if (!(houseLogin && /Bearer token required/i.test(text))) setError(text);
    }).finally(() => setConnecting(false));
  }, [browserOrigin, connection, onboarding]);
  async function setupPrepared(status) {
    setConnection(status.url); adopt(status.state);
    setOnboarding(await api.onboardingInspect());
  }
  async function setupFinished(chosenBot, starter) {
    await refresh();
    await chooseBot(chosenBot.id);
    if (!onboarding?.completed) setOnboarding(await api.onboardingComplete());
    setSetupOpened(false);
    if (!onboarding?.completed) setMessage(starter || "");
    sound.current?.play("ready");
  }
  async function changeAvatar(value) {
    if (!selectedRef.current) return;
    setSaving(true); setError("");
    try { await api.request("setBotAvatar", { id: selectedRef.current, avatar: value }); await refresh(); }
    catch (error) { setError(errorText(error)); } finally { setSaving(false); }
  }
  useEffect(() => {
    let initializing = true;
    const queued = [];
    const unsubscribe = api.onEvent(event => { if (initializing) queued.push(event); else void onEvent(event); });
    void api.status().then(async status => {
      if (status.error) setError(status.error);
      if (!status.connected) return;
      adopt(status.state);
      if (status.run) {
        runBot.current = status.run.botId; setBusy(true);
        setChats(previous => ({ ...previous, [status.run.botId]: validateMessages(status.run.baseline) }));
        if (status.run.replayTruncated) {
          recovering.current = true;
          setNotice("I’m showing saved messages while this long run continues. I’ll refresh the transcript when it finishes.");
          await loadMessages(status.run.botId).catch(error => setError(errorText(error)));
        }
        if (selectedRef.current !== status.run.botId) await loadMessages(selectedRef.current);
        for (const event of status.run.events) await onEvent(event, true);
      } else await loadMessages(selectedRef.current);
      lastSequence.current = status.sequence;
      setConnection(status.url);
    }).catch(error => setError(errorText(error))).finally(async () => {
      // Events delivered while status was in flight are either in its replay or newer.
      for (let index = 0; index < queued.length; index++) await onEvent(queued[index]);
      initializing = false;
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!connection) { setRunSettings(null); return; }
    let active = true;
    setRunSettings(null); setSettingsError("");
    void api.request("getRunSettings").then(value => {
      const next = validateRunSettings(value);
      if (active) { setRunSettings(next); try { const prev = JSON.parse(localStorage.getItem("rein.klaud.approve") || "{}"); localStorage.setItem("rein.klaud.approve", JSON.stringify({ all: next.bashApproval === "always", remember: next.bashApproval === "whitelist", commands: Array.isArray(prev.commands) ? prev.commands : [] })); localStorage.setItem("klaud-bash-approval", next.bashApproval); } catch { /* private */ } }
    }).catch(error => { if (active) setSettingsError(`Run controls unavailable: ${errorText(error)} Update the connected Rein backend and reconnect to use these settings.`); });
    return () => { active = false; };
  }, [connection]);
  useEffect(() => {
    setAutonomyActivity(null);
    if (!connection) return;
    let active = true, pending = false, timer;
    const visible = () => document.visibilityState !== "hidden";
    async function pollActivity() {
      if (!active || pending || !visible()) return;
      pending = true;
      try {
        const value = validateActivity(await api.request("getActivity"));
        if (active && visible()) setAutonomyActivity(value.autonomy);
      } catch {
        // An older or unreachable backend is unknown, never a running daemon.
        if (active && visible()) setAutonomyActivity({ status: "unavailable" });
      } finally {
        pending = false;
        if (active && visible()) timer = setTimeout(pollActivity, 3000);
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      if (visible()) void pollActivity(); else setAutonomyActivity(null);
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    void pollActivity();
    return () => { active = false; clearTimeout(timer); document.removeEventListener("visibilitychange", visibilityChanged); };
  }, [connection]);
  useEffect(() => {
    if (!state) return;
    const root = document.documentElement, shell = state.shell;
    root.dataset.accent = shell.theme.accent;
    root.dataset.density = shell.theme.density;
    root.dataset.dark = String(shell.theme.dark);
    root.dataset.tray = shell.chrome.tray;
  }, [state]);
  useEffect(() => { if (error) sound.current?.play("error"); }, [error]);
  useEffect(() => {
    if (prependedHistory.current) { prependedHistory.current = false; return; }
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chats, selected, busy, progress]);
  async function connect(event) {
    event.preventDefault(); setConnecting(true); setError("");
    try {
      const status = await api.connect(browserOrigin || mode === "remote" ? { mode: "remote", url: browserOrigin ? location.origin : url, token } : { mode });
      recovering.current = false; setNotice("");
      setToken(""); setConnection(status.url); adopt(status.state);
      await loadMessages(selectedRef.current);
      sound.current?.play("ready");
    } catch (error) { setError(errorText(error)); }
    finally { setConnecting(false); }
  }
  async function createBot(event) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const created = await api.request("createBot", { name: botName }); setBotName(""); setAdding(false); if (created?.id && botAvatar) await api.request("setBotAvatar", { id: created.id, avatar: botAvatar }).catch(() => {}); await refresh(); await chooseBot(created.id);
    } catch (error) { setError(errorText(error)); } finally { setSaving(false); }
  }
  const pinnedQuote = useRef("");
  function captureThinking() {
    const quote = selectedThinking();
    if (quote) pinnedQuote.current = quote;
  }
  function selectedThinking() {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
    const node = selection.anchorNode;
    const box = node?.parentElement?.closest?.(".thinking-select, .path-focus-body") || node?.closest?.(".thinking-select, .path-focus-body");
    if (!box) return "";
    return selection.toString().trim().slice(0, 2000);
  }
  async function pinSelection(event) {
    event?.preventDefault?.();
    const quote = pinnedQuote.current || selectedThinking();
    if (!quote) { setError("Select the exact thinking string first."); return; }
    setError("");
    try {
      const pinned = await api.pinQuote({ quote });
      setNotice("Pinned to the live journal" + (pinned?.journal ? "" : ""));
    } catch (error) { setError(errorText(error)); }
  }
  async function submit(event) {
    event.preventDefault();
    const bot = stateRef.current.bots.find(item => item.id === selectedRef.current), text = message.trim();
    if (!bot || !text) return;
    soundedReplies.current.clear();
    void sound.current?.playFromEvent("send", event.nativeEvent);
    setError(""); setMessage(""); recovering.current = false; setNotice("");
    const id = crypto.randomUUID();
    updateMessage(id, () => ({ id, role: "user", content: text }));
    if (busy) {
      try {
        const flagged = await api.steer({ message: text, quote: pinnedQuote.current || selectedThinking() });
        if (flagged?.driftId) updateMessage(id, () => ({ id, role: "user", content: text + "\n\nDrift " + flagged.driftId }));
      }
      catch (error) { setError(errorText(error)); setMessage(text); }
      return;
    }
    setBusy(true); setProgress(null); runBot.current = bot.id;
    try { await api.run({ botId: bot.id, threadId: bot.sessionId, message: text }); }
    catch (error) { setError(errorText(error)); setBusy(false); runBot.current = null; setMessage(text); }
  }
  async function patch(path, value) {
    setSaving(true); setError("");
    try { adopt(await api.request("patchShell", { patch: [{ op: "replace", path, value }] })); }
    catch (error) { setError(errorText(error)); } finally { setSaving(false); }
  }
  async function toggleSound(event) {
    const engine = sound.current, next = !soundEnabled;
    if (!engine) return;
    engine.setEnabled(next);
    setSoundEnabled(next);
    if (next) await engine.playFromEvent("ready", event.nativeEvent);
  }
  function toggleRain(event) {
    const enabled = event.target.checked;
    setRainEnabled(enabled);
    try { localStorage.setItem(rainPreference, String(enabled)); } catch { /* Keep this window's choice if device storage is blocked. */ }
  }
  async function saveRunSetting(key, value) {
    setSavingRunSettings(true); setSettingsError("");
    try { const next = validateRunSettings(await api.request("saveRunSettings", { [key]: value })); setRunSettings(next); try { const prev = JSON.parse(localStorage.getItem("rein.klaud.approve") || "{}"); localStorage.setItem("rein.klaud.approve", JSON.stringify({ all: next.bashApproval === "always", remember: next.bashApproval === "whitelist", commands: Array.isArray(prev.commands) ? prev.commands : [] })); localStorage.setItem("klaud-bash-approval", next.bashApproval); } catch { /* private */ } }
    catch (error) { setSettingsError(errorText(error)); }
    finally { setSavingRunSettings(false); }
  }
  function chooseTranscriptView(value) { setTranscriptView(saveTranscriptView(value)); }
  const bot = state?.bots.find(item => item.id === selected);
  const visibleMessages = groupTurns(presentTranscript(chats[selected] || [], "full"));
  const stageFile = latestShownRel(chats[selected] || [], bot?.cwd);
  const workingHere = busy && runBot.current === selected;
  useEffect(() => { if (stageFile) { pushLog(`showing ${stageFile.split("/").pop()}`); } }, [stageFile]);
  function botPhase(id) {
    if (busy && runBot.current === id) return state?.approvals.length ? "approval" : progress?.phase || "working";
    if (stageFile && id === selected) return "presenting";
    return "ready";
  }
  const botList = <>
    <div className="section-heading">
      <p className="eyebrow">Agent roster / live</p>
      <h2>Field units</h2>
    </div>
    <div className="bot-list">
      {state?.bots.map((item, index) => <button className={selected === item.id ? "bot active" : "bot"} aria-pressed={selected === item.id} key={item.id} onClick={() => { void chooseBot(item.id).catch(error => setError(errorText(error))); }}>
        <BotAvatar botId={item.id} avatar={item.avatar} state={botPhase(item.id)} size={28} decorative paused={!pageVisible}/><span className="bot-number">{String(index + 1).padStart(2, "0")}</span>
        <span className="bot-name">{item.name}</span>
        {runBot.current === item.id && <span className="running-dot" aria-label="Running"/>}
      </button>)}
    </div>
    {!adding ? <button type="button" className="add-bot" aria-label="Add agent" onClick={() => setAdding(true)}>+</button> : <form className="new-bot" onSubmit={async event => { await createBot(event); setAdding(false); }}>
      <label htmlFor={view === "bots" ? "bot-name-page" : "bot-name-sidebar"}>New agent</label>
      <div className="input-row"><input id={view === "bots" ? "bot-name-page" : "bot-name-sidebar"} value={botName} onChange={event => setBotName(event.target.value)} placeholder="Agent name" maxLength={64} autoFocus/><button aria-busy={saving} disabled={saving || !botName.trim()} type="submit">Add</button><button type="button" onClick={() => setAdding(false)}>Cancel</button></div>
      <AvatarPicker value={botAvatar} onChange={setBotAvatar} disabled={saving}/>
    </form>}
    {view === "bots" && bot && <details className="bot-dressing"><summary>Dress {bot.name}</summary><AvatarPicker value={avatarForBot(bot.id, bot.avatar)} onChange={changeAvatar} disabled={saving || busy}/></details>}
  </>;
  async function openInspect(rel) {
    if (!bot || !api.inspect) return;
    try {
      setComputerOpen(true);
      setComputerHeld(true);
      const next = await api.inspect(bot.id, rel);
      setInspect(previous => { if (previous?.url) URL.revokeObjectURL(previous.url); return { ...next, rel }; });
      setError("");
    } catch (error) {
      const text = errorText(error);
      setInspect(previous => { if (previous?.url) URL.revokeObjectURL(previous.url); return { url: "", type: "text/plain", kind: "text", text: `${rel}\n${text}`, name: String(rel).split("/").pop(), rel }; });
    }
  }
  async function openComputer() {
    if (!bot || !api.inspectList) { setComputerFiles([]); return; }
    setComputerOpen(true);
    setComputerHeld(false);
    try {
      const list = await api.inspectList(bot.id);
      setComputerFiles(list.files || []);
    } catch { setComputerFiles([]); }
  }
  function closeInspect() {
    if (inspect?.url) URL.revokeObjectURL(inspect.url);
    setInspect(null);
    setComputerOpen(false);
    setComputerHeld(false);
  }
  function Inspectable({ text }) {
    return <div className="message-text">{text}</div>;
  }
  return <div className="app">
    {rainEnabled && <RainFrame paused={!pageVisible}/>}
    <header className="masthead">
      <div className="brand"><img src="./rein-logo.svg" alt="Rein"/><span className="brand-name">klaʊdbot</span><span className="edition">Field console / 01</span></div>
      {connection && onboarding?.completed && !setupOpened && <nav aria-label="Main">
        <button aria-current={view === "bots" ? "page" : undefined} onClick={() => setView("bots")}><span>01</span> Bots</button>
        <button aria-current={view === "chat" ? "page" : undefined} onClick={() => setView("chat")}><span>02</span> Chat</button>
        <button aria-current={computerOpen ? "page" : undefined} onClick={() => { setView("chat"); setRailTab("computer"); setComputerOpen(true); void openComputer(); }}><span>03</span> Computer</button>
        <button aria-current={view === "settings" ? "page" : undefined} onClick={() => setView("settings")}><span>04</span> Settings</button>
      </nav>}
      <div className="masthead-tools">
        <div className="masthead-signals"><span className="connection-label">{connection ? "Link / local" : "Awaiting link"}</span>{connection && autonomyActivity?.status === "running" && <ActivitySignal phase="autonomy" className="autonomy-indicator"/>}{connection && autonomyActivity?.status === "unavailable" && <span className="autonomy-unavailable">Autonomy / unavailable</span>}</div>
        <button className="sound-toggle" type="button" aria-pressed={soundEnabled} aria-label={`Sound effects ${soundEnabled ? "on" : "off"}`} onClick={toggleSound}>SFX <span>{soundEnabled ? "ON" : "OFF"}</span></button>
      </div>
    </header>
    {error && <div className="error" role="alert"><span><strong>Signal fault /</strong> {error}</span><button aria-label="Dismiss error" onClick={() => setError("")}>Dismiss</button></div>}
    {notice && <div className="notice" role="status"><strong>Field note /</strong> {notice}</div>}
    {onboarding && (!onboarding.completed || setupOpened) ? <SetupWizard api={api} inspection={onboarding} connection={connection} bots={state?.bots || []} selectedBotId={selected} onPrepared={setupPrepared} onFinish={setupFinished} onCancel={onboarding.completed ? () => setSetupOpened(false) : undefined}/> : !connection ? <main className="welcome">
      <section className="welcome-art" aria-labelledby="welcome-title">
        <div className="plate-label"><span>Rein field systems</span><span>Plate 01 / <span className="phonetic-name">klaʊdbot</span></span></div>
        <img src="./rein-field-guide-card.jpg" width="1280" height="640" alt="Rein field guide artwork showing a computer linked to a local server"/>
        <p className="plate-caption">A local-first command surface for durable agents.</p>
      </section>
      <section className="welcome-copy">
        <p className="eyebrow">Boot sequence / connection</p>
        <h1 id="welcome-title">Fresh context.<br/>Same journey.</h1>
        <p className="lede">{houseLogin ? "Sign in with the house Authelia account — tom or tom@zermo.org — same door as Rakazo." : browserOrigin ? "This LAN origin still uses a local serve token." : "Start your klaʊdbot space on this machine or attach this console to a Rein server already listening on loopback."}</p>
        {houseLogin ? <p className="connect-form"><a className="primary" href={`https://auth.zermo.org/?rd=${encodeURIComponent(location.origin + "/")}`}>Sign in</a><button type="button" className="primary" aria-busy={connecting} disabled={connecting} onClick={() => { autoAttach.current = false; setConnecting(true); void api.connect({}).then(status => { recovering.current = false; setNotice(""); setConnection(status.url); adopt(status.state); return loadMessages(selectedRef.current); }).catch(error => setError(errorText(error))).finally(() => setConnecting(false)); }}>{connecting ? "Linking…" : "Continue"}</button></p> : <form className="connect-form" onSubmit={connect}>
          {!browserOrigin && <fieldset><legend>Choose the link</legend>
            <label className="choice" data-sound-control><input type="radio" name="mode" value="local" checked={mode === "local"} onChange={() => setMode("local")}/><span><strong>Start local</strong><small>Launch <code>rein serve</code> here</small></span></label>
            <label className="choice" data-sound-control><input type="radio" name="mode" value="remote" checked={mode === "remote"} onChange={() => setMode("remote")}/><span><strong>Attach</strong><small>Use a loopback URL and token</small></span></label>
          </fieldset>}
          {!houseLogin && (browserOrigin || mode === "remote") && <div className="remote-fields">{!browserOrigin && <><label htmlFor="server-url">Server URL</label><input id="server-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} spellCheck={false}/></>}<label htmlFor="server-token">Bearer token</label><input id="server-token" type="password" required value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false}/></div>}
          <button className="primary" aria-busy={connecting} disabled={connecting} type="submit">{connecting ? "Linking…" : browserOrigin || mode === "remote" ? "Attach console" : <>Open <span className="phonetic-name">klaʊdbot</span></>}</button>
        </form>}
      </section>
    </main> : <div className="workspace">
      {state?.shell.chrome.sidebar && view !== "bots" && <aside>{botList}</aside>}
      <main className={`content ${view}`}>
        {view === "bots" ? <section className="page bots-page">{botList}</section> : view === "computer" ? <section className="page computer-page">
          <div className="page-heading"><p className="eyebrow">Field unit / disk</p><h1>Computer</h1><p className="lede">{bot?.cwd || "Select a bot to bind a workspace."}</p></div>
          {!bot ? <p className="muted">Choose Ares on Bots first.</p> : <>
            <ul className="computer-files">{computerFiles.length ? computerFiles.map(file => <li key={file.path}><button type="button" onClick={() => void openInspect(file.path)}>{file.path} <small>{file.kind}</small></button></li>) : <li className="muted">Empty workspace. Ares writes here.</li>}</ul>
            {inspect?.url && (inspect.kind === "html" || String(inspect.type||"").includes("html") ? <iframe title={inspect.name} src={inspect.url} sandbox=""/> : inspect.kind === "text" || String(inspect.type||"").startsWith("text") || String(inspect.type||"").includes("json") ? <pre className="inspect-text">{inspect.text || ""}</pre> : <img src={inspect.url} alt={inspect.name}/>)}
          </>}
        </section> : view === "settings" ? <section className="page settings">
          <div className="page-heading"><p className="eyebrow">Console controls / device</p><h1>Set the working rhythm.</h1><p className="lede">Run settings are saved by the connected Rein backend. Transcript views, rain and sound effects stay with this device.</p></div>
          {settingsError && <p className="run-settings-error" role="alert">{settingsError}</p>}
          <button className="setup-reopen" disabled={busy} onClick={() => setSetupOpened(true)}>Assisted setup · model, work style, and task limits</button>
          <div className="setting-list">
            <label data-sound-control><span><strong>Approvals</strong><small>Always skips every mutating tool. Auto skips Bash only. Whitelist auto-allows each tool the first time it appears. Ask restores the confirm dialog.</small></span><select value={runSettings?.bashApproval ?? ""} disabled={!runSettings || savingRunSettings || busy} onChange={event => saveRunSetting("bashApproval", event.target.value)}><option value="" disabled>{settingsError ? "Unavailable" : "Loading…"}</option><option value="always">Always approve</option><option value="auto">Auto approve Bash</option><option value="whitelist">Auto whitelist as created</option><option value="ask">Ask every time</option></select></label>
            <label data-sound-control><span><strong>Reasoning effort</strong><small>{runSettings?.reasoningControl?.description ?? "Requested effort for new runs. Provider support varies; this is not a measured reasoning score."}</small></span><select value={runSettings?.reasoningEffort ?? ""} disabled={!runSettings || savingRunSettings || busy} onChange={event => saveRunSetting("reasoningEffort", event.target.value)}><option value="" disabled>{settingsError ? "Unavailable" : "Loading…"}</option>{[["default", "Provider default"], ["off", "Off, if supported"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]].map(([value, label]) => <option key={value} value={value} disabled={runSettings?.reasoningControl && !runSettings.reasoningControl.supported.includes(value)}>{label}</option>)}</select></label>
            <label data-sound-control><span><strong>Accent signal</strong><small>Action and active-state color</small></span><select value={state.shell.theme.accent} disabled={saving} onChange={event => patch("/theme/accent", event.target.value)}><option value="rain">Rein rust</option><option value="slate">Field ink</option><option value="storm">Terminal green</option></select></label>
            <label data-sound-control><span><strong>Information density</strong><small>Space between working rows</small></span><select value={state.shell.theme.density} disabled={saving} onChange={event => patch("/theme/density", event.target.value)}><option value="compact">Compact</option><option value="regular">Regular</option><option value="roomy">Roomy</option></select></label>
            <label data-sound-control><span><strong>Tray presence</strong><small>How Rein waits in the system tray</small></span><select value={state.shell.chrome.tray} disabled={saving} onChange={event => patch("/chrome/tray", event.target.value)}><option value="normal">Normal</option><option value="quiet">Quiet</option><option value="hidden">Hidden</option></select></label>
            {[["Night console", "Charcoal field surface", "/theme/dark", state.shell.theme.dark], ["Show agent rail", "Keep field units at the left", "/chrome/sidebar", state.shell.chrome.sidebar], ["Show activity signal", "Display ready and working state", "/chrome/showActivity", state.shell.chrome.showActivity]].map(([label, help, path, checked]) => <label className="toggle" data-sound-control key={path}><span><strong>{label}</strong><small>{help}</small></span><input type="checkbox" checked={checked} disabled={saving} onChange={event => patch(path, event.target.checked)}/></label>)}
            <label className="toggle" data-sound-control><span><strong>Vintage console sounds</strong><small>Quiet, local relay and CRT cues</small></span><input type="checkbox" checked={soundEnabled} onChange={toggleSound}/></label>
            <label className="toggle" data-sound-control><span><strong>Rain effects</strong><small>Pixel rain in the console frame. Pauses when hidden; reduced motion keeps a static cloud and drops.</small></span><input type="checkbox" checked={rainEnabled} onChange={toggleRain}/></label>
          </div>
          <div className="service-note"><p>With the tray hidden, click the Dock icon or launch the app again to reopen this window. Quit from the app menu.</p><p>Connected to <code>{connection}</code></p></div>
        </section> : <div className="chat-pane">
          <div className="chat-heading"><div className="chat-identity">{bot && <BotAvatar botId={bot.id} avatar={bot.avatar} state={botPhase(bot.id)} size={28} decorative paused={!pageVisible}/>}<div><h1>{bot?.name || "Choose a field unit"}</h1></div></div><div className="chat-status"><span className="folio">{bot ? bot.id.slice(-4).toUpperCase() : "----"}</span>{stageFile && bot && <ShownDoc botId={bot.id} rel={stageFile} onOpen={rel => void openInspect(rel)}/>}{state?.shell.chrome.showActivity && <ActivitySignal phase={workingHere ? progress?.phase ?? "working" : stageFile ? "presenting" : "ready"} toolName={workingHere ? progress?.toolName : undefined} lines={actionLog}/>}</div></div>
          <div className="transcript-controls">
            {workingHere && progress && <span className="run-progress">Turn {progress.turn}</span>}
          </div>
          <div className="transcript" ref={transcript} aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
            {historyBefore[selected] != null && <button className="history-control" disabled={busy || loadingHistory} onClick={earlier}>{loadingHistory ? "Opening archive…" : "Open earlier ledger"}</button>}
            {!bot ? <div className="empty"><p className="eyebrow">No active unit</p><h2>Give your first agent a name.</h2><p className="muted">Rein keeps its conversation between visits.</p><button onClick={() => setView("bots")}>Open field units</button></div> : !(chats[selected]?.length) ? <div className="empty"><p className="eyebrow">Ledger clear</p><h2>What are we working on?</h2><p className="muted">Send an instruction to start this durable conversation.</p></div> : visibleMessages.map((item, index) => <article className={`message ${item.role}${item.isError ? " tool-error" : ""}`} key={item.id}>
              <div className="role">{item.role !== "user" && bot && <BotAvatar botId={bot.id} avatar={bot.avatar} state={item.role === "tool" ? (item.status === "running" ? "tool" : "ready") : (busy && index === visibleMessages.length - 1 ? botPhase(bot.id) : "ready")} size={24} decorative paused={!pageVisible}/>}<span>{item.role === "user" ? "Operator input" : item.role === "tool" ? "Tool / exec" : item.completion?.stopReason === "toolUse" ? `${bot?.name || "Bot"} / progress` : `${bot?.name || "Bot"} / reply`}</span><span>{String(index + 1).padStart(3, "0")}</span></div>
              {item.role === "tool" ? null : item.role === "assistant" ? <div>{item.path?.length ? <button type="button" className="path-open" onClick={() => { setPathNodes(item.path); setPathFocus(item.path[item.path.length - 1]); setRailTab("path"); }}>Path · {item.path.length}</button> : null}{item.thinking ? <pre className="thinking-select" onMouseUp={captureThinking}>{item.thinking}</pre> : null}<ReplyBody text={item.content} live={busy && index === visibleMessages.length - 1}/></div> : <Inspectable text={item.content}/>}
            </article>)}
          </div>
                    {state?.approvals.length > 0 && <div className="approvals">{state.approvals.map(item => <div key={item.id}><span><strong>Operator decision /</strong> {item.tool} needs review</span><button onClick={() => { void api.confirm(item.id).catch(error => setError(errorText(error))); }}>Review</button></div>)}</div>}
          <form className="composer" onSubmit={submit}>
            <div className="composer-label"><label htmlFor="message">Operator input</label><span>{bot ? `Routing to ${bot.name}` : "Select a field unit"}</span></div>
            <textarea id="message" value={message} onChange={event => setMessage(event.target.value)} placeholder={bot ? (busy ? `Interrupt ${bot.name} — this corrects the current reasoning` : `Give ${bot.name} an instruction…`) : "Choose a field unit to begin"} disabled={!bot} rows={3} maxLength={128 * 1024} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(event); } }}/>
            <div className="composer-actions"><span className="muted small">{busy ? "Enter / interrupt the current reasoning · Stop ends the run" : "Enter / transmit · Shift+Enter / new line"}</span>{busy ? <><button className="primary" type="submit" disabled={!message.trim()} onMouseDown={event => event.preventDefault()}>Interrupt</button><button type="button" onClick={() => { void api.cancel().catch(error => setError(errorText(error))); }}>Stop run</button></> : <button className="primary" type="submit" disabled={!bot || !message.trim()}>Transmit</button>}</div>
          </form>
        </div>}
      </main>
      <aside className="inspect-drawer computer-harness" aria-label="Context rail">
        <header>
          <div className="rail-tabs" role="tablist">
            <button type="button" aria-pressed={railTab === "path"} onClick={() => setRailTab("path")}>Path</button>
            <button type="button" aria-pressed={railTab === "computer"} onClick={() => { setRailTab("computer"); void openComputer(); }}>CRT</button>
          </div>
          <span className="harness-status">{railTab === "path" ? (pathFocus?.label || "node") : computerHeld ? "Operator hold" : busy ? "Agent driving" : "Parked"}</span>
          {railTab === "computer" && <button type="button" aria-pressed={computerHeld} onClick={() => setComputerHeld(h => !h)}>{computerHeld ? "Release" : "Take hold"}</button>}
        </header>
        {railTab === "path" ? <div className="path-focus">
          <div className="turn-graph" role="list">{(pathNodes.length ? pathNodes : []).map((node, index) => <span key={node.id || index} className="turn-step">
            {index > 0 && <i className="turn-edge" aria-hidden="true"/>}
            <button type="button" className={`turn-node ${node.kind}${pathFocus?.id === node.id ? " on" : ""}`} onClick={() => setPathFocus(node)}>{node.label}</button>
          </span>)}</div>
          <p className="path-focus-kicker">{pathFocus?.kind || "path"}</p>
          <h2>{pathFocus?.label || "Pick a reply Path"}</h2>
          <pre className="path-focus-body thinking-select" onMouseUp={captureThinking}>{pathFocus?.text || "Open Path on a reply. Nodes stay in this pane."}</pre><button type="button" className="pin-selection" onMouseDown={event => event.preventDefault()} onClick={pinSelection}>Pin selection</button>
        </div> : <div className="computer-monitor" data-held={computerHeld} data-driving={busy && !computerHeld}>
          <div className="computer-bezel"><span>klaʊd CRT</span><span>{bot?.cwd ? bot.cwd.split("/").slice(-2).join("/") : "cwd"}</span></div>
          <div className="computer-desktop" onClick={() => { if (computerHeld) setInspect(null); }}>
            {computerFiles.map(file => <button type="button" className={`desktop-icon${inspect?.rel === file.path ? " open" : ""}`} key={file.path} disabled={!computerHeld} onClick={event => { event.stopPropagation(); void openInspect(file.path); }}><i data-kind={file.kind}/><span>{file.path.split("/").pop()}</span></button>)}
            {!computerFiles.length && <p className="muted desktop-empty">Workspace empty</p>}
            {inspect && <div className="desktop-window" onClick={event => event.stopPropagation()}>
              <div className="desktop-window-bar"><span>{inspect.name || inspect.rel}</span><button type="button" disabled={!computerHeld} onClick={() => { if (inspect?.url) URL.revokeObjectURL(inspect.url); setInspect(null); }}>×</button></div>
              <div className="inspect-preview">{inspect.url && (inspect.kind === "image" || String(inspect.type||"").startsWith("image/") || String(inspect.type||"").includes("svg")) ? <img src={inspect.url} alt={inspect.name}/> : inspect.url && (inspect.kind === "html" || String(inspect.type||"").includes("html")) ? <iframe title={inspect.name} src={inspect.url} sandbox=""/> : <pre className="inspect-text">{inspect.text || inspect.name}</pre>}</div>
            </div>}
          </div>
          {!computerHeld && <div className="computer-glass"><p>{busy ? `${bot?.name || "Agent"} has the screen.` : "Take hold to drive this computer."}</p></div>}
        </div>}
      </aside>
    </div>}
  </div>;
}

createRoot(document.getElementById("root")).render(<App/>);
