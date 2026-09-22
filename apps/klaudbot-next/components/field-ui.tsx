"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type UIEvent as ReactUIEvent } from "react";
import type { Bot, Phase, Message, PathNode, Shell, RunSettings, InspectFile, InspectDoc, InspectFrame, PendingAction, RailTab } from "../lib/types";
import { AvatarPicker, BotAvatar } from "./avatars";
import { AvatarScene } from "./avatar-scene";
import { groupTurns, inspectableSpans } from "../lib/model";
import { avatarForBot } from "../lib/avatar-catalog";
import { NATIVE_COMPOSER_EVENT, NATIVE_COMPOSER_READY_EVENT, NATIVE_COMPOSER_MAX_UTF8, parseNativeComposerCommand, postNativeComposerMessage, supportsNativeComposer, type NativeComposerHost } from "../lib/native-composer";
import { saveInspectDoc, shareInspectDoc } from "../lib/device-export";
import { playKeyHaptic, playVintageKey, startDictate } from "../lib/key-feel";
import { accentHex, newRoutine, UNIT_ACCENTS, type UnitAccent, type UnitProfile, type UnitTheme } from "../lib/unit-profile";

export type ConsoleView = "bots" | "chat" | "settings";
export type ApprovalDecision = "deny" | "allow" | "whitelist" | "always";
export interface MastheadProps {
  view: ConsoleView; onNavigate: (view: ConsoleView) => void;
  connected: boolean; connectionLabel?: string;
  soundEnabled: boolean; onToggleSound: () => void; rainEnabled?: boolean;
  phase?: Phase; autonomyLabel?: string; lines?: string[]; toolName?: string; showActivity?: boolean;
}
export interface UnitLaw {
  skills: string[];
}
export interface BotRosterProps {
  bots: Bot[]; selectedId: string | null; onSelect: (id: string) => void;
  onAdd: (name: string, avatar: string) => void | Promise<void>; onAvatar?: (avatar: string) => void;
  profiles?: Record<string, UnitProfile>; onProfile?: (id: string, patch: Partial<UnitProfile>) => void;
  laws?: Record<string, UnitLaw>;
  busy?: boolean; saving?: boolean; page?: boolean; phase?: Phase;
  runningBotId?: string | null; error?: string;
}
export interface ChatPaneProps {
  bot: Bot | null; messages: Message[]; phase: Phase; busy: boolean;
  draft: string; webRevision: number; onDraft: (value: string, native?: boolean) => void; onSubmit: (message?: string) => Promise<boolean>; onStop: () => void;
  onPath: (nodes: PathNode[]) => void; pending?: PendingAction[];
  onDecision?: (id: string, decision: ApprovalDecision) => void; decisionBusy?: boolean;
  lines?: string[]; showActivity?: boolean; hasEarlier?: boolean; loadingEarlier?: boolean;
  onEarlier?: () => void; onOpenBots?: () => void; notice?: string; disabled?: boolean;
  toolName?: string;
  railOpen?: boolean;
  onToggleComputer?: () => void;
  swapLabel?: string;
  phone?: boolean;
  onOpenFile?: (path: string) => void;
  unitAccent?: string;
  unitTheme?: "field" | "night" | "paper";
}
export interface ContextRailProps {
  tab: RailTab; onTab: (tab: RailTab) => void;
  nodes: PathNode[]; selectedNodeId?: string | null; onSelectNode: (id: string) => void;
  liveNodeId?: string | null;
  bot: Bot | null; busy: boolean; held: boolean; onHold: (held: boolean) => void;
  files: InspectFile[]; filesLoading?: boolean; doc: InspectDoc | null; inspectLoading?: boolean;
  onInspect: (path: string) => void; onCloseInspect: () => void; onRefresh?: () => void;
  onPopOut?: (doc: InspectDoc, x: number, y: number) => void;
}
export interface SettingsPanelProps {
  shell: Shell; runSettings: RunSettings | null;
  onShellPatch: (path: string, value: string | boolean) => void;
  onRunSettings: (patch: Partial<RunSettings>) => void;
  rainEnabled: boolean; onRain: (enabled: boolean) => void;
  soundEnabled: boolean; onSound: (enabled: boolean) => void; onSetup: () => void;
  saving?: boolean; busy?: boolean; error?: string; reasoningDescription?: string;
  reasoningSupported?: string[]; connectionLabel?: string;
}
export interface SetupProfile {
  version: 1; model: "existing-dgx-spark"; workStyle: "steps" | "balanced" | "thorough";
  maxTurns: number; maxIterations: number; notes: string;
}
export interface SetupWizardProps {
  open: boolean; onClose: () => void;
  onFinish: (profile: SetupProfile, starter: string, botId?: string) => void | Promise<void>;
  profile?: SetupProfile | null; bots?: Bot[]; selectedBotId?: string | null;
  saving?: boolean; error?: string;
}

const phaseLabels: Record<Phase, string> = {
  ready: "Ready", working: "Working", thinking: "Thinking", responding: "Typing",
  presenting: "Showing", journaling: "Journaling", tool: "Running tool",
  autonomy: "Autonomy work", approval: "Needs approval", error: "Attention",
};
const describe = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);

function usePageVisible() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    update(); document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

interface NativeComposerOptions {
  bot: Bot | null;
  draft: string;
  webRevision: number;
  busy: boolean;
  disabled: boolean;
  onDraft: (value: string, native?: boolean) => void;
  onSubmit: (message?: string) => Promise<boolean>;
  onStop: () => void;
}

function useNativeComposer({ bot, draft, webRevision, busy, disabled, onDraft, onSubmit, onStop }: NativeComposerOptions) {
  const [activeBot, setActiveBot] = useState<Bot | null>(null);
  const nativeRevisions = useRef<Record<string, number>>({});
  const draftFits = new TextEncoder().encode(draft).byteLength <= NATIVE_COMPOSER_MAX_UTF8;
  const latestDraftFits = useRef(draftFits);
  latestDraftFits.current = draftFits;
  // Readiness belongs to this mounted document; commands/state remain bot/session scoped.
  const active = Boolean(activeBot);
  const host = useCallback(() => (window as Window & { klaudNative?: NativeComposerHost }).klaudNative, []);

  useEffect(() => {
    if (!draftFits) {
      setActiveBot(null);
      postNativeComposerMessage({ action: "state", visible: false });
      return;
    }
    let requestId = "";
    const ready = (event: Event) => {
      const command = event instanceof CustomEvent ? parseNativeComposerCommand(event.detail) : null;
      if (command?.action !== "ready" || command.requestId !== requestId ||
          command.botId !== bot?.id || command.sessionId !== bot?.sessionId || command.documentNonce !== host()?.documentNonce || !latestDraftFits.current) return;
      setActiveBot(bot);
    };
    const detect = () => {
      setActiveBot(null);
      if (!bot || !supportsNativeComposer(host()) || typeof crypto.randomUUID !== "function") return;
      requestId = crypto.randomUUID();
      postNativeComposerMessage({ action: "hello", requestId, botId: bot.id, sessionId: bot.sessionId });
    };
    window.addEventListener(NATIVE_COMPOSER_EVENT, ready);
    if (!activeBot) detect();
    window.addEventListener(NATIVE_COMPOSER_READY_EVENT, detect);
    return () => {
      window.removeEventListener(NATIVE_COMPOSER_EVENT, ready);
      window.removeEventListener(NATIVE_COMPOSER_READY_EVENT, detect);
    };
  }, [host, bot?.id, bot?.sessionId, activeBot, draftFits]);

  useEffect(() => () => {
    if (supportsNativeComposer(host())) postNativeComposerMessage({ action: "state", visible: false });
  }, [host]);

  useEffect(() => {
    if (!active) return;
    postNativeComposerMessage({
      action: "state",
      visible: Boolean(bot),
      botId: bot?.id ?? "",
      sessionId: bot?.sessionId ?? "",
      enabled: Boolean(bot) && !disabled && !busy,
      busy,
      draft,
      webRevision,
    });
  }, [active, bot, busy, disabled, draft, webRevision]);

  useEffect(() => {
    if (!active) return;
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const command = parseNativeComposerCommand(event.detail);
      if (!command || command.action === "ready" || command.documentNonce !== host()?.documentNonce) return;
      const sameScope = command.botId === bot?.id && command.sessionId === bot?.sessionId;
      if (!sameScope) {
        postNativeComposerMessage({
          action: command.action === "send" ? "sendAck" : "commandAck",
          requestId: "requestId" in command ? command.requestId : "",
          botId: command.botId,
          sessionId: command.sessionId,
          revision: "revision" in command ? command.revision : 0,
          accepted: false,
          reason: "scope-changed",
        });
        return;
      }
      const scope = JSON.stringify([command.documentNonce, command.botId, command.sessionId]);
      const previousRevision = nativeRevisions.current[scope] ?? -1;
      if (command.action === "draft") {
        const accepted = !disabled && !busy && command.revision >= previousRevision;
        if (accepted) {
          nativeRevisions.current[scope] = command.revision;
          onDraft(command.text, true);
        }
        postNativeComposerMessage({
          action: "draftAck",
          botId: command.botId,
          sessionId: command.sessionId,
          revision: command.revision,
          accepted,
        });
        return;
      }
      if (command.action === "stop") {
        if (busy) onStop();
        postNativeComposerMessage({
          action: "stopAck",
          requestId: command.requestId,
          botId: command.botId,
          sessionId: command.sessionId,
          accepted: busy,
        });
        return;
      }
      const allowed = !disabled && !busy && command.revision >= previousRevision;
      if (allowed) nativeRevisions.current[scope] = command.revision;
      void Promise.resolve().then(() => allowed ? onSubmit(command.text) : false).catch(() => false).then(accepted => {
        postNativeComposerMessage({
          action: "sendAck",
          requestId: command.requestId,
          botId: command.botId,
          sessionId: command.sessionId,
          revision: command.revision,
          accepted,
        });
      });
    };
    window.addEventListener(NATIVE_COMPOSER_EVENT, receive);
    return () => window.removeEventListener(NATIVE_COMPOSER_EVENT, receive);
  }, [active, bot, busy, disabled, host, onDraft, onStop, onSubmit]);

  return active;
}

