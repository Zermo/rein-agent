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

function ActivitySignal({ phase = "ready", toolName, className = "" }) {
  const labels = { ready: "Ready", working: "Working", thinking: "Thinking", responding: "Typing", journaling: "Journaling", autonomy: "Autonomy work", tool: toolName ? `Running ${toolName}` : "Running tool" };
  const label = labels[phase] ?? labels.working;
  return <span className={`activity ${phase === "ready" ? "ready" : "working"} ${className}`} data-phase={phase} role="status" aria-live="polite" aria-atomic="true">
    <span className="activity-signal" aria-hidden="true"><i/><i/><i/></span><span className="activity-label" title={label}>{label}</span>
  </span>;
}

function App() {
  const [onboarding, setOnboarding] = useState(null), [setupOpened, setSetupOpened] = useState(false);
  const [botAvatar, setBotAvatar] = useState("aviator");
  const [connection, setConnection] = useState(null), [state, setState] = useState(null), [error, setError] = useState("");
  const [mode, setMode] = useState("local"), [url, setUrl] = useState("http://127.0.0.1:4317"), [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false), [view, setView] = useState("chat"), [selected, setSelected] = useState("");
  const [chats, setChats] = useState({}), [message, setMessage] = useState(""), [botName, setBotName] = useState("");
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState(null);
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
      setChats(previous => ({ ...previous, [botId]: before === undefined ? messages : [...messages, ...(previous[botId] || []).filter(item => !messages.some(older => older.id === item.id))] }));
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
          if (!replay) sound.current?.play("tool");
          break;
        case "TOOL_CALL_ARGS":
        case "TOOL_CALL_RESULT":
          transcriptEvent(event); break;
        case "CUSTOM":
          if (event.name === "klaud.progress") { setProgress(publicProgress(event.value)); break; }
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
    void api.onboardingInspect().then(setOnboarding).catch(error => setError(errorText(error)));
  }, []);
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
      if (active) setRunSettings(next);
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
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [chats, selected]);
  async function connect(event) {
    event.preventDefault(); setConnecting(true); setError("");
    try {
      const status = await api.connect(mode === "local" ? { mode } : { mode, url, token });
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
      const bot = await api.request("createBot", { name: botName, avatar: botAvatar }); setBotName(""); await refresh(); await chooseBot(bot.id);
    } catch (error) { setError(errorText(error)); } finally { setSaving(false); }
  }
  async function submit(event) {
    event.preventDefault();
    const bot = stateRef.current.bots.find(item => item.id === selectedRef.current), text = message.trim();
    if (!bot || !text || busy) return;
    soundedReplies.current.clear();
    void sound.current?.playFromEvent("send", event.nativeEvent);
    setError(""); setBusy(true); setProgress(null); setMessage(""); runBot.current = bot.id; recovering.current = false; setNotice("");
    const id = crypto.randomUUID();
    updateMessage(id, () => ({ id, role: "user", content: text }));
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
    try { setRunSettings(validateRunSettings(await api.request("saveRunSettings", { [key]: value }))); }
    catch (error) { setSettingsError(errorText(error)); }
    finally { setSavingRunSettings(false); }
  }
  function chooseTranscriptView(value) { setTranscriptView(saveTranscriptView(value)); }
  const bot = state?.bots.find(item => item.id === selected);
  const visibleMessages = presentTranscript(chats[selected] || [], transcriptView);
  const workingHere = busy && runBot.current === selected;
  function botPhase(id) {
    if (busy && runBot.current === id) return state?.approvals.length ? "approval" : progress?.phase || "working";
    return "ready";
  }
  const botList = <>
    <div className="section-heading">
      <p className="eyebrow">Agent roster / live</p>
      <h2>Field units</h2>
    </div>
    <div className="bot-list">
      {state?.bots.map((item, index) => <button className={selected === item.id ? "bot active" : "bot"} aria-pressed={selected === item.id} key={item.id} onClick={() => { void chooseBot(item.id).catch(error => setError(errorText(error))); }}>
        <BotAvatar botId={item.id} avatar={item.avatar} state={botPhase(item.id)} size={44} decorative paused={!pageVisible}/><span className="bot-number">{String(index + 1).padStart(2, "0")}</span>
        <span className="bot-name">{item.name}</span>
        {runBot.current === item.id && <span className="running-dot" aria-label="Running"/>}
      </button>)}
    </div>
    {!state?.bots.length && <p className="muted">Name a field unit to begin its durable conversation.</p>}
    <form className="new-bot" onSubmit={createBot}>
      <label htmlFor={view === "bots" ? "bot-name-page" : "bot-name-sidebar"}>Register new unit</label>
      <div className="input-row"><input id={view === "bots" ? "bot-name-page" : "bot-name-sidebar"} value={botName} onChange={event => setBotName(event.target.value)} placeholder="Agent name" maxLength={64}/><button aria-busy={saving} disabled={saving || !botName.trim()} type="submit">Add</button></div>
      <details className="bot-dressing"><summary>Choose their headwear</summary><AvatarPicker value={botAvatar} onChange={setBotAvatar} disabled={saving}/></details>
    </form>
    {bot && <details className="bot-dressing"><summary>Dress {bot.name}</summary><AvatarPicker value={avatarForBot(bot.id, bot.avatar)} onChange={changeAvatar} disabled={saving || busy}/></details>}
  </>;
  return <div className="app">
    {rainEnabled && <RainFrame paused={!pageVisible}/>}
    <header className="masthead">
      <div className="brand"><img src="./rein-logo.svg" alt="Rein"/><span className="brand-name">klaʊdbot</span><span className="edition">Field console / 01</span></div>
      {connection && onboarding?.completed && !setupOpened && <nav aria-label="Main">
        <button aria-current={view === "bots" ? "page" : undefined} onClick={() => setView("bots")}><span>01</span> Bots</button>
        <button aria-current={view === "chat" ? "page" : undefined} onClick={() => setView("chat")}><span>02</span> Chat</button>
        <button aria-current={view === "settings" ? "page" : undefined} onClick={() => setView("settings")}><span>03</span> Settings</button>
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
        <p className="lede">Start your klaʊdbot space on this machine or attach this console to a Rein server already listening on loopback.</p>
        <form className="connect-form" onSubmit={connect}>
          <fieldset><legend>Choose the link</legend>
            <label className="choice" data-sound-control><input type="radio" name="mode" value="local" checked={mode === "local"} onChange={() => setMode("local")}/><span><strong>Start local</strong><small>Launch <code>rein serve</code> here</small></span></label>
            <label className="choice" data-sound-control><input type="radio" name="mode" value="remote" checked={mode === "remote"} onChange={() => setMode("remote")}/><span><strong>Attach</strong><small>Use a loopback URL and token</small></span></label>
          </fieldset>
          {mode === "remote" && <div className="remote-fields"><label htmlFor="server-url">Server URL</label><input id="server-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} spellCheck={false}/><label htmlFor="server-token">Bearer token</label><input id="server-token" type="password" required value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false}/></div>}
          <button className="primary" aria-busy={connecting} disabled={connecting} type="submit">{connecting ? "Linking…" : mode === "local" ? <>Open <span className="phonetic-name">klaʊdbot</span></> : "Attach console"}</button>
        </form>
      </section>
    </main> : <div className="workspace">
      {state?.shell.chrome.sidebar && view !== "bots" && <aside>{botList}</aside>}
      <main className={`content ${view}`}>
        {view === "bots" ? <section className="page bots-page">{botList}</section> : view === "settings" ? <section className="page settings">
          <div className="page-heading"><p className="eyebrow">Console controls / device</p><h1>Set the working rhythm.</h1><p className="lede">Run settings are saved by the connected Rein backend. Transcript views, rain and sound effects stay with this device.</p></div>
          {settingsError && <p className="run-settings-error" role="alert">{settingsError}</p>}
          <button className="setup-reopen" disabled={busy} onClick={() => setSetupOpened(true)}>Assisted setup · model, work style, and task limits</button>
          <div className="setting-list">
            <label data-sound-control><span><strong>Bash approval</strong><small>Auto runs Bash within authorized tasks. Ask restores a review before each Bash call.</small></span><select value={runSettings?.bashApproval ?? ""} disabled={!runSettings || savingRunSettings || busy} onChange={event => saveRunSetting("bashApproval", event.target.value)}><option value="" disabled>{settingsError ? "Unavailable" : "Loading…"}</option><option value="auto">Auto</option><option value="ask">Ask every time</option></select></label>
            <label data-sound-control><span><strong>Reasoning effort</strong><small>{runSettings?.reasoningControl?.description ?? "Requested effort for new runs. Provider support varies; this is not a measured reasoning score."}</small></span><select value={runSettings?.reasoningEffort ?? ""} disabled={!runSettings || savingRunSettings || busy} onChange={event => saveRunSetting("reasoningEffort", event.target.value)}><option value="" disabled>{settingsError ? "Unavailable" : "Loading…"}</option>{[["default", "Provider default"], ["off", "Off, if supported"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]].map(([value, label]) => <option key={value} value={value} disabled={runSettings?.reasoningControl && !runSettings.reasoningControl.supported.includes(value)}>{label}</option>)}</select></label>
            <label data-sound-control><span><strong>Transcript view</strong><small>Replies keeps conversation and failures. Activity adds compact tools and public progress.</small></span><select value={transcriptView} onChange={event => chooseTranscriptView(event.target.value)}><option value="replies">Replies</option><option value="activity">Compact activity</option><option value="full">Full details</option></select></label>
            <label data-sound-control><span><strong>Accent signal</strong><small>Action and active-state color</small></span><select value={state.shell.theme.accent} disabled={saving} onChange={event => patch("/theme/accent", event.target.value)}><option value="rain">Rein rust</option><option value="slate">Field ink</option><option value="storm">Terminal green</option></select></label>
            <label data-sound-control><span><strong>Information density</strong><small>Space between working rows</small></span><select value={state.shell.theme.density} disabled={saving} onChange={event => patch("/theme/density", event.target.value)}><option value="compact">Compact</option><option value="regular">Regular</option><option value="roomy">Roomy</option></select></label>
            <label data-sound-control><span><strong>Tray presence</strong><small>How Rein waits in the system tray</small></span><select value={state.shell.chrome.tray} disabled={saving} onChange={event => patch("/chrome/tray", event.target.value)}><option value="normal">Normal</option><option value="quiet">Quiet</option><option value="hidden">Hidden</option></select></label>
            {[["Night console", "Charcoal field surface", "/theme/dark", state.shell.theme.dark], ["Show agent rail", "Keep field units at the left", "/chrome/sidebar", state.shell.chrome.sidebar], ["Show activity signal", "Display ready and working state", "/chrome/showActivity", state.shell.chrome.showActivity]].map(([label, help, path, checked]) => <label className="toggle" data-sound-control key={path}><span><strong>{label}</strong><small>{help}</small></span><input type="checkbox" checked={checked} disabled={saving} onChange={event => patch(path, event.target.checked)}/></label>)}
            <label className="toggle" data-sound-control><span><strong>Vintage console sounds</strong><small>Quiet, local relay and CRT cues</small></span><input type="checkbox" checked={soundEnabled} onChange={toggleSound}/></label>
            <label className="toggle" data-sound-control><span><strong>Rain effects</strong><small>Pixel rain in the console frame. Pauses when hidden; reduced motion keeps a static cloud and drops.</small></span><input type="checkbox" checked={rainEnabled} onChange={toggleRain}/></label>
          </div>
          <div className="service-note"><p>With the tray hidden, click the Dock icon or launch the app again to reopen this window. Quit from the app menu.</p><p>Connected to <code>{connection}</code></p></div>
        </section> : <>
          <div className="chat-heading"><div className="chat-identity">{bot && <BotAvatar botId={bot.id} avatar={bot.avatar} state={botPhase(bot.id)} size={64} decorative paused={!pageVisible}/>}<div><p className="eyebrow">Conversation ledger / current</p><h1>{bot?.name || "Choose a field unit"}</h1></div></div><div className="chat-status"><span className="folio">Thread / {bot ? bot.id.slice(-4).toUpperCase() : "----"}</span>{state?.shell.chrome.showActivity && <ActivitySignal phase={workingHere ? progress?.phase ?? "working" : "ready"} toolName={workingHere ? progress?.toolName : undefined}/>}</div></div>
          <div className="transcript-controls">
            <div className="view-switch" role="group" aria-label="Transcript view">{[["replies", "Replies"], ["activity", "Activity"], ["full", "Full"]].map(([value, label]) => <button key={value} aria-pressed={transcriptView === value} onClick={() => chooseTranscriptView(value)}>{label}</button>)}</div>
            <span className="transcript-context">{transcriptView === "replies" ? "Conversation + failures" : transcriptView === "full" ? "Full tool details · collapsible" : "Public activity · expand any tool"}</span>
            {workingHere && transcriptView !== "replies" && progress && <span className="run-progress">Turn {progress.turn}</span>}
          </div>
          <div className="transcript" ref={transcript} aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
            {historyBefore[selected] != null && <button className="history-control" disabled={busy || loadingHistory} onClick={earlier}>{loadingHistory ? "Opening archive…" : "Open earlier ledger"}</button>}
            {!bot ? <div className="empty"><p className="eyebrow">No active unit</p><h2>Give your first agent a name.</h2><p className="muted">Rein keeps its conversation between visits.</p><button onClick={() => setView("bots")}>Open field units</button></div> : !(chats[selected]?.length) ? <div className="empty"><p className="eyebrow">Ledger clear</p><h2>What are we working on?</h2><p className="muted">Send an instruction to start this durable conversation.</p></div> : visibleMessages.map((item, index) => <article className={`message ${item.role}${item.isError ? " tool-error" : ""}`} key={item.id}>
              <div className="role"><span>{item.role === "user" ? "Operator input" : item.role === "tool" ? "Tool / exec" : item.completion?.stopReason === "toolUse" ? `${bot?.name || "Bot"} / progress` : `${bot?.name || "Bot"} / reply`}</span><span>{String(index + 1).padStart(3, "0")}</span></div>
              {item.role === "tool" ? <div className="tool-record"><div className="tool-summary"><strong>{item.toolName}</strong><span>{item.isError ? "Failed" : item.status === "running" ? "Running" : item.status === "recorded" ? "Call recorded" : "Complete"}</span></div><details open={transcriptView === "full" || item.isError === true}><summary>Inspect arguments and result</summary>{item.arguments && <><span className="detail-label">Arguments</span><pre>{item.arguments}</pre></>}{item.content ? <><span className="detail-label">{item.isError ? "Error output" : "Result"}</span><pre>{item.content}</pre></> : <p className="muted">{item.status === "running" ? "Waiting for the tool result." : "No text result recorded."}</p>}{item.truncated && <p className="muted">Preview shortened. Full output remains in session history.</p>}</details></div> : <div><div className="message-text">{item.content}</div>{transcriptView !== "replies" && item.completion && <div className="completion-meta">{item.completion.stopReason && <span>Completion / {item.completion.stopReason}</span>}{item.completion.reasoningTokens && <span>Reported reasoning tokens / {item.completion.reasoningTokens.toLocaleString()}</span>}</div>}</div>}
            </article>)}
          </div>
          {state?.approvals.length > 0 && <div className="approvals">{state.approvals.map(item => <div key={item.id}><span><strong>Operator decision /</strong> {item.tool} needs review</span><button onClick={() => { void api.confirm(item.id).catch(error => setError(errorText(error))); }}>Review</button></div>)}</div>}
          <form className="composer" onSubmit={submit}>
            <div className="composer-label"><label htmlFor="message">Operator input</label><span>{bot ? `Routing to ${bot.name}` : "Select a field unit"}</span></div>
            <textarea id="message" value={message} onChange={event => setMessage(event.target.value)} placeholder={bot ? `Give ${bot.name} an instruction…` : "Choose a field unit to begin"} disabled={!bot} rows={3} maxLength={128 * 1024} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(event); } }}/>
            <div className="composer-actions"><span className="muted small">Enter / transmit · Shift+Enter / new line</span>{busy ? <button type="button" onClick={() => { void api.cancel().catch(error => setError(errorText(error))); }}>Stop run</button> : <button className="primary" type="submit" disabled={!bot || !message.trim()}>Transmit</button>}</div>
          </form>
        </>}
      </main>
    </div>}
  </div>;
}

createRoot(document.getElementById("root")).render(<App/>);
