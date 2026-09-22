"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, isPublicHost, KlaudApi, signIn, syncApprovalPolicy } from "../lib/api";
import { applyShellPatch, DEFAULT_SHELL, groupTurns, latestPresentation, mergeHistory, object, PHASES, updateTranscript, validateSnapshot } from "../lib/model";
import { createSoundEngine, readSoundEnabled } from "../lib/sounds";
import type { AgEvent, Bot, InspectDoc, InspectFile, Message, Patch, PathNode, PendingAction, Phase, RunSettings, Snapshot, View } from "../lib/types";
import { BotRoster, ChatPane, ContextRail, Masthead, RainPane, SettingsPanel, SetupWizard } from "./field-ui";
import { SplitPanes } from "./split-panes";
import type { SetupProfile } from "./field-ui";

const errorText = (error: unknown) => error instanceof Error ? error.message : "Console request failed.";
interface ActiveRun {
  botId: string;
  id?: string;
  controller: AbortController;
  cancelRequested: boolean;
  accept?: (accepted: boolean) => void;
}

export default function FieldConsole() {
  const [api] = useState(() => new KlaudApi());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const streamStateVersion = useRef(0);
  const [selected, setSelected] = useState("");
  const selectedRef = useRef("");
  const [view, setView] = useState<View>("chat");
  const [connection, setConnection] = useState<"connecting" | "connected" | "auth" | "offline">("connecting");
  const [house, setHouse] = useState<boolean | null>(null);
  const [origin, setOrigin] = useState("");
  const [bearer, setBearer] = useState("");
  const [fault, setFault] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [botError, setBotError] = useState("");
  const [settings, setSettings] = useState<RunSettings | null>(null);
  const [chats, setChats] = useState<Record<string, Message[]>>({});
  const [before, setBefore] = useState<Record<string, number | null>>({});
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("ready");
  const [toolName, setToolName] = useState("");
  const [autonomy, setAutonomy] = useState(false);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const active = useRef<ActiveRun | null>(null);
  const processed = useRef(new Set<string>());
  const [railTab, setRailTab] = useState<"path" | "crt">("path");
  const [railOpen, setRailOpen] = useState(() => {
    try { return localStorage.getItem("rein.klaud.rail-open") !== "false"; } catch { return true; }
  });
  const [nodes, setNodes] = useState<PathNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
  const [files, setFiles] = useState<InspectFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [doc, setDoc] = useState<InspectDoc | null>(null);
  const docRef = useRef<InspectDoc | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const inspectRequest = useRef<AbortController | null>(null);
  const filesVersion = useRef(0);
  const lastAutoOpen = useRef(new Map<string, string>());
  const [rainEnabled, setRainEnabled] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const sound = useRef<ReturnType<typeof createSoundEngine> | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [profile, setProfile] = useState<SetupProfile | null>(null);
  const mounted = useRef(false);
  const attachVersion = useRef(0);

  const log = useCallback((line: string) => setLines(rows => [...rows.slice(-79), `${new Date().toLocaleTimeString([], { hour12: false })}  ${line}`]), []);
  const adopt = useCallback((next: Snapshot) => {
    snapshotRef.current = next; setSnapshot(next);
    if (!next.bots.some(bot => bot.id === selectedRef.current)) {
      const id = next.bots.find(bot => bot.id === next.prefs.lastBotId)?.id ?? next.bots.find(bot => bot.name.toLowerCase() === "ares")?.id ?? next.bots[0]?.id ?? "";
      selectedRef.current = id; setSelected(id);
    }
  }, []);
  const loadMessages = useCallback(async (id: string, cursor?: number) => {
    if (!id) return;
    const page = await api.messages(id, cursor);
    if (!mounted.current) return;
    setBefore(previous => ({ ...previous, [id]: page.before ?? null }));
    setChats(previous => ({ ...previous, [id]: mergeHistory(previous[id] ?? [], page.messages, cursor !== undefined) }));
  }, [api]);

  const connect = useCallback(async () => {
    const version = ++attachVersion.current;
    setConnection("connecting"); setFault("");
    const [health, state, bots, runSettings, activity] = await Promise.allSettled([api.health(), api.state(), api.bots(), api.settings(), api.activity()]);
    if (!mounted.current || version !== attachVersion.current) return;
    if (state.status === "fulfilled") {
      // /state carries avatar sidecar data; /bots validates roster availability, not a replacement snapshot.
      adopt(state.value); setConnection("connected");
      if (bots.status === "rejected") setBotError(errorText(bots.reason));
      if (runSettings.status === "fulfilled") { setSettings(runSettings.value); syncApprovalPolicy(runSettings.value); setSettingsError(""); }
      else setSettingsError(errorText(runSettings.reason));
      setAutonomy(activity.status === "fulfilled" && activity.value.autonomy.status === "running");
      sound.current?.play("ready");
    } else if (state.reason instanceof ApiError && state.reason.authRequired) {
      setConnection("auth");
    } else {
      setConnection("offline"); setFault(errorText(state.reason));
    }
    if (health.status === "fulfilled" && (health.value.ok !== true || health.value.name !== "rein-klaud")) setFault("Unexpected backend identity. Expected rein-klaud.");
  }, [adopt, api]);

  useEffect(() => {
    mounted.current = true; setHouse(isPublicHost(location.hostname)); setOrigin(location.origin);
    const engine = createSoundEngine({ enabled: readSoundEnabled() }); sound.current = engine;
    setSoundEnabled(readSoundEnabled());
    try { setRainEnabled(localStorage.getItem("rein.klaud.rain-enabled") !== "false"); const saved: unknown = JSON.parse(localStorage.getItem("rein.klaud.setup-profile") ?? "null"); if (object(saved) && saved.version === 1) setProfile(saved as unknown as SetupProfile); } catch { /* Private mode. */ }
    const unlock = (event: PointerEvent | KeyboardEvent) => { void engine.unlock(event); };
    document.addEventListener("pointerdown", unlock); document.addEventListener("keydown", unlock);
    void api.onboardingInspect().then(() => { if (mounted.current) void connect(); });
    return () => {
      mounted.current = false; attachVersion.current++;
      document.removeEventListener("pointerdown", unlock); document.removeEventListener("keydown", unlock);
      void engine.destroy(); sound.current = null;
      active.current?.controller.abort(); inspectRequest.current?.abort();
      if (docRef.current?.url) URL.revokeObjectURL(docRef.current.url);
    };
  }, [api, connect]);

  useEffect(() => {
    const shell = snapshot?.shell ?? DEFAULT_SHELL;
    Object.assign(document.documentElement.dataset, { accent: shell.theme.accent, density: shell.theme.density, dark: String(shell.theme.dark), tray: shell.chrome.tray });
  }, [snapshot?.shell]);
  useEffect(() => {
    if (connection !== "connected") return;
    void loadMessages(selected).catch(error => setFault(errorText(error)));
  }, [selected, connection, loadMessages]);
  useEffect(() => {
    if (connection !== "connected") return;
    let inFlight = false;
    const poll = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try { const result = await api.activity(); if (mounted.current) setAutonomy(result.autonomy.status === "running"); }
      catch { /* Initial connection and run streams own fault reporting, not idle telemetry. */ }
      finally { inFlight = false; }
    };
    const timer = setInterval(() => { void poll(); }, 15_000);
    document.addEventListener("visibilitychange", poll);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [api, connection]);

  const replaceDoc = useCallback((next: InspectDoc | null) => {
    if (docRef.current?.url) URL.revokeObjectURL(docRef.current.url);
    docRef.current = next; setDoc(next);
  }, []);
  const refreshFiles = useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return;
    const version = ++filesVersion.current;
    setFilesLoading(true);
    try { const list = await api.inspectList(id); if (id === selectedRef.current && version === filesVersion.current) setFiles(list); }
    catch (error) { if (id === selectedRef.current && version === filesVersion.current && !docRef.current) replaceDoc({ path: "Workspace", name: "Workspace", kind: "text", url: "", error: errorText(error) }); }
    finally { if (id === selectedRef.current && version === filesVersion.current) setFilesLoading(false); }
  }, [api, replaceDoc]);
  useEffect(() => {
    inspectRequest.current?.abort(); replaceDoc(null); setFiles([]); setHeld(false); setNodes([]); setSelectedNode(null);
    if (selected && connection === "connected") void refreshFiles();
  }, [selected, connection, refreshFiles, replaceDoc]);
  const openInspect = useCallback(async (path: string) => {
    const id = selectedRef.current;
    if (!id) return;
    inspectRequest.current?.abort();
    const request = new AbortController(); inspectRequest.current = request;
    setRailTab("crt"); setInspectLoading(true);
    replaceDoc({ path, name: path.split("/").pop() ?? path, kind: "text", url: "", text: "Opening workspace file…" });
    try {
      const next = await api.inspect(id, path, request.signal);
      if (request.signal.aborted || selectedRef.current !== id) { if (next.url) URL.revokeObjectURL(next.url); return; }
      replaceDoc(next); log(`showing ${next.name}`);
    } catch (error) {
      if (!request.signal.aborted && selectedRef.current === id) replaceDoc({ path, name: path.split("/").pop() ?? path, kind: "text", url: "", error: errorText(error) });
    } finally { if (inspectRequest.current === request) setInspectLoading(false); }
  }, [api, log, replaceDoc]);
  const bot = snapshot?.bots.find(item => item.id === selected) ?? null;
  const messages = chats[selected] ?? [];
  const presentation = latestPresentation(messages, bot?.cwd);
  useEffect(() => {
    if (!busy) return;
    const last = groupTurns(messages).at(-1);
    if (!last?.nodes.length) return;
    setNodes(last.nodes);
    const live = last.nodes.findLast(node => node.kind === "tool") ?? last.nodes.at(-1);
    setSelectedNode(live?.id ?? null);
  }, [messages, busy]);
  useEffect(() => {
    if (!presentation || !selected || lastAutoOpen.current.get(selected) === presentation) return;
    lastAutoOpen.current.set(selected, presentation);
    setRailOpen(true);
    setRailTab("crt");
    try { localStorage.setItem("rein.klaud.rail-open", "true"); } catch { /* device-only */ }
    void openInspect(presentation);
  }, [presentation, selected, openInspect]);

  async function chooseBot(id: string, persist = true) {
    selectedRef.current = id; setSelected(id); setView("chat"); setFault("");
    if (persist) adopt(await api.pref(id));
  }
  async function saveSettings(patch: Partial<RunSettings>) {
    setSaving(true); setSettingsError("");
    try { const next = await api.saveSettings(patch); setSettings(next); syncApprovalPolicy(next); return next; }
    catch (error) { setSettingsError(errorText(error)); throw error; }
    finally { setSaving(false); }
  }
  async function patchShell(path: string, value: string | boolean) {
    setSaving(true); setSettingsError("");
    try { adopt(await api.patchShell([{ op: "replace", path, value }])); }
    catch (error) { setSettingsError(errorText(error)); }
    finally { setSaving(false); }
  }
  async function addBot(name: string, avatar: string) {
    setSaving(true); setBotError("");
    let created: Bot | undefined;
    try {
      created = await api.createBot(name);
      await api.avatar(created.id, avatar);
      adopt(await api.state()); await chooseBot(created.id);
    } catch (error) {
      setBotError(created ? `Unit created; headwear was not saved: ${errorText(error)}` : errorText(error));
      if (created) { adopt(await api.state()); await chooseBot(created.id); }
      else throw error;
    } finally { setSaving(false); }
  }
  async function changeAvatar(avatar: string) {
    if (!bot) return;
    setSaving(true); setBotError("");
    try { await api.avatar(bot.id, avatar); adopt(await api.state()); }
    catch (error) { setBotError(errorText(error)); }
    finally { setSaving(false); }
  }
  async function executeFrontend(event: AgEvent) {
    if (!object(event.value)) throw new Error("Invalid frontend action.");
    const value = event.value, runId = String(value.runId ?? ""), id = String(value.toolCallId ?? value.id ?? "");
    if (!runId || !id || runId !== active.current?.id) return;
    const sourceRun = active.current;
    const stillActive = () => active.current === sourceRun && !sourceRun.controller.signal.aborted;
    const stateVersion = streamStateVersion.current;
    const key = `${runId}:${id}`;
    if (processed.current.has(key)) return;
    processed.current.add(key);
    const args = object(value.args) ? value.args : {};
    const tool = String(value.toolName ?? value.tool ?? "Action");
    if (event.name === "klaud.approval" || tool === "confirmAction") {
      setPending(previous => [...previous, { id, runId, kind: event.name === "klaud.approval" ? "approval" : "tool", tool, summary: String(value.summary ?? args.action ?? "Confirm this action."), args }]);
      setPhase("approval"); log(`approval · ${tool}`); return;
    }
    let result: unknown, isError = false;
    try {
      if (tool === "patchShell") { applyShellPatch(snapshotRef.current?.shell ?? DEFAULT_SHELL, args.patch as Patch[]); result = await api.patchShell(args.patch as Patch[]); if (!stillActive()) return; if (stateVersion === streamStateVersion.current) adopt(result as Snapshot); }
      else if (tool === "setPref") { if (args.key !== "lastBotId" || typeof args.value !== "string") throw new Error("Invalid preference."); result = await api.pref(args.value); if (!stillActive()) return; if (stateVersion === streamStateVersion.current) adopt(result as Snapshot); await chooseBot(args.value, false); }
      else if (tool === "navigateTo") { if (!["bots", "chat", "settings"].includes(String(args.dest))) throw new Error("Invalid navigation destination."); setView(args.dest as View); result = { navigated: args.dest }; }
      else throw new Error("Unsupported frontend tool.");
    } catch (error) { result = { error: errorText(error) }; isError = true; }
    if (stillActive()) await api.toolResult(runId, id, JSON.stringify(result), isError);
  }
  function onEvent(event: AgEvent, run: ActiveRun) {
    if (active.current !== run) return;
    if (event.type === "RUN_STARTED") {
      run.id = String(event.runId); log("working · run started");
      run.accept?.(true); run.accept = undefined;
      if (run.cancelRequested) void api.cancel(run.id).catch(error => setFault(errorText(error)));
    } else if (event.type === "STATE_SNAPSHOT") {
      streamStateVersion.current++;
      const next = validateSnapshot(event.snapshot); adopt(next);
      const valid = new Set(next.approvals.map(item => item.id));
      setPending(previous => previous.filter(item => valid.has(item.id)));
    }
    else if (event.type === "STATE_DELTA") {
      if (!snapshotRef.current || !Array.isArray(event.delta)) return;
      event.delta.forEach((item: Patch) => {
        if (!item.path.startsWith("/shell/")) throw new Error("Invalid state delta.");
      });
      // Serve always follows a delta with an authoritative STATE_SNAPSHOT.
      // Do not replay RFC6902 test ops over a newer HTTP response snapshot:
      // the two independent connections can arrive in either order.
    } else if (event.type.startsWith("TEXT_MESSAGE_") || event.type.startsWith("TOOL_CALL_")) {
      updateTranscript([], event);
      setChats(previous => ({ ...previous, [run.botId]: updateTranscript(previous[run.botId] ?? [], event) }));
      if (event.type === "TEXT_MESSAGE_CONTENT") setPhase("responding");
      if (event.type === "TOOL_CALL_START") { const name = String(event.toolCallName ?? "tool"); setPhase("tool"); setToolName(name); log(`${name} start`); sound.current?.play("tool"); }
      if (event.type === "TOOL_CALL_RESULT") { log(`${String(event.toolName ?? "tool")} ${event.isError ? "failed" : "done"}`); setPending(previous => previous.filter(item => item.id !== event.toolCallId)); setPhase("working"); }
    } else if (event.type === "CUSTOM") {
      if (event.name === "klaud.progress" && object(event.value)) {
        const next = event.value.phase;
        if (PHASES.includes(next as Phase)) { setPhase(next as Phase); setToolName(String(event.value.toolName ?? "")); log(`${String(next)}${event.value.toolName ? ` · ${String(event.value.toolName)}` : ""}`); }
      } else if (["klaud.frontend_tool", "klaud.approval"].includes(String(event.name))) void executeFrontend(event).catch(error => setFault(errorText(error)));
    } else if (event.type === "RUN_ERROR") {
      if (!run.cancelRequested) { setFault(String(event.message ?? "Run failed.")); sound.current?.play("error"); }
      log(run.cancelRequested ? "run stopped" : "run failed");
    } else if (event.type === "RUN_FINISHED") { log("ready · run complete"); sound.current?.play("reply"); }
  }
  function submit(override?: string): Promise<boolean> {
    const source = override ?? draft;
    if (!bot || active.current || !source.trim()) return Promise.resolve(false);
    const message = source.trim();
    if (new TextEncoder().encode(message).byteLength > 128 * 1024) {
      setFault("Operator input exceeds 128 KiB.");
      return Promise.resolve(false);
    }

    let resolveAcceptance: (accepted: boolean) => void = () => {};
    let acceptanceSettled = false;
    const acceptance = new Promise<boolean>(resolve => { resolveAcceptance = resolve; });
    const settleAcceptance = (accepted: boolean) => {
      if (acceptanceSettled) return;
      acceptanceSettled = true;
      resolveAcceptance(accepted);
    };
    const run: ActiveRun = {
      botId: bot.id,
      controller: new AbortController(),
      cancelRequested: false,
      accept: settleAcceptance,
    };
    active.current = run; processed.current.clear();
    setBusy(true); setPhase("working"); setDraft(""); setFault(""); setPending([]); setRailTab("path"); sound.current?.play("send");
    const userId = `local-user-${crypto.randomUUID()}`;
    setChats(previous => ({ ...previous, [bot.id]: [...(previous[bot.id] ?? []), { id: userId, role: "user", content: message, local: true, pending: true }, { id: `local-reply-${crypto.randomUUID()}`, role: "assistant", content: "", local: true, pending: true }] }));
    void fetch("/api/jev", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: message }), cache: "no-store" })
      .then(async response => response.ok ? response.json() as Promise<{ pane?: string; confidence?: number }> : null)
      .then(hint => {
        if (!mounted.current || !hint || typeof hint.confidence !== "number" || hint.confidence < 0.55) return;
        if (hint.pane === "crt" || hint.pane === "path") setRailTab(hint.pane);
      })
      .catch(() => { /* Jev is advisory; the run continues. */ });

    void (async () => {
      try { await api.run(bot, message, run.controller.signal, event => onEvent(event, run)); }
      catch (error) {
        if (!run.id) {
          settleAcceptance(false);
          setDraft(previous => previous || message);
          setChats(previous => ({ ...previous, [run.botId]: (previous[run.botId] ?? []).map(item => item.id === userId ? { ...item, isError: true } : item) }));
        }
        if (!run.cancelRequested && !run.controller.signal.aborted) { setFault(errorText(error)); sound.current?.play("error"); }
      }
      finally {
        settleAcceptance(Boolean(run.id));
        run.accept = undefined;
        if (active.current === run) {
          active.current = null; setBusy(false); setPhase("ready"); setPending([]);
          setChats(previous => ({ ...previous, [run.botId]: (previous[run.botId] ?? []).filter(item => !(item.id.startsWith("local-reply-") && !item.content)).map(item => item.pending ? { ...item, pending: false } : item) }));
          await loadMessages(run.botId).catch(error => setFault(errorText(error)));
          if (run.botId === selectedRef.current) void refreshFiles();
        }
      }
    })();
    return acceptance;
  }
  async function stop() {
    const run = active.current;
    if (!run) return;
    run.cancelRequested = true;
    // Disconnect also cancels the harness if it has not sent RUN_STARTED yet.
    const acknowledgement = run.id ? api.cancel(run.id) : Promise.resolve();
    run.controller.abort();
    try { await acknowledgement; }
    catch (error) { if (!(error instanceof ApiError && error.status === 404)) setFault(errorText(error)); }
  }
  async function decision(id: string, choice: "deny" | "allow" | "whitelist" | "always") {
    const item = pending.find(entry => entry.id === id);
    if (!item || decisionBusy) return;
    const sourceRun = active.current;
    if (!sourceRun || sourceRun.id !== item.runId) return;
    const stillActive = () => active.current === sourceRun && !sourceRun.controller.signal.aborted;
    setDecisionBusy(true);
    try {
      if (choice === "always" || choice === "whitelist") {
        const next = await saveSettings({ bashApproval: choice === "always" ? "always" : "whitelist" });
        syncApprovalPolicy(next, `${item.tool}:${item.summary}`);
      }
      if (!stillActive()) return;
      if (item.kind === "approval") await api.approve(item.runId, item.id, choice !== "deny");
      else await api.toolResult(item.runId, item.id, JSON.stringify({ confirmed: choice !== "deny" }));
      if (stillActive()) { setPending(previous => previous.filter(entry => entry.id !== id)); setPhase("working"); log(`${item.tool} · ${choice}`); }
    } catch (error) { if (stillActive()) setFault(errorText(error)); }
    finally { setDecisionBusy(false); }
  }
  function changeSound(enabled: boolean) { sound.current?.setEnabled(enabled); setSoundEnabled(enabled); if (enabled) sound.current?.play("ready"); }
  function changeRain(enabled: boolean) { setRainEnabled(enabled); try { localStorage.setItem("rein.klaud.rain-enabled", String(enabled)); } catch { /* Device-only preference. */ } }
  function computer() {
    setView("chat");
    if (railOpen) changeRail(false);
    else { changeRail(true); setRailTab("crt"); void refreshFiles(); }
  }
  function changeRail(open: boolean) {
    setRailOpen(open);
    try { localStorage.setItem("rein.klaud.rail-open", String(open)); } catch { /* device-only */ }
  }
  const currentPhase: Phase = pending.length ? "approval" : busy ? phase : doc && !doc.error ? "presenting" : autonomy ? "autonomy" : "ready";
  const liveNodeId = busy ? (nodes.findLast(node => node.kind === "tool")?.id ?? nodes.at(-1)?.id ?? null) : null;
  const shell = snapshot?.shell ?? DEFAULT_SHELL;

  return <div className="app" data-rain={rainEnabled || undefined}>
    <RainPane enabled={rainEnabled}/>
    <Masthead view={view} onNavigate={setView} connected={connection === "connected"} connectionLabel={`Link / ${connection === "connected" ? "local" : connection}`} soundEnabled={soundEnabled} onToggleSound={() => changeSound(!soundEnabled)} rainEnabled={rainEnabled} phase={currentPhase} toolName={toolName} lines={lines} showActivity={shell.chrome.showActivity}/>
    {fault && <div className="signal-fault" role="alert"><strong>Signal fault</strong><span>{fault}</span><button onClick={() => setFault("")}>Dismiss</button></div>}
    {connection !== "connected" && <section className="connection-door" aria-label="Connect to klaʊdbot">
      <div><strong>{connection === "connecting" ? "Establishing link…" : "Connect to the field console"}</strong><p>House login · <b>tom@zermo.org</b> or <b>tom</b>. Existing Ares identity, workspace and memory stay with Rein.</p></div>
      <button onClick={signIn}>Sign in · auth.zermo.org</button>
      {house === false && <form onSubmit={event => { event.preventDefault(); try { api.setToken(bearer); setBearer(""); void connect(); } catch (error) { setFault(errorText(error)); } }}><label htmlFor="lan-bearer">LAN bearer · optional, memory only</label><input id="lan-bearer" type="password" autoComplete="off" spellCheck={false} value={bearer} onChange={event => setBearer(event.target.value)}/><button disabled={connection === "connecting"}>Connect</button></form>}
      <button disabled={connection === "connecting"} onClick={() => { void connect(); }}>Retry link</button>
    </section>}
    <SplitPanes showLeft={Boolean(shell.chrome.sidebar && view !== "bots")} railOpen={railOpen} onRailOpen={changeRail}
      left={<BotRoster bots={snapshot?.bots ?? []} selectedId={selected} onSelect={id => { void chooseBot(id).catch(error => setBotError(errorText(error))); }} onAdd={addBot} busy={busy} saving={saving} runningBotId={active.current?.botId} phase={currentPhase} error={botError}/>}
      center={<main className="content">
        {view === "bots" ? <BotRoster bots={snapshot?.bots ?? []} selectedId={selected} onSelect={id => { void chooseBot(id).catch(error => setBotError(errorText(error))); }} onAdd={addBot} onAvatar={avatar => { void changeAvatar(avatar); }} busy={busy} saving={saving} page runningBotId={active.current?.botId} phase={currentPhase} error={botError}/> : view === "settings" ? <SettingsPanel shell={shell} runSettings={settings} onShellPatch={(path, value) => { void patchShell(path, value); }} onRunSettings={patch => { void saveSettings(patch).catch(() => {}); }} rainEnabled={rainEnabled} onRain={changeRain} soundEnabled={soundEnabled} onSound={changeSound} onSetup={() => setSetupOpen(true)} saving={saving} error={settingsError} connectionLabel={connection === "connected" ? `Connected to ${origin}` : `Not connected · ${origin}`} reasoningDescription="Provider-dependent. This control persists the requested effort; the existing backend determines support."/> : <ChatPane bot={bot} messages={messages} phase={currentPhase} busy={busy && active.current?.botId === selected} draft={draft} onDraft={setDraft} onSubmit={submit} onStop={() => { void stop(); }} onPath={path => { setNodes(path); setSelectedNode(path.at(-1)?.id ?? null); setRailTab("path"); setRailOpen(true); }} pending={pending} onDecision={(id, choice) => { void decision(id, choice); }} decisionBusy={decisionBusy} disabled={connection !== "connected" || busy && active.current?.botId !== selected} hasEarlier={before[selected] != null} loadingEarlier={loadingEarlier} onEarlier={() => { setLoadingEarlier(true); void loadMessages(selected, before[selected] ?? undefined).catch(error => setFault(errorText(error))).finally(() => setLoadingEarlier(false)); }} onOpenBots={() => setView("bots")} toolName={toolName} lines={lines} railOpen={railOpen} onToggleComputer={computer}/>}
      </main>}
      right={<ContextRail tab={railTab} onTab={tab => { setRailTab(tab); if (tab === "crt") void refreshFiles(); }} nodes={nodes} selectedNodeId={selectedNode} onSelectNode={setSelectedNode} liveNodeId={liveNodeId} bot={bot} busy={busy && active.current?.botId === selected} held={held} onHold={setHeld} files={files} filesLoading={filesLoading} doc={doc} inspectLoading={inspectLoading} onInspect={path => { if (held) void openInspect(path); }} onCloseInspect={() => { inspectRequest.current?.abort(); setInspectLoading(false); replaceDoc(null); }} onRefresh={() => { void refreshFiles(); }}/>}
    />
    <SetupWizard open={setupOpen} onClose={() => setSetupOpen(false)} profile={profile} bots={snapshot?.bots ?? []} selectedBotId={selected} onFinish={async (next, starter, botId) => { try { localStorage.setItem("rein.klaud.setup-profile", JSON.stringify(next)); } catch { /* Still apply this window's draft. */ } setProfile(next); setDraft(starter); if (botId && botId !== selected) await chooseBot(botId); setSetupOpen(false); setView("chat"); }}/>
  </div>;
}