export function RainPane({ enabled }: { enabled: boolean }) {
  const visible = usePageVisible();
  const wrap = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLCanvasElement>(null);
  const fogRef = useRef<HTMLCanvasElement>(null);
  const beadRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!enabled) return;
    const host = wrap.current, code = codeRef.current, fog = fogRef.current, beads = beadRef.current;
    if (!host || !code || !fog || !beads) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cctx = code.getContext("2d"), fctx = fog.getContext("2d"), bctx = beads.getContext("2d");
    if (!cctx || !fctx || !bctx) return;

    let dead = false, raf = 0, w = 0, h = 0, dpr = 1;
    const glyphs = ["r", "e", "i", "n", "0", "1"];
    type Drop = { x: number; y: number; px: number; py: number; vx: number; speed: number; r: number };
    type Cell = { x: number; y: number; speed: number; glyph: string };
    let drops: Drop[] = [];
    let cells: Cell[] = [];

    const fit = (node: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
      node.width = Math.max(1, Math.floor(w * dpr));
      node.height = Math.max(1, Math.floor(h * dpr));
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const size = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = host.clientWidth;
      h = host.clientHeight;
      fit(code, cctx); fit(fog, fctx); fit(beads, bctx);
      fctx.globalCompositeOperation = "source-over";
      fctx.fillStyle = "rgba(214, 198, 184, 0.07)";
      fctx.fillRect(0, 0, w, h);
      const cols = Math.max(10, Math.floor(w / 28));
      cells = Array.from({ length: cols }, (_, i) => ({
        x: (i + 0.5) * (w / cols) + (Math.random() * 10 - 5),
        y: Math.random() * h,
        speed: 0.35 + Math.random() * 0.55,
        glyph: glyphs[i % glyphs.length],
      }));
    };

    const spawn = () => {
      const x = 24 + Math.random() * Math.max(1, w - 48);
      drops.push({ x, y: -16, px: x, py: -16, vx: (Math.random() - 0.5) * 0.25, speed: 1.15 + Math.random() * 1.35, r: 3.2 + Math.random() * 3.8 });
    };

    const drawBead = (d: Drop) => {
      bctx.save();
      bctx.translate(d.x, d.y);
      const lean = Math.atan2(d.speed, d.vx) - Math.PI / 2;
      bctx.rotate(lean);
      bctx.fillStyle = "rgba(90, 18, 14, 0.45)";
      bctx.beginPath();
      bctx.ellipse(0, 0.6, d.r * 0.72, d.r * 1.25, 0, 0, Math.PI * 2);
      bctx.fill();
      bctx.fillStyle = "rgba(196, 48, 32, 0.7)";
      bctx.beginPath();
      bctx.ellipse(0, 0, d.r * 0.58, d.r * 1.05, 0, 0, Math.PI * 2);
      bctx.fill();
      bctx.fillStyle = "rgba(255, 236, 220, 0.85)";
      bctx.beginPath();
      bctx.ellipse(-d.r * 0.18, -d.r * 0.38, d.r * 0.2, d.r * 0.3, 0, 0, Math.PI * 2);
      bctx.fill();
      bctx.restore();
    };

    const tick = () => {
      if (dead) return;
      if (document.hidden || reduce) { raf = requestAnimationFrame(tick); return; }

      cctx.clearRect(0, 0, w, h);
      const glow = cctx.createRadialGradient(w * 0.16, h * 0.3, 8, w * 0.16, h * 0.3, Math.max(w, h) * 0.5);
      glow.addColorStop(0, "rgba(168, 28, 16, 0.16)");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      cctx.fillStyle = glow;
      cctx.fillRect(0, 0, w, h);
      cctx.font = "12px ui-monospace, Menlo, monospace";
      cctx.fillStyle = "rgba(196, 52, 36, 0.38)";
      for (const cell of cells) {
        cell.y += cell.speed;
        if (cell.y > h + 18) { cell.y = -18; cell.x += (Math.random() - 0.5) * 24; cell.glyph = glyphs[Math.floor(Math.random() * glyphs.length)]; }
        cctx.fillText(cell.glyph, cell.x, cell.y);
      }

      fctx.globalCompositeOperation = "source-over";
      fctx.fillStyle = "rgba(214, 198, 184, 0.008)";
      fctx.fillRect(0, 0, w, h);

      if (drops.length < 22 && Math.random() < 0.09) spawn();
      if (drops.length < 22 && Math.random() < 0.04) spawn();
      fctx.globalCompositeOperation = "destination-out";
      fctx.strokeStyle = "rgba(0,0,0,0.92)";
      fctx.lineCap = "round";
      fctx.lineJoin = "round";
      drops = drops.filter(drop => {
        drop.px = drop.x; drop.py = drop.y;
        drop.vx += (Math.random() - 0.5) * 0.08;
        drop.vx *= 0.92;
        drop.x += drop.vx;
        drop.y += drop.speed;
        fctx.lineWidth = Math.max(2.2, drop.r * 0.85);
        fctx.beginPath();
        fctx.moveTo(drop.px, drop.py);
        fctx.lineTo(drop.x, drop.y);
        fctx.stroke();
        return drop.y < h + 30 && drop.x > -20 && drop.x < w + 20;
      });

      bctx.clearRect(0, 0, w, h);
      for (const drop of drops) drawBead(drop);

      raf = requestAnimationFrame(tick);
    };

    size();
    for (let i = 0; i < 10; i++) spawn();
    const ro = new ResizeObserver(size);
    ro.observe(host);
    raf = requestAnimationFrame(tick);
    return () => { dead = true; cancelAnimationFrame(raf); ro.disconnect(); };
  }, [enabled, visible]);

  if (!enabled) return null;
  return <div className="rain-pane" ref={wrap} aria-hidden="true">
    <canvas ref={codeRef} className="rain-code"/>
    <canvas ref={fogRef} className="rain-fog"/>
    <canvas ref={beadRef} className="rain-beads"/>
  </div>;
}

function Modal({ open, onClose, titleId, children, className = "" }: {
  open: boolean; onClose: () => void; titleId: string; children: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} aria-labelledby={titleId} className={`field-dialog ${className}`}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) {
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    } }}>{children}</dialog>;
}

export function Masthead({ view, onNavigate, connected,
  connectionLabel, soundEnabled, onToggleSound, phase = "ready", autonomyLabel }: MastheadProps) {
  return <header className="masthead">
    <div className="brand"><img src="/rein-logo.svg" alt="Rein" width={28} height={28}/>
      <span className="brand-name">klaʊdbot</span><span className="edition">Field console / 01</span></div>
    <nav aria-label="Main">
      <button type="button" aria-current={view === "bots" ? "page" : undefined} onClick={() => onNavigate("bots")}><span>01</span> Bots</button>
      <button type="button" aria-current={view === "chat" ? "page" : undefined} onClick={() => onNavigate("chat")}><span>02</span> Chat</button>
      <button type="button" aria-current={view === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}><span>03</span> Settings</button>
    </nav>
    <div className="masthead-tools"><span className="connection-label" data-connected={connected} title={connectionLabel}>
      <i aria-hidden="true"/>{connected ? "Link / local" : "Awaiting link"}</span>
      {autonomyLabel && <span className="autonomy-label" data-phase={phase}>{autonomyLabel}</span>}
      <button className="sound-toggle" type="button" aria-pressed={soundEnabled} aria-label={`Sound effects ${soundEnabled ? "on" : "off"}`} onClick={onToggleSound}>SFX <span>{soundEnabled ? "ON" : "OFF"}</span></button>
    </div>
  </header>;
}

