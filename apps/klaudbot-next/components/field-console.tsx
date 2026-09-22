"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ApiError, isPublicHost, KlaudApi, signIn, syncApprovalPolicy } from "../lib/api";
import { applyShellPatch, DEFAULT_SHELL, groupTurns, latestPresentation, mergeHistory, object, PHASES, updateTranscript, validateSnapshot } from "../lib/model";
import { createSoundEngine, readSoundEnabled } from "../lib/sounds";
import type { AgEvent, Bot, InspectDoc, InspectFile, InspectFrame, Message, Patch, PathNode, PendingAction, Phase, RunSettings, Snapshot, View } from "../lib/types";
import { BotRoster, ChatPane, ContextRail, InspectFloat, Masthead, RainPane, SettingsPanel, SetupWizard, AccountOnboard } from "./field-ui";
import { SplitPanes } from "./split-panes";
import type { SetupProfile, UnitLaw } from "./field-ui";
import { accentHex, loadUnit, saveUnit, type UnitProfile, type UnitRoutine } from "../lib/unit-profile";
import { loopPrompt, routineDue } from "../lib/unit-identity";
import { applyPhoneSection, phoneNeighbor, phoneSection } from "../lib/phone-nav";
import { accountIsReady, markAccountReady, markSetupSeen, SETUP_PROFILE_KEY, shouldAutoOpenSetup } from "../lib/setup-gate";

