import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyDelta, applyShellPatch, validateMessages, validateState } from "./model.mjs";

const api = window.klaud;
const errorText = error => String(error?.message || "Something went wrong.").replace(/^Error invoking remote method '[^']+': Error: /, "");

function App() {
  const [connection, setConnection] = useState(null), [state, setState] = useState(null), [error, setError] = useState("");
  const [mode, setMode] = useState("local"), [url, setUrl] = useState("http://127.0.0.1:4317"), [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false), [view, setView] = useState("chat"), [selected, setSelected] = useState("");
  const [chats, setChats] = useState({}), [message, setMessage] = useState(""), [botName, setBotName] = useState("");
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const stateRef = useRef(null), runBot = useRef(null), selectedRef = useRef(""), processed = useRef(new Set()), transcript = useRef(null);
  const pendingLoads = useRef(new Map());
  const [historyBefore, setHistoryBefore] = useState({}), [loadingHistory, setLoadingHistory] = useState(false);
  const lastSequence = useRef(0);
  const prependedHistory = useRef(false);
  const recovering = useRef(false);
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
          updateMessage(event.messageId, existing => existing || { id: event.messageId, role: "assistant", content: "" }); break;
        case "TEXT_MESSAGE_CONTENT":
          if (typeof event.delta !== "string") throw new Error("Invalid transcript event.");
          updateMessage(event.messageId, existing => ({ id: event.messageId, role: "assistant", content: (existing?.content || "") + event.delta })); break;
        case "TOOL_CALL_START":
          updateMessage(`tool-${event.toolCallId}`, () => ({ id: `tool-${event.toolCallId}`, role: "tool", content: `Calling ${event.toolCallName}…` })); break;
        case "TOOL_CALL_RESULT":
          updateMessage(`tool-${event.toolCallId}`, () => ({ id: `tool-${event.toolCallId}`, role: "tool", content: String(event.content) })); break;
        case "CUSTOM":
          if (["klaud.frontend_tool", "klaud.approval"].includes(event.name)) await frontend(event); break;
        case "RUN_ERROR": setError(String(event.message || "Run failed.")); break;
        case "RUN_SETTLED":
          runBot.current = null; setBusy(false); processed.current.clear(); recovering.current = false; setNotice(""); await loadMessages(event.botId); break;
        case "CONNECTION_ERROR": setConnection(null); setError(String(event.message)); runBot.current = null; setBusy(false); recovering.current = false; setNotice(""); break;
      }
    } catch (error) { setError(errorText(error)); }
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
    if (!state) return;
    const root = document.documentElement, shell = state.shell;
    root.style.setProperty("--klaud-accent", { rain: "#7eb8db", slate: "#a7b7c4", storm: "#bdabef" }[shell.theme.accent]);
    root.style.setProperty("--klaud-density", { compact: "8px", regular: "14px", roomy: "22px" }[shell.theme.density]);
    root.style.setProperty("--klaud-tray", shell.chrome.tray);
    root.dataset.dark = String(shell.theme.dark);
    root.dataset.tray = shell.chrome.tray;
  }, [state]);
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
    } catch (error) { setError(errorText(error)); }
    finally { setConnecting(false); }
  }
  async function createBot(event) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const bot = await api.request("createBot", { name: botName }); setBotName(""); await refresh(); await chooseBot(bot.id);
    } catch (error) { setError(errorText(error)); } finally { setSaving(false); }
  }
  async function submit(event) {
    event.preventDefault();
    const bot = stateRef.current.bots.find(item => item.id === selectedRef.current), text = message.trim();
    if (!bot || !text || busy) return;
    setError(""); setBusy(true); setMessage(""); runBot.current = bot.id; recovering.current = false; setNotice("");
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
  const bot = state?.bots.find(item => item.id === selected);
  const botList = <>
    <h2>Bots</h2>
    <div className="bot-list">{state?.bots.map(item => <button className={selected === item.id ? "bot active" : "bot"} key={item.id} onClick={() => { void chooseBot(item.id).catch(error => setError(errorText(error))); }}><span>{item.name}</span>{runBot.current === item.id && <span className="running-dot" aria-label="Running"/>}</button>)}</div>
    {!state?.bots.length && <p className="muted">I’ll keep each bot’s conversation here.</p>}
    <form className="new-bot" onSubmit={createBot}><label htmlFor={view === "bots" ? "bot-name-page" : "bot-name-sidebar"}>New bot</label><div className="input-row"><input id={view === "bots" ? "bot-name-page" : "bot-name-sidebar"} value={botName} onChange={event => setBotName(event.target.value)} placeholder="Name" maxLength={64}/><button disabled={saving || !botName.trim()} type="submit">Add</button></div></form>
  </>;
  return <div className="app">
    <header><div className="brand"><img src="./icon.svg" alt=""/><span>rein-klaʊd</span></div>{connection && <nav aria-label="Main"><button aria-current={view === "bots" ? "page" : undefined} onClick={() => setView("bots")}>Bots</button><button aria-current={view === "chat" ? "page" : undefined} onClick={() => setView("chat")}>Chat</button><button aria-current={view === "settings" ? "page" : undefined} onClick={() => setView("settings")}>Settings</button></nav>}<span className="connection-label">{connection ? "Local connection" : "Connect"}</span></header>
    {error && <div className="error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}>Dismiss</button></div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {!connection ? <main className="welcome"><div><p className="eyebrow">Your agents, on your machine</p><h1>I’m ready when you are.</h1><p className="muted">Start Rein here, or connect to a server already listening on loopback.</p><form onSubmit={connect}>
      <fieldset><legend>Connection</legend><label className="choice"><input type="radio" name="mode" value="local" checked={mode === "local"} onChange={() => setMode("local")}/>Start local <code>rein serve</code></label><label className="choice"><input type="radio" name="mode" value="remote" checked={mode === "remote"} onChange={() => setMode("remote")}/>URL + token</label></fieldset>
      {mode === "remote" && <><label htmlFor="server-url">Server URL</label><input id="server-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} spellCheck={false}/><label htmlFor="server-token">Bearer token</label><input id="server-token" type="password" required value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false}/></>}
      <button className="primary" disabled={connecting} type="submit">{connecting ? "Connecting…" : mode === "local" ? "Start local serve" : "Connect"}</button>
    </form></div></main> : <div className="workspace">
      {state?.shell.chrome.sidebar && view !== "bots" && <aside>{botList}</aside>}
      <main className={`content ${view}`}>
        {view === "bots" ? <section className="page">{botList}</section> : view === "settings" ? <section className="page settings"><p className="eyebrow">Shared shell</p><h1>Make room for your work.</h1><p className="muted">I save these settings through Rein. Changes apply as soon as the server accepts them.</p>
          <label>Accent<select value={state.shell.theme.accent} disabled={saving} onChange={event => patch("/theme/accent", event.target.value)}><option value="rain">Rain</option><option value="slate">Slate</option><option value="storm">Storm</option></select></label>
          <label>Density<select value={state.shell.theme.density} disabled={saving} onChange={event => patch("/theme/density", event.target.value)}><option value="compact">Compact</option><option value="regular">Regular</option><option value="roomy">Roomy</option></select></label>
          <label>Tray<select value={state.shell.chrome.tray} disabled={saving} onChange={event => patch("/chrome/tray", event.target.value)}><option value="normal">Normal</option><option value="quiet">Quiet</option><option value="hidden">Hidden</option></select></label>
          {[["Dark appearance", "/theme/dark", state.shell.theme.dark], ["Show sidebar", "/chrome/sidebar", state.shell.chrome.sidebar], ["Show activity", "/chrome/showActivity", state.shell.chrome.showActivity]].map(([label, path, checked]) => <label className="toggle" key={path}><span>{label}</span><input type="checkbox" checked={checked} disabled={saving} onChange={event => patch(path, event.target.checked)}/></label>)}
          <p className="muted small">With the tray hidden, click the Dock icon or launch the app again to reopen this window. Quit from the app menu.</p><p className="muted small">Connected to <code>{connection}</code></p>
        </section> : <>
          <div className="chat-heading"><div><p className="eyebrow">Conversation</p><h1>{bot?.name || "Choose a bot"}</h1></div>{state?.shell.chrome.showActivity && <span className="activity">{busy ? "Working…" : "Ready"}</span>}</div>
          <div className="transcript" ref={transcript} aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
            {historyBefore[selected] != null && <button disabled={busy || loadingHistory} onClick={earlier}>{loadingHistory ? "Loading…" : "Load earlier messages"}</button>}
            {!bot ? <div className="empty"><h2>Give your first bot a name.</h2><p className="muted">I’ll keep its conversation between visits.</p><button onClick={() => setView("bots")}>Open bots</button></div> : !(chats[selected]?.length) ? <div className="empty"><h2>What are we working on?</h2><p className="muted">Send a message to start this conversation.</p></div> : chats[selected].map(item => <article className={`message ${item.role}`} key={item.id}><p className="role">{item.role === "user" ? "You" : item.role === "tool" ? "Tool" : bot.name}</p><div className="message-text">{item.content || "…"}</div>{item.toolCalls?.map(call => <details key={call.id}><summary>{call.function?.name || "Tool call"}</summary><pre>{call.function?.arguments}</pre></details>)}</article>)}
          </div>
          {state?.approvals.length > 0 && <div className="approvals">{state.approvals.map(item => <div key={item.id}><span>{item.tool} needs a decision</span><button onClick={() => { void api.confirm(item.id).catch(error => setError(errorText(error))); }}>Review</button></div>)}</div>}
          <form className="composer" onSubmit={submit}><label className="sr-only" htmlFor="message">Message</label><textarea id="message" value={message} onChange={event => setMessage(event.target.value)} placeholder={bot ? `Message ${bot.name}` : "Choose a bot to begin"} disabled={!bot} rows={3} maxLength={128 * 1024} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(event); } }}/><div><span className="muted small">Enter to send · Shift+Enter for a new line</span>{busy ? <button type="button" onClick={() => { void api.cancel().catch(error => setError(errorText(error))); }}>Stop</button> : <button className="primary" type="submit" disabled={!bot || !message.trim()}>Send</button>}</div></form>
        </>}
      </main>
    </div>}
  </div>;
}

createRoot(document.getElementById("root")).render(<App/>);