function UnitDossier({ bot, profile, law, saving, busy, onAvatar, onProfile }: {
  bot: Bot; profile: UnitProfile; law?: UnitLaw; saving: boolean; busy: boolean;
  onAvatar?: (avatar: string) => void; onProfile: (id: string, patch: Partial<UnitProfile>) => void;
}) {
  const locked = saving || busy;
  return <section className="unit-dossier" aria-label={`${bot.name} dossier`}>
    <p className="eyebrow">Established unit / {bot.id.slice(-4).toUpperCase()}</p>
    <h2>{bot.name}</h2>
    <p className="small muted">Soul and directive are the identity the harness loads on every run. Skills stay on the unit cwd.</p>
    {!!law?.skills?.length && <div className="skill-row" aria-label="Skills">{law.skills.map(name => <span className="skill-chip" key={name}>{name}</span>)}</div>}
    <label className="field-label">Persona color
      <span className="swatch-row">{(Object.keys(UNIT_ACCENTS) as UnitAccent[]).map(key => <button type="button" key={key} className="swatch" data-on={profile.accent === key} style={{ background: UNIT_ACCENTS[key] }} aria-label={key} disabled={locked} onClick={() => onProfile(bot.id, { accent: key })}/>)}</span>
    </label>
    <label className="field-label">Avatar theme
      <select value={profile.theme} disabled={locked} onChange={event => onProfile(bot.id, { theme: event.target.value as UnitTheme })}>
        <option value="field">Field rust</option>
        <option value="night">Night leather</option>
        <option value="paper">Paper cream</option>
      </select>
    </label>
    {onAvatar && <div className="dossier-headwear"><p className="field-label">Headwear</p><AvatarPicker value={avatarForBot(bot.id, bot.avatar)} onChange={onAvatar} disabled={locked} accent={accentHex(profile.accent)} theme={profile.theme}/></div>}
    <label className="field-label">Soul<textarea rows={12} value={profile.soul} maxLength={8000} disabled={locked} placeholder="Who this unit is. Voice, limits, what it protects." onChange={event => onProfile(bot.id, { soul: event.target.value })}/></label>
    <label className="field-label">Directive<textarea rows={6} value={profile.directive} maxLength={2000} disabled={locked} placeholder="Standing order for this unit." onChange={event => onProfile(bot.id, { directive: event.target.value })}/></label>
    <div className="routine-block">
      <div className="section-heading"><h3>Routines / loops</h3><button type="button" disabled={locked || profile.routines.length >= 12} onClick={() => onProfile(bot.id, { routines: [...profile.routines, newRoutine()] })}>+ Loop</button></div>
      {!profile.routines.length && <p className="small muted">No loops yet. Add a scan, journal, idle or watch pass.</p>}
      {profile.routines.map((row, index) => <div className="routine-row" key={row.id}>
        <input aria-label="Loop title" value={row.title} maxLength={80} disabled={locked} onChange={event => onProfile(bot.id, { routines: profile.routines.map((item, i) => i === index ? { ...item, title: event.target.value } : item) })}/>
        <input aria-label="When" placeholder="03:30 daily or every 30m" value={row.when} maxLength={80} disabled={locked} onChange={event => onProfile(bot.id, { routines: profile.routines.map((item, i) => i === index ? { ...item, when: event.target.value } : item) })}/>
        <select aria-label="Loop kind" value={row.loop} disabled={locked} onChange={event => onProfile(bot.id, { routines: profile.routines.map((item, i) => i === index ? { ...item, loop: event.target.value as UnitProfile["routines"][number]["loop"] } : item) })}>
          <option value="scan">Scan</option><option value="journal">Journal</option><option value="idle">Idle</option><option value="watch">Watch</option>
        </select>
        <label className="routine-on"><input type="checkbox" checked={row.enabled} disabled={locked} onChange={event => onProfile(bot.id, { routines: profile.routines.map((item, i) => i === index ? { ...item, enabled: event.target.checked } : item) })}/> On</label>
        <button type="button" aria-label="Remove loop" disabled={locked} onClick={() => onProfile(bot.id, { routines: profile.routines.filter((_, i) => i !== index) })}>×</button>
      </div>)}
    </div>
  </section>;
}

export function BotRoster({ bots, selectedId, onSelect, onAdd, onAvatar, profiles = {}, onProfile, laws = {}, busy = false,
  saving = false, page = false, phase = "ready", runningBotId, error }: BotRosterProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("aviator");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");
  const titleId = useId();
  const selected = bots.find(bot => bot.id === selectedId);
  const working = saving || submitting;
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!name.trim() || working) return;
    setSubmitting(true); setLocalError("");
    try { await onAdd(name.trim(), avatar); setName(""); setAdding(false); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : "Could not add this field unit. Try again."); }
    finally { setSubmitting(false); }
  }
  return <aside className={`bot-roster${page ? " roster-page" : ""}`} aria-label="Field units">
    <div className="section-heading"><h2>Field units <span>{String(bots.length).padStart(2, "0")}</span></h2>
      <button type="button" className="add-unit" onClick={() => { setLocalError(""); setAdding(true); }} disabled={saving} aria-label="Add bot">+ Add</button></div>
    <div className="bot-list">{bots.map((bot, index) => <button className={`bot${bot.id === selectedId ? " active" : ""}`}
      type="button" key={bot.id} onClick={() => onSelect(bot.id)} aria-pressed={bot.id === selectedId} title={`${bot.name} · ${bot.engine}`}>
      <span className="bot-number">{String(index + 1).padStart(2, "0")}</span>
      <BotAvatar botId={bot.id} avatar={bot.avatar} state="ready" size={page ? 88 : 56} decorative paused accent={accentHex(profiles[bot.id]?.accent)} theme={profiles[bot.id]?.theme}/>
      <span className="bot-name">{bot.name}<small>{bot.id === runningBotId ? phaseLabels[phase] : "Local / ready"}</small></span>
      {bot.id === runningBotId && <span className="running-dot" aria-label={phaseLabels[phase]}/>}
    </button>)}</div>
    {!bots.length && <p className="roster-empty">No field units yet.<br/>Give your first bot a name.</p>}
    {error && !adding && <p className="inline-error" role="alert">{error}</p>}
    {page && selected && onProfile && <UnitDossier bot={selected} profile={profiles[selected.id] ?? { version: 1, accent: "rain", theme: "field", soul: "", directive: "", routines: [] }} law={laws[selected.id]} saving={saving} busy={busy} onAvatar={onAvatar} onProfile={onProfile}/>}
    <div className="roster-foot"><span>Rein field systems</span><span>Plate 01 / klaʊdbot</span></div>
    <Modal open={adding} onClose={() => { if (!working) setAdding(false); }} titleId={titleId} className="add-bot-dialog">
      <form onSubmit={event => void add(event)}>
        <div className="dialog-heading"><div><p className="eyebrow">Field register / new unit</p><h2 id={titleId}>A name. A familiar face.</h2></div><button type="button" aria-label="Close add bot" onClick={() => setAdding(false)} disabled={working}>×</button></div>
        <label className="field-label">Agent name<input autoFocus required value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Scout" maxLength={64} disabled={working}/></label>
        <p className="small muted">This bot uses the existing local computer and model connection.</p>
        <AvatarPicker value={avatar} onChange={setAvatar} disabled={working}/>
        {(localError || error) && <p className="inline-error" role="alert">{localError || error}</p>}
        <div className="dialog-actions"><button type="button" onClick={() => setAdding(false)} disabled={working}>Cancel</button><button className="primary" type="submit" disabled={working || !name.trim()} aria-busy={working}>{working ? "Adding…" : "Add field unit"}</button></div>
      </form>
    </Modal>
  </aside>;
}

function toolChip(name: string): string {
  const raw = name.replace(/\s*·\s*failed$/i, "").trim().toLowerCase();
  const last = raw.split(/[./:]/).pop() ?? raw;
  if (last === "bash" || last === "shell") return "bash";
  if (last === "write" || last === "edit") return "write";
  if (last === "read") return "read";
  if (last.includes("search") || last.includes("fetch") || last === "web_search" || last === "web_fetch") return "query";
  if (last.includes("patch")) return "patch";
  return last.replace(/^klaud_/, "").replace(/_/g, "-").slice(0, 24) || "tool";
}

function PathNodeButton({ node, index, selected, live, onSelect }: { node: PathNode; index: number; selected: boolean; live: boolean; onSelect: (id: string) => void }) {
  const chip = node.kind === "tool" ? toolChip(node.label) : node.kind === "think" ? "think" : node.kind;
  return <button type="button" className={`turn-node ${node.kind}${selected ? " on" : ""}${live ? " live" : ""}`} aria-pressed={selected} onClick={() => onSelect(node.id)}>
    <span className="node-index">{String(index + 1).padStart(2, "0")} / {chip}</span>{node.kind !== "tool" ? <strong>{node.label}</strong> : null}
  </button>;
}

type LedgerRow = Message & { path: PathNode[] };
function ledgerRows(messages: Message[]): LedgerRow[] {
  return groupTurns(messages).flatMap(turn => {
    const users = turn.messages.filter(message => message.role === "user");
    const spoken = turn.messages.filter(message => message.role === "assistant" && message.content.trim());
    const reply = spoken.at(-1);
    return [...users, ...(reply ? [reply] : [])].map(message => ({
      ...message,
      path: message.role === "assistant" ? turn.nodes : [],
    }));
  });
}