const errorText = (error: unknown) => error instanceof Error ? error.message : "Console request failed.";
// UI-only identifiers; never use this fallback for authorization or document nonces.
const localId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
interface ActiveRun { botId: string; id?: string; controller: AbortController; cancelRequested: boolean; accept?: (accepted: boolean) => void }

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
  const [drafts, setDrafts] = useState<Record<string, { text: string; webRevision: number }>>({});
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
    try {
      if (typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches) {
        return localStorage.getItem("rein.klaud.rail-open") === "true";
      }
      return localStorage.getItem("rein.klaud.rail-open") !== "false";
    } catch { return true; }
  });
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches);
  const swipe = useRef({ x: 0, y: 0, on: false });
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const sync = () => setPhone(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
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
  const crtOrigin = useRef<"auto" | "hold" | null>(null);
  const [frames, setFrames] = useState<InspectFrame[]>([]);
  const framesRef = useRef<InspectFrame[]>([]);
  const [rainEnabled, setRainEnabled] = useState(true);
  const [units, setUnits] = useState<Record<string, UnitProfile>>({});
  const [laws, setLaws] = useState<Record<string, UnitLaw>>({});
  const unitsRef = useRef<Record<string, UnitProfile>>({});
  const persistTimer = useRef(0);
  const runTurnRef = useRef<(target: Bot, message: string, kind: "operator" | "loop", routineId?: string) => Promise<void>>(async () => {});
  const [soundEnabled, setSoundEnabled] = useState(false);
  const sound = useRef<ReturnType<typeof createSoundEngine> | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [profile, setProfile] = useState<SetupProfile | null>(null);
  const [returning, setReturning] = useState(() => typeof window !== "undefined" && accountIsReady());
  const setupPrompted = useRef(false);
  const [onboardRequested, setOnboardRequested] = useState(false);
  const [onboardBusy, setOnboardBusy] = useState(false);
  const [onboardError, setOnboardError] = useState("");
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
    const already = snapshotRef.current != null;
    if (!already) setConnection("connecting");
    setFault("");
    const [health, state, bots, runSettings, activity] = await Promise.allSettled([api.health(), api.state(), api.bots(), api.settings(), api.activity()]);
    if (!mounted.current || version !== attachVersion.current) return;
    if (state.status === "fulfilled") {
      // /state carries avatar sidecar data; /bots validates roster availability, not a replacement snapshot.
      adopt(state.value); setConnection("connected");
      markAccountReady();
      setReturning(true);
      if (!setupPrompted.current) {
        setupPrompted.current = true;
        if (shouldAutoOpenSetup(state.value.bots.length)) setSetupOpen(true);
      }
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
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (mounted.current) void connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onVisible);
    return () => {
      mounted.current = false; attachVersion.current++;
      document.removeEventListener("pointerdown", unlock); document.removeEventListener("keydown", unlock);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onVisible);
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

  const replaceDoc = useCallback((next: InspectDoc | null, keepUrl = false) => {
    const previous = docRef.current;
    if (!keepUrl && previous?.url && previous.url !== next?.url && !framesRef.current.some(frame => frame.doc.url === previous.url)) {
      URL.revokeObjectURL(previous.url);
    }
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
  const openInspect = useCallback(async (path: string, origin: "auto" | "hold" = "hold") => {
    const id = selectedRef.current;
    if (!id) return;
    inspectRequest.current?.abort();
    const request = new AbortController(); inspectRequest.current = request;
    crtOrigin.current = origin;
    setRailTab("crt"); setInspectLoading(true);
    replaceDoc({ path, name: path.split("/").pop() ?? path, kind: "text", url: "", text: "Opening workspace file…" });
    try {
      const next = await api.inspect(id, path, request.signal);
      if (request.signal.aborted || selectedRef.current !== id) { if (next.url) URL.revokeObjectURL(next.url); return; }
      replaceDoc(next); log(`showing ${next.name}`);
      if (origin === "auto") sound.current?.play("present");
    } catch (error) {
      if (!request.signal.aborted && selectedRef.current === id) replaceDoc({ path, name: path.split("/").pop() ?? path, kind: "text", url: "", error: errorText(error) });
    } finally { if (inspectRequest.current === request) setInspectLoading(false); }
  }, [api, log, replaceDoc]);
  const bot = snapshot?.bots.find(item => item.id === selected) ?? null;
  const draftRecord = bot ? drafts[JSON.stringify([bot.id, bot.sessionId])] : null;
  const draft = draftRecord?.text ?? "";
  const webRevision = draftRecord?.webRevision ?? 0;
  const setDraft = useCallback((value: string | ((previous: string) => string), target: Bot | null = bot, webEdit = true) => {
    if (!target) return;
    const scope = JSON.stringify([target.id, target.sessionId]);
    setDrafts(previous => ({ ...previous, [scope]: {
      text: typeof value === "function" ? value(previous[scope]?.text ?? "") : value,
      webRevision: (previous[scope]?.webRevision ?? 0) + (webEdit ? 1 : 0),
    } }));
  }, [bot]);
  const unit = bot ? (units[bot.id] ?? loadUnit(bot.id)) : null;
  const messages = chats[selected] ?? [];
  const presentation = latestPresentation(messages, bot?.cwd);
  useEffect(() => {
    if (!busy) return;
    const last = groupTurns(messages).at(-1);
    if (!last?.nodes.length) return;
    setNodes(last.nodes);
    const live = last.nodes.findLast(node => node.kind === "tool")
      ?? last.nodes.find(node => node.kind === "think")
      ?? last.nodes.at(-1);
    setSelectedNode(live?.id ?? null);
  }, [messages, busy]);
  useEffect(() => {
    if (!presentation || !selected || lastAutoOpen.current.get(selected) === presentation) return;
    lastAutoOpen.current.set(selected, presentation);
    const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches;
    if (!narrow) {
      setRailOpen(true);
      setRailTab("crt");
      try { localStorage.setItem("rein.klaud.rail-open", "true"); } catch { /* device-only */ }
    }
    void openInspect(presentation, "auto");
  }, [presentation, selected, openInspect]);
  useEffect(() => { framesRef.current = frames; }, [frames]);
  useEffect(() => {
    if (held && doc) crtOrigin.current = "hold";
  }, [held, doc]);
  useEffect(() => {
    if (busy || !doc || crtOrigin.current !== "auto") return;
    const timer = window.setTimeout(() => { replaceDoc(null); crtOrigin.current = null; }, 900);
    return () => window.clearTimeout(timer);
  }, [busy, doc, replaceDoc]);
  const placeFrame = useCallback((next: InspectDoc, x: number, y: number) => {
    setFrames(previous => {
      const hit = previous.find(frame => frame.doc.path === next.path);
      if (hit) {
        if (hit.doc.url !== next.url && next.url) URL.revokeObjectURL(next.url);
        return previous.map(frame => frame.id === hit.id ? { ...frame, x, y } : frame);
      }
      return [...previous, { id: localId(), doc: next, x: Math.max(8, x), y: Math.max(48, y), pinned: false }];
    });
  }, []);
  const closeFrame = useCallback((id: string) => {
    setFrames(previous => {
      const gone = previous.find(frame => frame.id === id);
      if (gone?.doc.url && gone.doc.url !== docRef.current?.url && !previous.some(frame => frame.id !== id && frame.doc.url === gone.doc.url)) {
        URL.revokeObjectURL(gone.doc.url);
      }
      return previous.filter(frame => frame.id !== id);
    });
  }, []);
  const openChatFile = useCallback(async (path: string) => {
    const id = selectedRef.current;
    if (!id) return;
    const existing = framesRef.current.find(frame => frame.doc.path === path);
    if (existing && (existing.doc.url || existing.doc.text) && !existing.doc.error && existing.doc.text !== "Opening…") {
      setFrames(previous => previous.map(frame => frame.id === existing.id ? { ...frame, x: 88, y: 72 } : frame));
      return;
    }
    const stub: InspectDoc = { path, name: path.split("/").pop() ?? path, kind: "text", url: "", text: "Opening…" };
    placeFrame(stub, 88, 72);
    try {
      const next = await api.inspect(id, path);
      if (selectedRef.current !== id) { if (next.url) URL.revokeObjectURL(next.url); return; }
      setFrames(previous => previous.map(frame => frame.doc.path === path ? { ...frame, doc: next } : frame));
    } catch (error) {
      setFrames(previous => previous.map(frame => frame.doc.path === path ? { ...frame, doc: { ...stub, error: errorText(error) } } : frame));
    }
  }, [api, placeFrame]);

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
  function persistHarness(id: string) {
    window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      const profile = unitsRef.current[id];
      if (!profile) return;
      void fetch("/api/unit", {
        method: "PUT", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botId: id, soul: profile.soul, directive: profile.directive, routines: profile.routines, accent: profile.accent, theme: profile.theme }),
      }).catch(() => { /* next edit retries */ });
    }, 800);
  }
  function changeUnit(id: string, patch: Partial<UnitProfile>) {
    setUnits(current => {
      const base = current[id] ?? loadUnit(id);
      const routines = patch.routines?.map(row => {
        const prev = base.routines.find(item => item.id === row.id);
        if (!prev) return { ...row, lastFire: row.lastFire || Date.now() };
        if (prev.when !== row.when || prev.enabled !== row.enabled) return { ...row, lastFire: Date.now() };
        return row;
      });
      const next = saveUnit(id, { ...base, ...patch, ...(routines ? { routines } : {}) });
      unitsRef.current = { ...current, [id]: next };
      if ("soul" in patch || "directive" in patch || "routines" in patch || "accent" in patch || "theme" in patch) persistHarness(id);
      return unitsRef.current;
    });
  }
  const botKey = snapshot?.bots.map(item => item.id).join(",") ?? "";
  useEffect(() => {
    if (!botKey) return;
    const ids = botKey.split(",");
    let cancelled = false;
    void Promise.all(ids.map(async id => {
      const local = unitsRef.current[id] ?? loadUnit(id);
      try {
        const response = await fetch(`/api/unit?botId=${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return { id, profile: local, law: { skills: [] } };
        const remote = await response.json() as { soul?: string; directive?: string; routines?: UnitRoutine[]; skills?: string[]; accent?: UnitProfile["accent"]; theme?: UnitProfile["theme"] };
        const rows = (remote.routines?.length ? remote.routines : local.routines).map(row => ({ ...row, lastFire: row.lastFire || Date.now() }));
        return {
          id,
          profile: saveUnit(id, { ...local, soul: remote.soul || local.soul, directive: remote.directive || local.directive, routines: rows, accent: remote.accent || local.accent, theme: remote.theme || local.theme }),
          law: { skills: Array.isArray(remote.skills) ? remote.skills : [] },
        };
      } catch {
        return { id, profile: local, law: { skills: [] } };
      }
    })).then(rows => {
      if (cancelled) return;
      setUnits(current => {
        const next = { ...current };
        for (const row of rows) next[row.id] = row.profile;
        unitsRef.current = next;
        return next;
      });
      setLaws(current => {
        const next = { ...current };
        for (const row of rows) if (row.law) next[row.id] = row.law;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [botKey]);
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
      setPhase("approval"); log(`approval · ${tool}`); sound.current?.play("approval"); return;
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
    } else if (event.type.startsWith("THINKING_")) {
      setChats(previous => ({ ...previous, [run.botId]: updateTranscript(previous[run.botId] ?? [], event) }));
      setPhase("thinking");
      if (event.type === "THINKING_CONTENT" && typeof event.delta === "string") {
        const line = event.delta.split(/\n/).map(part => part.trim()).filter(Boolean).at(-1);
        if (line && line.length > 12) log(line.slice(0, 220));
      }
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
  async function runTurn(target: Bot, message: string, kind: "operator" | "loop", routineId?: string, accept?: (accepted: boolean) => void) {
    if (!target || active.current || !message.trim()) { accept?.(false); return; }
    if (new TextEncoder().encode(message).byteLength > 128 * 1024) { setFault("Operator input exceeds 128 KiB."); accept?.(false); return; }
    const run: ActiveRun = { botId: target.id, controller: new AbortController(), cancelRequested: false, accept };
    active.current = run; processed.current.clear();
    setBusy(true); setPhase(kind === "loop" ? "autonomy" : "working"); setFault(""); setPending([]); setRailTab("path");
    if (crtOrigin.current === "auto") { replaceDoc(null); crtOrigin.current = null; }
    if (kind === "loop") setAutonomy(true); else setDraft("", target, false);
    sound.current?.play("send");
    if (kind === "loop" && routineId) {
      changeUnit(target.id, { routines: (unitsRef.current[target.id]?.routines ?? []).map(row => row.id === routineId ? { ...row, lastFire: Date.now() } : row) });
      log(`loop · ${routineId}`);
    }
    const userId = `local-user-${localId()}`;
    setChats(previous => ({ ...previous, [target.id]: [...(previous[target.id] ?? []), { id: userId, role: "user", content: message, local: true, pending: true }, { id: `local-reply-${localId()}`, role: "assistant", content: "", local: true, pending: true }] }));
    if (kind === "operator") {
      void fetch("/api/jev", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: message }), cache: "no-store" })
        .then(async response => response.ok ? response.json() as Promise<{ pane?: string; confidence?: number }> : null)
        .then(hint => {
          if (!mounted.current || !hint || typeof hint.confidence !== "number" || hint.confidence < 0.55) return;
          if (hint.pane === "crt" || hint.pane === "path") setRailTab(hint.pane);
        })
        .catch(() => { /* Jev is advisory; the run continues. */ });
    }
    try { await api.run(target, message, run.controller.signal, event => onEvent(event, run)); }
    catch (error) {
      if (!run.id && kind === "operator") { setDraft(previous => previous || message, target, false); setChats(previous => ({ ...previous, [run.botId]: (previous[run.botId] ?? []).map(item => item.id === userId ? { ...item, isError: true } : item) })); }
      if (!run.cancelRequested && !run.controller.signal.aborted) { setFault(errorText(error)); sound.current?.play("error"); }
    }
    finally {
      run.accept?.(Boolean(run.id)); run.accept = undefined;
      if (active.current === run) {
        active.current = null; setBusy(false); setPhase("ready"); setPending([]); setAutonomy(false);
        setChats(previous => ({ ...previous, [run.botId]: (previous[run.botId] ?? []).filter(item => !(item.id.startsWith("local-reply-") && !item.content)).map(item => item.pending ? { ...item, pending: false } : item) }));
        await loadMessages(run.botId).catch(error => setFault(errorText(error)));
        if (run.botId === selectedRef.current) void refreshFiles();
      }
    }
  }
  runTurnRef.current = runTurn;
  function submit(override?: string): Promise<boolean> {
    const message = (override ?? draft).trim();
    if (!bot || connection !== "connected" || active.current || !message) return Promise.resolve(false);
    return new Promise(resolve => { void runTurn(bot, message, "operator", undefined, resolve); });
  }
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (active.current) return;
      const now = Date.now();
      for (const item of snapshotRef.current?.bots ?? []) {
        const due = (unitsRef.current[item.id]?.routines ?? []).find(row => routineDue(row, now));
        if (!due) continue;
        void runTurnRef.current(item, loopPrompt(due), "loop", due.id);
        return;
      }
    }, 20_000);
    return () => window.clearInterval(timer);
  }, []);
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
  function goPhone(section: ReturnType<typeof phoneSection>) {
    const next = applyPhoneSection(section);
    setView(next.view);
    changeRail(next.railOpen);
    if (next.railTab) { setRailTab(next.railTab); void refreshFiles(); }
  }
  function onPhonePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!phone) return;
    const target = event.target as HTMLElement;
    if (target.closest("textarea, input, button, a, select, .inspect-float, .inspect-preview, .desktop-window, .pane-resizer")) return;
    swipe.current = { x: event.clientX, y: event.clientY, on: true };
  }
  function onPhonePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!phone || !swipe.current.on) return;
    swipe.current.on = false;
    const dx = event.clientX - swipe.current.x;
    const dy = event.clientY - swipe.current.y;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.15) return;
    goPhone(phoneNeighbor(phoneSection(view, railOpen), dx < 0 ? 1 : -1));
  }
  const currentPhase: Phase = pending.length ? "approval" : busy ? phase : doc && !doc.error ? "presenting" : autonomy ? "autonomy" : "ready";
  const liveNodeId = busy ? (nodes.findLast(node => node.kind === "tool")?.id ?? nodes.at(-1)?.id ?? null) : null;
  const shell = snapshot?.shell ?? DEFAULT_SHELL;

  return <div className="app" data-rain={rainEnabled || undefined} data-phone={phone || undefined} onPointerDown={onPhonePointerDown} onPointerUp={onPhonePointerUp} onPointerCancel={() => { swipe.current.on = false; }}>
    <RainPane enabled={rainEnabled}/>
    <Masthead view={view} onNavigate={dest => { setView(dest); if (phone && dest !== "chat") changeRail(false); }} connected={connection === "connected"} connectionLabel={`Link / ${connection === "connected" ? "local" : connection}`} soundEnabled={soundEnabled} onToggleSound={() => changeSound(!soundEnabled)} rainEnabled={rainEnabled} phase={currentPhase} toolName={toolName} lines={lines} showActivity={shell.chrome.showActivity}/>
    {fault && <div className="signal-fault" role="alert"><strong>Signal fault</strong><span>{fault}</span><button onClick={() => setFault("")}>Dismiss</button></div>}
    {connection !== "connected" && !(returning && connection === "connecting") && <AccountOnboard
      connection={connection}
      returning={returning}
      onSignIn={signIn}
      onRetry={() => { void connect(); }}
      requested={onboardRequested}
      requesting={onboardBusy}
      error={onboardError || undefined}
      onRequest={async (email, name) => {
        setOnboardBusy(true); setOnboardError("");
        try {
          const response = await fetch("/api/onboard", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ email, name }) });
          if (!response.ok) throw new Error("Could not queue the ZERMO account.");
          setOnboardRequested(true);
        } catch (error) { setOnboardError(errorText(error)); throw error; }
        finally { setOnboardBusy(false); }
      }}
    />}
    <SplitPanes showLeft={Boolean(shell.chrome.sidebar && view !== "bots")} railOpen={railOpen}
      left={<BotRoster bots={snapshot?.bots ?? []} selectedId={selected} onSelect={id => { void chooseBot(id).catch(error => setBotError(errorText(error))); }} onAdd={addBot} profiles={units} onProfile={changeUnit} laws={laws} busy={busy} saving={saving} runningBotId={active.current?.botId} phase={currentPhase} error={botError}/>}
      center={<main className="content">
        {view === "bots" ? <BotRoster bots={snapshot?.bots ?? []} selectedId={selected} onSelect={id => { void chooseBot(id).catch(error => setBotError(errorText(error))); }} onAdd={addBot} onAvatar={avatar => { void changeAvatar(avatar); }} profiles={units} onProfile={changeUnit} laws={laws} busy={busy} saving={saving} page runningBotId={active.current?.botId} phase={currentPhase} error={botError}/> : view === "settings" ? <SettingsPanel shell={shell} runSettings={settings} onShellPatch={(path, value) => { void patchShell(path, value); }} onRunSettings={patch => { void saveSettings(patch).catch(() => {}); }} rainEnabled={rainEnabled} onRain={changeRain} soundEnabled={soundEnabled} onSound={changeSound} onSetup={() => setSetupOpen(true)} saving={saving} error={settingsError} connectionLabel={connection === "connected" ? `Connected to ${origin}` : `Not connected · ${origin}`} reasoningDescription="Provider-dependent. This control persists the requested effort; the existing backend determines support."/> : <ChatPane bot={bot} messages={messages} phase={currentPhase} busy={busy && active.current?.botId === selected} draft={draft} webRevision={webRevision} onDraft={(value, native) => setDraft(value, bot, !native)} onSubmit={submit} onStop={() => { void stop(); }} onPath={path => { setNodes(path); setSelectedNode(path.at(-1)?.id ?? null); setRailTab("path"); setRailOpen(true); }} pending={pending} onDecision={(id, choice) => { void decision(id, choice); }} decisionBusy={decisionBusy} disabled={connection !== "connected" || busy && active.current?.botId !== selected} hasEarlier={before[selected] != null} loadingEarlier={loadingEarlier} onEarlier={() => { setLoadingEarlier(true); void loadMessages(selected, before[selected] ?? undefined).catch(error => setFault(errorText(error))).finally(() => setLoadingEarlier(false)); }} onOpenBots={() => setView("bots")} toolName={toolName} lines={lines} railOpen={railOpen} onToggleComputer={computer} swapLabel={phone ? (railOpen ? "Chat" : "Computer") : undefined} phone={phone} onOpenFile={path => { void openChatFile(path); }} unitAccent={unit ? accentHex(unit.accent) : undefined} unitTheme={unit?.theme}/>}
      </main>}
      right={<ContextRail tab={railTab} onTab={tab => { setRailTab(tab); if (tab === "crt") void refreshFiles(); }} nodes={nodes} selectedNodeId={selectedNode} onSelectNode={setSelectedNode} liveNodeId={liveNodeId} bot={bot} busy={busy && active.current?.botId === selected} held={held} onHold={setHeld} files={files} filesLoading={filesLoading} doc={doc} inspectLoading={inspectLoading} onInspect={path => { if (held) void openInspect(path, "hold"); }} onCloseInspect={() => { inspectRequest.current?.abort(); setInspectLoading(false); replaceDoc(null); crtOrigin.current = null; }} onPopOut={(next, x, y) => { const app = document.querySelector(".app")?.getBoundingClientRect(); placeFrame(next, (app ? x - app.left : x), (app ? y - app.top : y)); replaceDoc(null, true); crtOrigin.current = null; }} onRefresh={() => { void refreshFiles(); }}/>}
    />
    {frames.length > 0 && <div className="inspect-stage" aria-label="Open files">{frames.map(frame => <InspectFloat key={frame.id} frame={frame} onMove={(id, x, y) => setFrames(previous => previous.map(item => item.id === id ? { ...item, x: Math.max(8, Math.min(x, window.innerWidth - 72)), y: Math.max(8, Math.min(y, window.innerHeight - 36)) } : item))} onClose={closeFrame} onPin={id => setFrames(previous => previous.map(item => item.id === id ? { ...item, pinned: !item.pinned } : item))}/>)}</div>}
    <SetupWizard open={setupOpen} onClose={() => { markSetupSeen(); setSetupOpen(false); }} profile={profile} bots={snapshot?.bots ?? []} selectedBotId={selected} onFinish={async (next, starter, botId) => { try { localStorage.setItem(SETUP_PROFILE_KEY, JSON.stringify(next)); } catch { /* Still apply this window's draft. */ } markSetupSeen(); setProfile(next); setDraft(starter, botId ? snapshot?.bots.find(item => item.id === botId) ?? null : bot); if (botId && botId !== selected) await chooseBot(botId); setSetupOpen(false); setView("chat"); }}/>
  </div>;
}