function ReplyBody({ text, live, cwd, onOpenFile }: { text: string; live: boolean; cwd?: string; onOpenFile?: (path: string) => void }) {
  const shown = text
    .replace(/^\s*\[(?:reply|result|output|response|answer)\]\s*/i, "")
    .replace(/\n\s*\[(?:reply|result|output|response|answer)\]\s*/gi, "\n")
    .replace(/^\s+/, "");
  if (!shown && !live) return null;
  const spans = onOpenFile ? inspectableSpans(shown, cwd) : [];
  const bits: ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, index) => {
    if (span.start > cursor) bits.push(shown.slice(cursor, span.start));
    bits.push(<button type="button" className="ledger-file" key={`${span.path}-${index}`} title={`Open ${span.path}`} onClick={event => { event.preventDefault(); event.stopPropagation(); onOpenFile?.(span.path); }}>{span.path.split("/").pop()}</button>);
    cursor = span.end;
  });
  if (cursor < shown.length) bits.push(shown.slice(cursor));
  const body = <div className="message-text">{bits.length ? bits : shown}{live && <i className="crt-caret" data-who="agent" aria-hidden="true"/>}</div>;
  const folded = shown.length > 900 || shown.split("\n").length > 14;
  return folded
    ? <details className="reply-fold" open><summary className="sr-only">{live ? "Streaming" : "More"}</summary>{body}</details>
    : body;
}

function FieldKeyboard({ disabled, draft, onDraft, onType, onSend, onHide }: {
  disabled?: boolean; draft: string; onDraft: (value: string) => void; onType: (key: string) => void; onSend: () => void; onHide?: () => void;
}) {
  const [shift, setShift] = useState(false);
  const [alt, setAlt] = useState(false);
  const [listen, setListen] = useState(false);
  const [micNote, setMicNote] = useState("");
  const [hold, setHold] = useState<string[] | null>(null);
  const prefix = useRef(draft);
  const stopRef = useRef<(() => void) | null>(null);
  const repeat = useRef(0);
  const letterRows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
  const numberRow = "1234567890";
  const symbolRows = ["-/:;()$&@\"", ".,?!'" ];
  useEffect(() => () => { stopRef.current?.(); window.clearTimeout(repeat.current); window.clearInterval(repeat.current); }, []);
  function feel(event: ReactPointerEvent<HTMLButtonElement>, kind: "letter" | "space" | "delete" | "return" | "send" = "letter") {
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* desktop */ }
    event.currentTarget.classList.add("is-down");
    playVintageKey(kind, event);
    playKeyHaptic(kind);
  }
  function lift(event: ReactPointerEvent<HTMLButtonElement>) {
    event.currentTarget.classList.remove("is-down");
    window.clearTimeout(repeat.current);
    window.clearInterval(repeat.current);
  }
  function press(raw: string) {
    if (disabled) return;
    onType(shift && /^[a-z]$/.test(raw) ? raw.toUpperCase() : raw);
    if (shift) setShift(false);
  }
  function dictate() {
    if (disabled) return;
    if (listen) {
      stopRef.current?.();
      stopRef.current = null;
      setListen(false);
      return;
    }
    prefix.current = draft;
    setMicNote("");
    setListen(true);
    stopRef.current = startDictate((text, done, error) => {
      if (error && error !== "") {
        setListen(false);
        stopRef.current = null;
        setMicNote(error === "denied" ? "Allow microphone for klaʊdbot in Settings" : "Dictation unavailable");
        return;
      }
      const glue = prefix.current && text && !/\s$/.test(prefix.current) ? " " : "";
      if (text) onDraft(prefix.current + glue + text);
      if (done) { setListen(false); stopRef.current = null; }
    });
  }
  const bind = (action: () => void, kind: "letter" | "space" | "delete" | "return" | "send" = "letter") => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      setHold(null);
      feel(event, kind);
      action();
      if (kind === "delete") {
        window.clearInterval(repeat.current);
        repeat.current = window.setTimeout(() => {
          repeat.current = window.setInterval(() => action(), 55);
        }, 380);
      }
    },
    onPointerUp: lift, onPointerCancel: lift, onPointerLeave: lift,
  });
  const mic = <button type="button" className="field-kb-mic" disabled={disabled} aria-pressed={listen} aria-label={micNote || "Dictation"} title={micNote || "Dictation"} {...bind(dictate)}>
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M3.5 8.5c0 2.4 1.9 4.2 4.5 4.2s4.5-1.8 4.5-4.2" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M8 12.7v1.8M5.5 14.5h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"/></svg>
  </button>;
  const hide = <button type="button" className="field-kb-hide" aria-label="Hide keyboard" {...bind(() => onHide?.())}>⌄</button>;
  const send = <button type="button" className="field-kb-send" disabled={disabled} {...bind(onSend, "send")}>send</button>;
  return <div className="field-kb" aria-label="klaʊdbot keyboard">
    {hold && <div className="field-kb-hold" role="listbox" aria-label="More characters">
      {hold.map(key => <button type="button" key={key} disabled={disabled} {...bind(() => { press(key); setHold(null); })}>{key}</button>)}
    </div>}
    {alt ? <>
      <div className="field-kb-row field-kb-nums">{[...numberRow].map(key => <button type="button" key={key} disabled={disabled} {...bind(() => press(key))}>{key}</button>)}</div>
      {symbolRows.map(row => <div className="field-kb-row" key={row}>{[...row].map(key => <button type="button" key={key} disabled={disabled} {...bind(() => press(key))}>{key}</button>)}</div>)}
      <div className="field-kb-row">
        <button type="button" className="field-kb-mod" disabled={disabled} aria-pressed={alt} {...bind(() => { setAlt(false); setHold(null); })}>abc</button>
        <button type="button" className="field-kb-del" disabled={disabled} aria-label="Backspace" {...bind(() => onType("del"), "delete")}>⌫</button>
      </div>
    </> : <>
      <div className="field-kb-row">{[...letterRows[0]].map(key => <button type="button" key={key} disabled={disabled} {...bind(() => press(key))}>{shift ? key.toUpperCase() : key}</button>)}</div>
      <div className="field-kb-row field-kb-mid"><i className="field-kb-pad" aria-hidden="true"/><i className="field-kb-pad" aria-hidden="true"/>{[...letterRows[1]].map(key => <button type="button" key={key} disabled={disabled} {...bind(() => press(key))}>{shift ? key.toUpperCase() : key}</button>)}<i className="field-kb-pad" aria-hidden="true"/><i className="field-kb-pad" aria-hidden="true"/></div>
      <div className="field-kb-row">
        <button type="button" className="field-kb-mod" disabled={disabled} aria-pressed={shift} {...bind(() => setShift(on => !on))}>⇧</button>
        {[...letterRows[2]].map(key => <button type="button" key={key} disabled={disabled} {...bind(() => press(key))}>{shift ? key.toUpperCase() : key}</button>)}
        <button type="button" className="field-kb-del" disabled={disabled} aria-label="Backspace" {...bind(() => onType("del"), "delete")}>⌫</button>
      </div>
    </>}
    <div className="field-kb-row field-kb-actions">
      <button type="button" className="field-kb-mod" disabled={disabled} aria-pressed={alt} {...bind(() => { setAlt(on => !on); setHold(null); })}>{alt ? "abc" : "123"}</button>
      {mic}
      <button type="button" className="field-kb-space" disabled={disabled} {...bind(() => onType(" "), "space")}>space</button>
      {send}
      {hide}
    </div>
  </div>;
}

export function ChatPane({ bot, messages, phase, busy, draft, webRevision, onDraft, onSubmit, onStop, onPath,
  pending = [], onDecision, decisionBusy = false, lines = [], hasEarlier,
  loadingEarlier, onEarlier, onOpenBots, notice, disabled = false, toolName,
  railOpen = false, onToggleComputer, onOpenFile, swapLabel, phone = false, unitAccent, unitTheme }: ChatPaneProps) {
  const ledger = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const prevHeight = useRef(0);
  const ignoreScroll = useRef(false);
  const lastScroll = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const visible = usePageVisible();
  const nativeComposer = useNativeComposer({ bot, draft, webRevision, busy, disabled, onDraft, onSubmit, onStop });
  const inputId = useId();
  const rows = ledgerRows(messages);
  const lastAssistant = rows.findLastIndex(row => row.role === "assistant");
  useEffect(() => { prevHeight.current = 0; }, [bot?.id]);
  useEffect(() => {
    const el = ledger.current; if (!el) return;
    ignoreScroll.current = true;
    if (prevHeight.current) { el.scrollTop += el.scrollHeight - prevHeight.current; prevHeight.current = 0; }
    else el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => { ignoreScroll.current = false; lastScroll.current = el.scrollTop; });
  }, [messages, bot?.id]);
  function submit(event?: FormEvent) {
    event?.preventDefault(); if (!bot || busy || disabled || !draft.trim()) return; void onSubmit();
  }
  function attach(event: FormEvent<HTMLInputElement>) {
    const files = event.currentTarget.files;
    if (!files?.length) return;
    const names = [...files].slice(0, 8).map(file => file.name);
    onDraft(draft ? `${draft}${draft.endsWith("\n") ? "" : "\n"}+ ${names.join(", ")}` : `+ ${names.join(", ")}`);
    event.currentTarget.value = "";
  }
  const liveThink = messages.findLast(item => item.role === "assistant")?.thinking?.trim().split(/\n/).filter(Boolean).slice(-3) ?? [];
  const footerLines = busy && liveThink.length ? liveThink : busy ? lines.slice(-3) : [];
  const who = busy ? "agent" : "user";
  const [board, setBoard] = useState<"off" | "system" | "proprietary">("off");
  const [kbOpen, setKbOpen] = useState(true);
  useEffect(() => {
    const native = (window as Window & { klaudNative?: { inApp?: boolean; systemKeyboard?: boolean } }).klaudNative;
    const narrow = phone || window.matchMedia("(max-width: 820px)").matches;
    if (!narrow) { setBoard("off"); return; }
    setBoard(native?.inApp && !native.systemKeyboard ? "proprietary" : "system");
  }, [phone]);
  function typeKey(key: string) {
    const current = draftRef.current;
    const next = key === "del" ? current.slice(0, -1) : current + key;
    draftRef.current = next;
    onDraft(next);
  }
  function onLedgerScroll(event: ReactUIEvent<HTMLDivElement>) {
    if (board !== "proprietary" || !kbOpen || ignoreScroll.current) return;
    const y = event.currentTarget.scrollTop;
    if (y - lastScroll.current > 14) setKbOpen(false);
    lastScroll.current = y;
  }
  return <section className="chat-pane" data-cursor={who} aria-label="Chat" style={unitAccent ? { ["--unit-accent" as string]: unitAccent, ["--klaud-accent" as string]: unitAccent } : undefined}>
    <header className="chat-heading"><div className="chat-identity">
      {bot && <AvatarScene botId={bot.id} avatar={bot.avatar} state={phase} size={68} decorative paused={!visible} live={busy} toolName={toolName} accent={unitAccent} theme={unitTheme}/>}
      <div><h1>{bot?.name || "Choose a field unit"}</h1>
        <span className="avatar-caption" data-phase={phase}>{phase === "tool" && toolName ? toolName : phaseLabels[phase]}</span></div>
    </div><div className="chat-status">
      <button type="button" className="units-toggle" onClick={() => onOpenBots?.()}>Units</button>
      <button type="button" className="computer-toggle" aria-pressed={railOpen} onClick={() => onToggleComputer?.()}>{swapLabel || "Computer"}</button>
      <span className="folio" title="Field unit folio">{bot ? bot.id.slice(-4).toUpperCase() : "----"}</span>
    </div></header>
    <form className="crt-screen" onSubmit={submit}>
    <div className="transcript" ref={ledger} role="log" aria-label="Conversation ledger" aria-live={busy ? "off" : "polite"} aria-relevant="additions text" tabIndex={0} onScroll={onLedgerScroll}>
      {notice && <p className="ledger-notice" role="status">{notice}</p>}
      {hasEarlier && <button type="button" className="history-control" disabled={busy || loadingEarlier || !onEarlier} onClick={() => { prevHeight.current = ledger.current?.scrollHeight || 0; onEarlier?.(); }}>{loadingEarlier ? "Opening archive…" : "Open earlier ledger"}</button>}
      {!bot ? <div className="empty"><p className="eyebrow">No active unit</p><h2>Give your first agent a name.</h2><p className="muted">A durable conversation, ready when you are.</p>{onOpenBots && <button type="button" onClick={onOpenBots}>Open field units</button>}</div>
        : !rows.length ? <div className="empty"><p className="eyebrow">Ledger clear / {bot.id.slice(-4).toUpperCase()}</p><h2>What are we working on?</h2><p className="muted">Send an instruction to start this conversation.<br/>Your field unit keeps the thread between visits.</p></div>
          : rows.map((row, index) => {
            const live = busy && index === lastAssistant && index === rows.length - 1;
            return <article className={`message ${row.role}${row.isError ? " message-error" : ""}${!row.content && !live ? " message-slim" : ""}`} key={row.id}>
              <div className="role" onClick={() => { if (row.role === "assistant" && row.path.length) onPath(row.path); }}>{row.role === "assistant" && <BotAvatar botId={bot.id} avatar={bot.avatar} state="ready" size={44} decorative paused accent={unitAccent} theme={unitTheme}/>}
                <span className="message-number">{String(index + 1).padStart(3, "0")}</span>
              </div><div className="message-body">{row.role === "assistant" && row.path.length > 0 && <button type="button" className="path-open sr-only" onClick={() => onPath(row.path)} aria-label={`Open Path, ${row.path.length} nodes, reply ${index + 1}`}>Path</button>}
                {row.role === "user" && <span className="crt-prompt" aria-hidden="true">›</span>}
                <ReplyBody text={row.content} live={live} cwd={bot.cwd} onOpenFile={onOpenFile}/>
                {row.role === "user" && row.isError && <p className="message-retry-note" role="status">Not confirmed as accepted. Input restored for retry.</p>}
              </div>
            </article>;
          })}
    </div>
    {pending.length > 0 && <div className="approvals" aria-label="Operator decisions">{pending.map(action => <section key={action.id} className="approval-item" aria-label={`${action.tool} approval`}>
        <p><strong>Operator decision / {action.tool}</strong><span>{action.summary}</span></p>
        {action.args != null && <details><summary>Inspect arguments</summary><pre>{describe(action.args)}</pre></details>}
        <div className="approval-actions">{(action.kind === "tool" ? ["deny", "allow"] as const : ["deny", "allow", "whitelist", "always"] as const).map(decision => <button type="button" key={decision} className={decision === "allow" ? "primary" : ""} disabled={decisionBusy || !onDecision}
          title={decision === "always" ? "Approve this action and skip future approval waits for mutating tools" : decision === "whitelist" ? "Approve this action and automatically allow all new mutating tools as they are created" : undefined}
          onClick={() => onDecision?.(action.id, decision)}>{decision === "always" ? "Always allow" : decision[0].toUpperCase() + decision.slice(1)}</button>)}</div>
        {action.kind === "approval" && <p className="approval-policy-note">Whitelist automatically allows new mutating tools as they are created; Always allow skips future approval waits.</p>}
      </section>)}</div>}
    {!nativeComposer && <div className="crt-prompt-dock">
      <div className="crt-prompt-row">
        <input ref={fileRef} className="sr-only" type="file" multiple onChange={attach} tabIndex={-1} aria-hidden="true"/>
        <button type="button" className="crt-attach" disabled={!bot || disabled || busy} aria-label="Add attachment" title="Add attachment" onClick={() => fileRef.current?.click()}>+</button>
        {board === "proprietary" && <button type="button" className="crt-kb-toggle" aria-pressed={kbOpen} aria-label={kbOpen ? "Hide keyboard" : "Show keyboard"} title={kbOpen ? "Hide keyboard" : "Show keyboard"} onClick={() => setKbOpen(open => !open)}>{kbOpen ? "⌄" : "⌃"}</button>}
        <div className="crt-input-wrap" onPointerDown={() => { if (board === "proprietary") setKbOpen(true); }}>
          <div className="crt-input-mirror" aria-hidden="true">{draft || (!bot ? "choose a field unit" : "")}{!busy && <i className="crt-caret" data-who="user"/>}</div>
          <textarea id={inputId} className="crt-input" value={draft} onChange={event => onDraft(event.target.value)} placeholder="" disabled={!bot || disabled || busy} rows={1} maxLength={128 * 1024} aria-label="Operator input" inputMode={board === "proprietary" ? "none" : "text"} enterKeyHint="send" autoComplete="off" autoCorrect="off" spellCheck={false} readOnly={board === "proprietary"}
            onKeyDown={event => { if (board === "proprietary") return; if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}/>
        </div>
        {busy ? <button type="button" className="stop-run" onClick={onStop}>stop</button> : board !== "proprietary" ? <button type="submit" className="crt-send" disabled={!bot || disabled || !draft.trim()}>send</button> : null}
      </div>
    </div>}
    <div className="chat-footer" data-busy={busy ? "true" : "false"} data-paused={!visible} aria-live="polite">
      <span className="activity-signal" aria-hidden="true"><i/><i/><i/></span>
      <div className="thought-stream">
        {busy && footerLines.map((line, index, all) => <p key={`${index}-${line.slice(0, 24)}`}>{line}{index === all.length - 1 && !(lastAssistant >= 0 && lastAssistant === rows.length - 1) && <i className="crt-caret" data-who="agent" aria-hidden="true"/>}</p>)}
        {busy && !footerLines.length && <p><i className="crt-caret" data-who="agent" aria-hidden="true"/></p>}
        {!busy && <p>Ready</p>}
      </div>
    </div>
    {!nativeComposer && board === "proprietary" && <div className={`field-kb-shell${kbOpen ? "" : " is-away"}`} data-open={kbOpen ? "true" : "false"}>
      <FieldKeyboard disabled={!bot || disabled || busy} draft={draft} onDraft={onDraft} onType={typeKey} onSend={() => submit()} onHide={() => setKbOpen(false)}/>
    </div>}
    </form>
  </section>;
}

function FileGlyph({ kind }: { kind: string }) {
  return <svg viewBox="0 0 24 28" width={22} height={26} fill="none" aria-hidden="true">
    <path d="M3 1h12l6 6v20H3V1Z M15 1v7h6" stroke="currentColor" strokeWidth={1.5}/>
    {kind === "image" ? <><path d="m6 22 4-6 3 3 3-5 3 8H6Z" fill="currentColor"/><circle cx={8} cy={11} r={2} fill="currentColor"/></>
      : kind === "html" ? <path d="m9 13-3 4 3 4m6-8 3 4-3 4m-2-9-2 10" stroke="currentColor" strokeWidth={1.5}/>
        : <path d="M6 12h12M6 16h12M6 20h9" stroke="currentColor" strokeWidth={1.5}/>}
  </svg>;
}

function InspectPreview({ doc }: { doc: InspectDoc }) {
  if (doc.error) return <div className="inspect-fault" role="alert"><p className="eyebrow">Inspection fault</p><h3>Could not open this file.</h3><pre>{doc.path}{"\n\n"}{doc.error}</pre></div>;
  if (doc.url && doc.kind === "image") return <img src={doc.url} alt={doc.name || doc.path}/>;
  if (doc.url && doc.kind === "html") return <iframe src={doc.url} title={doc.name || "Workspace document"} sandbox="" referrerPolicy="no-referrer"/>;
  return <pre className="inspect-text">{doc.text || "This file has no text content."}</pre>;
}

export function InspectFloat({ frame, onMove, onClose, onPin }: {
  frame: InspectFrame;
  onMove: (id: string, x: number, y: number) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
}) {
  const [handoff, setHandoff] = useState("");
  function drag(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const originX = event.clientX - frame.x;
    const originY = event.clientY - frame.y;
    const move = (next: PointerEvent) => onMove(frame.id, next.clientX - originX, next.clientY - originY);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  async function handoffFile(mode: "save" | "share") {
    if (frame.doc.error) return;
    setHandoff("");
    try { await (mode === "save" ? saveInspectDoc(frame.doc) : shareInspectDoc(frame.doc)); }
    catch (error) { setHandoff(error instanceof Error ? error.message : "Could not export this file."); }
  }
  return <section className="inspect-float" data-pinned={frame.pinned || undefined} data-kind={frame.doc.kind} style={{ left: frame.x, top: frame.y }} aria-label={frame.doc.name}>
    <div className="inspect-float-bar" onPointerDown={drag}>
      <span title={frame.doc.path}>{frame.doc.name}</span>
      <div className="desktop-window-actions">
        <button type="button" disabled={Boolean(frame.doc.error)} onPointerDown={event => event.stopPropagation()} onClick={() => { void handoffFile("save"); }}>Save</button>
        <button type="button" disabled={Boolean(frame.doc.error)} onPointerDown={event => event.stopPropagation()} onClick={() => { void handoffFile("share"); }}>Share</button>
        <button type="button" aria-pressed={frame.pinned} title={frame.pinned ? "Unpin" : "Pin"} onPointerDown={event => event.stopPropagation()} onClick={() => onPin(frame.id)}>⌖</button>
        <button type="button" className="inspect-float-close" aria-label="Close file" onPointerDown={event => event.stopPropagation()} onClick={() => onClose(frame.id)}>×</button>
      </div>
    </div>
    <div className="inspect-preview"><InspectPreview doc={frame.doc}/></div>
    {handoff && <p className="inspect-handoff" role="status">{handoff}</p>}
  </section>;
}

export function ContextRail({ tab, onTab, nodes, selectedNodeId, onSelectNode, liveNodeId, bot, busy,
  held, onHold, files, filesLoading = false, doc, inspectLoading = false,
  onInspect, onCloseInspect, onRefresh, onPopOut }: ContextRailProps) {
  const id = useId();
  const selected = nodes.find(node => node.id === selectedNodeId) || nodes.at(-1);
  const tabs = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastFile = useRef<HTMLButtonElement | null>(null);
  const desktopRef = useRef<HTMLDivElement>(null);
  const [handoff, setHandoff] = useState("");
  useEffect(() => { if (doc) closeRef.current?.focus({ preventScroll: true }); }, [doc?.path]);
  function closeInspect() { onCloseInspect(); lastFile.current?.focus({ preventScroll: true }); }
  function dragCrt(event: ReactPointerEvent<HTMLElement>) {
    if (!held || !doc || inspectLoading) return;
    event.preventDefault();
    const move = (next: PointerEvent) => {
      const box = desktopRef.current?.getBoundingClientRect();
      if (!box) return;
      if (next.clientX < box.left || next.clientX > box.right || next.clientY < box.top || next.clientY > box.bottom) {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        onPopOut?.(doc, next.clientX - 36, next.clientY - 10);
      }
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  async function handoffFile(mode: "save" | "share") {
    if (!doc || doc.error) return;
    setHandoff("");
    try { await (mode === "save" ? saveInspectDoc(doc) : shareInspectDoc(doc)); }
    catch (error) { setHandoff(error instanceof Error ? error.message : "Could not export this file."); }
  }
  return <aside className="context-rail inspect-drawer" aria-label="Context rail">
    <header className="rail-heading"><div className="rail-tabs" role="tablist" aria-label="Context view" ref={tabs}
      onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const next = event.key === "Home" ? "path" : event.key === "End" ? "crt" : tab === "path" ? "crt" : "path";
        onTab(next); tabs.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
      } }}>
      <button type="button" role="tab" id={`${id}-path-tab`} aria-controls={`${id}-path`} aria-selected={tab === "path"} tabIndex={tab === "path" ? 0 : -1} data-tab="path" onClick={() => onTab("path")}>Path</button>
      <button type="button" role="tab" id={`${id}-crt-tab`} aria-controls={`${id}-crt`} aria-selected={tab === "crt"} tabIndex={tab === "crt" ? 0 : -1} data-tab="crt" onClick={() => onTab("crt")}>CRT</button>
    </div><span className="harness-status">{tab === "path" ? selected?.label ?? "Select a Path" : held ? "Operator hold" : busy ? "Agent driving" : "Parked"}</span></header>
    {tab === "path" ? <section className="path-focus" role="tabpanel" id={`${id}-path`} aria-labelledby={`${id}-path-tab`} tabIndex={0}>
      <div className="rail-kicker"><span>Execution path</span><span>{busy && liveNodeId ? `${String(Math.max(1, nodes.findIndex(n => n.id === liveNodeId) + 1)).padStart(2, "0")} / ${String(nodes.length).padStart(2, "0")}` : String(nodes.length).padStart(2, "0")}</span></div>
      {selected && <div className="path-detail"><p className="path-focus-kicker">{selected.kind === "tool" ? toolChip(selected.label) : selected.kind} / selected node</p><h2>{selected.kind === "tool" ? toolChip(selected.label) : selected.label}</h2><pre className="path-focus-body">{selected.text || "No text recorded for this node."}</pre></div>}
      <ol className="turn-graph path-tree" aria-label="Path spine">{(() => {
        const tools = nodes.map((node, index) => ({ node, index })).filter(item => item.node.kind === "tool");
        return nodes.map((node, index) => {
          if (node.kind === "tool") {
            if (tools[0]?.index !== index) return null;
            const open = tools.some(item => item.node.id === liveNodeId || item.node.id === selected?.id);
            return <li className={`turn-step nest${tools.some(item => item.node.id === liveNodeId) ? " live" : ""}`} key={`tools-${node.id}`}>
              <details className="path-nest" open={open || busy}>
                <summary>Tools · {String(tools.length).padStart(2, "0")}</summary>
                <ol>{tools.map(item => <li className={`turn-step tool${liveNodeId === item.node.id ? " live" : ""}`} key={item.node.id}>
                  <PathNodeButton node={item.node} index={item.index} selected={selected?.id === item.node.id} live={liveNodeId === item.node.id} onSelect={onSelectNode}/>
                </li>)}</ol>
              </details>
            </li>;
          }
          return <li className={`turn-step ${node.kind}${liveNodeId === node.id ? " live" : ""}`} key={`${node.id}-${index}`}>
            <PathNodeButton node={node} index={index} selected={selected?.id === node.id} live={liveNodeId === node.id} onSelect={onSelectNode}/>
          </li>;
        });
      })()}</ol>{!nodes.length && <div className="path-empty"><span className="path-empty-mark" aria-hidden="true">┌─┐<br/>└─┼─┐<br/>&nbsp;&nbsp;└─┘</span><h2>Follow the work.</h2><p>The path graph nests here as the run walks.</p></div>}
    </section> : <section className="computer-panel" role="tabpanel" id={`${id}-crt`} aria-labelledby={`${id}-crt-tab`}>
      <div className="computer-controls"><span className="small">Workspace / read-only</span><div>{onRefresh && <button type="button" aria-label="Refresh workspace files" title="Refresh files" disabled={filesLoading || !bot} onClick={onRefresh}>↻</button>}
        <button type="button" aria-pressed={held} disabled={!bot} onClick={() => onHold(!held)}>{held ? "Release" : "Take hold"}</button></div></div>
      <div className="computer-monitor" data-held={held} data-driving={busy && !held}>
        <div className="computer-bezel"><span>klaʊd CRT</span><span title={bot?.cwd}>{bot?.cwd ? bot.cwd.split("/").filter(Boolean).slice(-2).join("/") : "cwd"}</span></div>
        <div className="computer-cwd" title={bot?.cwd || "Working directory unavailable"}><span>cwd / </span>{bot?.cwd || "not provided"}</div>
        <div className="computer-desktop" ref={desktopRef} onClick={() => { if (doc) closeInspect(); }}>
          <div className="desktop-files" inert={!held} aria-label="Workspace files">{files.map(file => <button type="button" className={`desktop-icon${doc?.path === file.path ? " open" : ""}`} key={file.path}
            disabled={!held} title={`${file.path} · ${file.size.toLocaleString()} bytes`} onClick={event => { event.stopPropagation(); lastFile.current = event.currentTarget; onInspect(file.path); }}>
            <FileGlyph kind={file.kind}/><span>{file.path.split("/").pop()}<small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : file.kind}</small></span><span className="file-size">{file.size < 1024 ? `${file.size} B` : `${Math.ceil(file.size / 1024)} K`}</span>
          </button>)}</div>
          {!files.length && <p className="desktop-empty">{filesLoading ? "Reading workspace…" : !bot ? "Select a field unit." : "Workspace empty."}</p>}
          {(doc || inspectLoading) && <section className="desktop-window" data-kind={doc?.kind || "text"} aria-label={doc?.name || "File inspection"} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closeInspect(); } }}>
            <div className="desktop-window-bar" onPointerDown={dragCrt}>
              <span title={doc?.path}>{doc?.name || "Opening file…"}</span>
              <div className="desktop-window-actions">
                <button type="button" disabled={!doc || inspectLoading || Boolean(doc.error)} onPointerDown={event => event.stopPropagation()} onClick={() => { void handoffFile("save"); }}>Save</button>
                <button type="button" disabled={!doc || inspectLoading || Boolean(doc.error)} onPointerDown={event => event.stopPropagation()} onClick={() => { void handoffFile("share"); }}>Share</button>
                <button ref={closeRef} type="button" className="inspect-float-close" aria-label="Close file inspection" onPointerDown={event => event.stopPropagation()} onClick={closeInspect}>×</button>
              </div>
            </div>
            <div className="inspect-preview" tabIndex={0}>{inspectLoading ? <p className="inspect-text" role="status">Opening file…</p> : doc ? <InspectPreview doc={doc}/> : null}</div>
            {handoff && <p className="inspect-handoff" role="status">{handoff}</p>}
          </section>}
        </div>
        {!held && <div className="computer-glass" aria-label="Computer interaction locked"><p>{busy ? `${bot?.name || "Agent"} has the screen.` : "Take hold to inspect the workspace."}<span>File interaction is paused.</span></p></div>}
      </div>
      <p className="computer-note">Inspection only. Taking hold does not pause the agent.</p>
    </section>}
  </aside>;
}

function Setting({ title, help, children, toggle = false }: { title: string; help: string; children: ReactNode; toggle?: boolean }) {
  return <label className={`setting-row${toggle ? " toggle" : ""}`} data-sound-control><span><strong>{title}</strong><small>{help}</small></span>{children}</label>;
}

export function SettingsPanel({ shell, runSettings, onShellPatch, onRunSettings, rainEnabled, onRain,
  soundEnabled, onSound, onSetup, saving = false, busy = false, error,
  reasoningDescription, reasoningSupported, connectionLabel }: SettingsPanelProps) {
  return <section className="settings-panel page" aria-labelledby="settings-title">
    <div className="page-heading"><p className="eyebrow">Console controls / device</p><h1 id="settings-title">Set the working rhythm.</h1>
      <p className="lede">Run controls are saved by the connected backend. Rain, sound, and the assisted work profile stay on this device.</p></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <button type="button" className="setup-reopen" disabled={busy} onClick={onSetup}>Assisted setup <span>Model, work style & task limits →</span></button>
    <div className="setting-list">
      <Setting title="Approvals" help="Always skips every mutating tool. Auto skips Bash only. Whitelist auto-allows each tool as created. Ask requests a decision.">
        <select value={runSettings?.bashApproval || ""} disabled={!runSettings || saving || busy} onChange={event => onRunSettings({ bashApproval: event.target.value as RunSettings["bashApproval"] })}>
          <option value="" disabled>{error ? "Unavailable" : "Loading…"}</option><option value="always">Always approve</option><option value="auto">Auto approve Bash</option><option value="whitelist">Auto whitelist as created</option><option value="ask">Ask every time</option>
        </select>
      </Setting>
      <Setting title="Reasoning effort" help={reasoningDescription || "Requested effort for new runs. Provider support varies; this is not a measured reasoning score."}>
        <select value={runSettings?.reasoningEffort || ""} disabled={!runSettings || saving || busy} onChange={event => onRunSettings({ reasoningEffort: event.target.value as RunSettings["reasoningEffort"] })}>
          <option value="" disabled>{error ? "Unavailable" : "Loading…"}</option>{[["default", "Provider default"], ["off", "Off, if supported"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]].map(([value, label]) => <option key={value} value={value} disabled={reasoningSupported ? !reasoningSupported.includes(value) : false}>{label}</option>)}
        </select>
      </Setting>
      <Setting title="Accent signal" help="Action and active-state color"><select value={shell.theme.accent} disabled={saving} onChange={event => onShellPatch("/theme/accent", event.target.value)}><option value="rain">Rein rust</option><option value="slate">Field ink</option><option value="storm">Terminal green</option></select></Setting>
      <Setting title="Information density" help="Space between working rows"><select value={shell.theme.density} disabled={saving} onChange={event => onShellPatch("/theme/density", event.target.value)}><option value="compact">Compact</option><option value="regular">Regular</option><option value="roomy">Roomy</option></select></Setting>
      <Setting title="Tray presence" help="Saved shell preference. A browser has no system tray."><select value={shell.chrome.tray} disabled={saving} onChange={event => onShellPatch("/chrome/tray", event.target.value)}><option value="normal">Normal</option><option value="quiet">Quiet</option><option value="hidden">Hidden</option></select></Setting>
      <Setting title="Night console" help="Charcoal field surface" toggle><input type="checkbox" checked={shell.theme.dark} disabled={saving} onChange={event => onShellPatch("/theme/dark", event.target.checked)}/></Setting>
      <Setting title="Show agent rail" help="Keep field units at the left. The context rail remains available." toggle><input type="checkbox" checked={shell.chrome.sidebar} disabled={saving} onChange={event => onShellPatch("/chrome/sidebar", event.target.checked)}/></Setting>
      <Setting title="Show activity signal" help="Display ready and working state with a live tail" toggle><input type="checkbox" checked={shell.chrome.showActivity} disabled={saving} onChange={event => onShellPatch("/chrome/showActivity", event.target.checked)}/></Setting>
      <Setting title="Vintage console sounds" help="Quiet, device-local relay and CRT cues. Plays after interaction." toggle><input type="checkbox" checked={soundEnabled} onChange={event => onSound(event.target.checked)}/></Setting>
      <Setting title="Rain effects" help="Storm sits behind a frosted glass pane. Pauses when the tab is hidden, and respects reduced motion." toggle><input type="checkbox" checked={rainEnabled} onChange={event => onRain(event.target.checked)}/></Setting>
    </div>
    <div className="service-note"><p>Browser console / same-origin connection.<br/>No credentials are stored by this interface.</p><p>Connected to <code>{connectionLabel || "the configured local backend"}</code></p></div>
  </section>;
}

const DEFAULT_PROFILE: SetupProfile = { version: 1, model: "existing-dgx-spark", workStyle: "balanced", maxTurns: 40, maxIterations: 10, notes: "" };
const STYLE_LABELS: Record<SetupProfile["workStyle"], string> = { steps: "One clear step at a time", balanced: "A plan, then steady progress", thorough: "The full picture, with trade-offs" };
function safeProfile(profile?: SetupProfile | null): SetupProfile {
  return {
    version: 1, model: "existing-dgx-spark",
    workStyle: profile && Object.hasOwn(STYLE_LABELS, profile.workStyle) ? profile.workStyle : DEFAULT_PROFILE.workStyle,
    maxTurns: profile && Number.isInteger(profile.maxTurns) && profile.maxTurns >= 1 && profile.maxTurns <= 10000 ? profile.maxTurns : DEFAULT_PROFILE.maxTurns,
    maxIterations: profile && Number.isInteger(profile.maxIterations) && profile.maxIterations >= 1 && profile.maxIterations <= 1000 ? profile.maxIterations : DEFAULT_PROFILE.maxIterations,
    notes: typeof profile?.notes === "string" ? profile.notes.slice(0, 2000) : "",
  };
}

export function SetupWizard({ open, onClose, onFinish, profile, bots = [], selectedBotId,
  saving = false, error }: SetupWizardProps) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<SetupProfile>(() => safeProfile(profile));
  const [turns, setTurns] = useState(String(form.maxTurns));
  const [iterations, setIterations] = useState(String(form.maxIterations));
  const [botId, setBotId] = useState(selectedBotId || bots[0]?.id || "");
  const [starter, setStarter] = useState("Help me get a project unstuck, one step at a time.");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const next = safeProfile(profile); setForm(next); setTurns(String(next.maxTurns)); setIterations(String(next.maxIterations));
      setBotId(selectedBotId || bots[0]?.id || ""); setStep(0); setLocalError("");
    }
    wasOpen.current = open;
  }, [open, profile, selectedBotId, bots]);
  useEffect(() => { if (open) heading.current?.focus(); }, [step, open]);
  const validLimits = Number.isInteger(Number(turns)) && Number(turns) >= 1 && Number(turns) <= 10000 && Number.isInteger(Number(iterations)) && Number(iterations) >= 1 && Number(iterations) <= 1000;
  const working = saving || submitting;
  const reviewedProfile: SetupProfile = { ...form, maxTurns: Number(turns), maxIterations: Number(iterations) };
  const reviewedStarter = `${starter.trim()}\n\nMy working preferences: ${STYLE_LABELS[form.workStyle].toLowerCase()}. Please check in with me after about ${turns} model turns or ${iterations} autonomy iterations. These are requested review points, not enforced server limits.${form.notes.trim() ? `\nAdditional notes: ${form.notes.trim()}` : ""}`;
  async function finish() {
    if (working || !validLimits || !starter.trim()) return;
    setSubmitting(true); setLocalError("");
    try { await onFinish(reviewedProfile, reviewedStarter, botId || undefined); onClose(); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : "Could not save the device profile. Please try again."); }
    finally { setSubmitting(false); }
  }
  return <Modal open={open} onClose={() => { if (!working) onClose(); }} titleId={titleId} className="setup-dialog">
    <div className="dialog-heading"><div><p className="eyebrow">Assisted setup / device-local</p><h2 id={titleId}>A little help. Your way.</h2></div><button type="button" aria-label="Close assisted setup" onClick={onClose} disabled={working}>×</button></div>
    <ol className="setup-index">{["Existing model", "Work style", "Review & open"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><span>{String(index + 1).padStart(2, "0")}</span>{label}</li>)}</ol>
    <div className="setup-body"><h3 ref={heading} tabIndex={-1}>{["Keep the connection that works.", "How do you like to work?", "You have the final word."][step]}</h3>
      {step === 0 && <><div className="setup-found"><span className="eyebrow">Existing model host</span><strong>DGX Spark</strong><p>Use the model already configured for this console through the existing OpenAI-compatible backend.</p></div>
        <p>This browser does not offer model setup or hardware inspection. No credentials, endpoint changes, or server reconfiguration are needed here.</p><p className="muted">Next, choose a work style and review points. They are saved on this device only.</p></>}
      {step === 1 && <><fieldset className="work-style"><legend>Working rhythm</legend>{(Object.keys(STYLE_LABELS) as SetupProfile["workStyle"][]).map(style => <label className="choice" key={style}><input type="radio" name={`${titleId}-style`} checked={form.workStyle === style} onChange={() => setForm(current => ({ ...current, workStyle: style }))}/><span><strong>{STYLE_LABELS[style]}</strong><small>{style === "steps" ? "Short explanations and one next action." : style === "balanced" ? "A brief plan, useful detail, and checkpoints." : "Context, alternatives, and a careful recommendation."}</small></span></label>)}</fieldset>
        <div className="setup-limits"><label className="field-label">Turns per task<input type="number" min={1} max={10000} step={1} value={turns} onChange={event => setTurns(event.target.value)} required/></label><label className="field-label">Autonomy iterations<input type="number" min={1} max={1000} step={1} value={iterations} onChange={event => setIterations(event.target.value)} required/></label></div>
        <p className="local-only"><strong>Review preferences, not server budgets.</strong> These values become a request in your starter message. They do not enforce task limits, pause a run, enable autonomy, or grant tool permissions.</p>
        <label className="field-label">Anything else to keep in mind? <span className="muted">Optional</span><textarea rows={3} maxLength={2000} value={form.notes} onChange={event => setForm(current => ({ ...current, notes: event.target.value }))} placeholder="e.g. Explain unfamiliar terms and ask before changing files."/></label>
        {!validLimits && <p className="inline-error" role="status">Use whole numbers: 1–10,000 turns and 1–1,000 iterations.</p>}</>}
      {step === 2 && <>{bots.length > 0 && <label className="field-label">Continue with<select value={botId} onChange={event => setBotId(event.target.value)}>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>}
        <label className="field-label">Your first instruction<textarea rows={3} maxLength={8000} value={starter} onChange={event => setStarter(event.target.value)}/></label>
        <details className="starter-review" open><summary>Review the starter message</summary><pre>{reviewedStarter}</pre></details>
        <p className="local-only">Save the profile on this device and place this message in the composer. <strong>Nothing is sent until you press Transmit.</strong>{!bots.length && " Add a field unit before transmitting."}</p></>}
      {(error || localError) && <p className="inline-error" role="alert">{localError || error}</p>}
    </div>
    <div className="dialog-actions"><button type="button" disabled={working} onClick={() => step ? setStep(step - 1) : onClose()}>{step ? "Back" : "Cancel"}</button>
      {step < 2 ? <button type="button" className="primary" disabled={working || step === 1 && !validLimits} onClick={() => setStep(step + 1)}>{step === 0 ? "Keep existing model" : "Review starter"}</button>
        : <button type="button" className="primary" disabled={working || !validLimits || !starter.trim()} aria-busy={working} onClick={() => void finish()}>{working ? "Saving…" : "Save profile & open composer"}</button>}</div>
  </Modal>;
}

export function AccountOnboard({ connection, onSignIn, onRetry, onRequest, requested, requesting, error, returning = false }: {
  connection: "connecting" | "connected" | "auth" | "offline";
  onSignIn: () => void;
  onRetry: () => void;
  onRequest: (email: string, name: string) => Promise<void>;
  requested: boolean;
  requesting: boolean;
  error?: string;
  returning?: boolean;
}) {
  const [step, setStep] = useState(returning ? 1 : 0);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const labels = ["ZERMO account", "Authelia", "Console"];
  return <section className="connection-door" aria-label={returning ? "klaʊdbot sign in" : "klaʊdbot onboarding"}>
    <div>
      <p className="eyebrow">{returning ? "House account" : "First run / house account"}</p>
      <strong>{connection === "connecting" ? "Establishing link…" : returning ? "Sign in to klaʊdbot" : "Set up klaʊdbot"}</strong>
      <p>{returning ? "This device already has a house account on this harness. Sign in at auth.zermo.org if the session expired." : "A zermo.org account is minted into Authelia, then into the reinklaud API list. The console is one product — not a sibling bot."}</p>
    </div>
    <ol className="setup-index">{labels.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><span>{String(index + 1).padStart(2, "0")}</span>{label}</li>)}</ol>
    {step === 0 && <form className="onboard-form" onSubmit={event => { event.preventDefault(); void onRequest(email, name).then(() => setStep(1)); }}>
      <label className="field-label">Your name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} autoComplete="name" /></label>
      <label className="field-label">Email on zermo.org<input type="email" required maxLength={120} value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" placeholder="you@zermo.org" /></label>
      <p className="muted">This queues you for Authelia. Existing house users can skip ahead.</p>
      {requested && <p className="muted">Request received. Continue to Authelia.</p>}
      <div className="dialog-actions">
        <button type="button" onClick={() => setStep(1)}>I already have an account</button>
        <button type="submit" className="primary" disabled={requesting} aria-busy={requesting}>{requesting ? "Sending…" : "Request account"}</button>
      </div>
    </form>}
    {step === 1 && <div>
      <p>Sign in at auth.zermo.org. That cookie is the Authelia permit. After mint, /state on reinklaud.zermo.org answers as the API list.</p>
      <div className="dialog-actions">
        <button type="button" onClick={() => { if (!returning) setStep(0); }} disabled={returning}>Back</button>
        <button type="button" className="primary" onClick={onSignIn}>Sign in · auth.zermo.org</button>
        <button type="button" onClick={() => setStep(2)}>Continue</button>
      </div>
    </div>}
    {step === 2 && <div>
      <p>{connection === "connected" ? "Minted. The field console is open." : connection === "auth" ? "Authelia has you, waiting on the API list." : "Retry the link once Authelia has advanced the permit."}</p>
      <div className="dialog-actions">
        <button type="button" onClick={() => setStep(1)}>Back</button>
        <button type="button" className="primary" disabled={connection === "connecting"} onClick={onRetry}>Retry link</button>
      </div>
    </div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}