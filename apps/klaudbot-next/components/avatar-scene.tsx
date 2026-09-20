"use client";

import { useEffect, useRef, useState } from "react";
import { BotAvatar, type BotAvatarProps } from "./avatars";
import { avatarForBot, isAvatarPhase } from "../lib/avatar-catalog";
import { motionPhaseFor, seedForAvatar } from "../lib/avatar-motion";

type PropKind = "wrench" | "card" | "radio" | "pencil" | "mug" | "film" | "map" | "bolt" | "tape" | "lamp";

type Flyer = {
  id: number;
  kind: PropKind;
  x: number;
  y: number;
  r: number;
  s: number;
  born: number;
  life: number;
  vx: number;
  vy: number;
  vr: number;
};

function kindFor(toolName: string | undefined, motion: string): PropKind {
  const t = (toolName ?? "").toLowerCase();
  if (/bash|shell|exec|terminal/.test(t)) return "wrench";
  if (/write|edit|patch|apply/.test(t)) return "pencil";
  if (/read|cat|open|file|inspect/.test(t)) return "card";
  if (/search|grep|web|find/.test(t)) return "map";
  if (/browser|fetch|http/.test(t)) return "radio";
  if (/image|video|media/.test(t)) return "film";
  if (motion === "thinking") return "lamp";
  if (motion === "journaling") return "pencil";
  if (motion === "tool") return "wrench";
  if (motion === "responding") return "card";
  return "bolt";
}

function PropMark({ kind }: { kind: PropKind }) {
  const ink = "currentColor";
  switch (kind) {
    case "wrench":
      return <path d="M7 4 l3 3 -2 2 6 6 2-2 3 3-5 5-3-3-2 2-6-6 2-2-3-3z" fill="none" stroke={ink} strokeWidth="2" />;
    case "card":
      return <><rect x="4" y="7" width="16" height="11" rx="1" fill="none" stroke={ink} strokeWidth="2"/><path d="M7 11 h10 M7 14 h7" stroke={ink} strokeWidth="1.6"/></>;
    case "radio":
      return <><rect x="5" y="8" width="14" height="10" rx="1" fill="none" stroke={ink} strokeWidth="2"/><circle cx="10" cy="13" r="2" fill="none" stroke={ink} strokeWidth="1.6"/><path d="M16 5 l-3 4 M15 11 v4" stroke={ink} strokeWidth="1.6"/></>;
    case "pencil":
      return <path d="M6 16 l10-10 3 3-10 10 H6z M15 7 l3 3" fill="none" stroke={ink} strokeWidth="2"/>;
    case "mug":
      return <><path d="M6 8 h10 v8 a4 4 0 0 1-10 0z M16 10 h3 a2 2 0 0 1 0 5 h-3" fill="none" stroke={ink} strokeWidth="2"/></>;
    case "film":
      return <><rect x="5" y="6" width="14" height="12" rx="1" fill="none" stroke={ink} strokeWidth="2"/><path d="M8 6 v12 M16 6 v12 M8 10 h8" stroke={ink} strokeWidth="1.5"/></>;
    case "map":
      return <path d="M5 7 l5 2 4-2 5 2 v10 l-5-2-4 2-5-2z M10 9 v10 M14 7 v10" fill="none" stroke={ink} strokeWidth="2"/>;
    case "bolt":
      return <path d="M13 3 l-7 10 h5 l-2 8 8-11 h-5z" fill="none" stroke={ink} strokeWidth="2" strokeLinejoin="round"/>;
    case "tape":
      return <><rect x="4" y="9" width="16" height="7" rx="1" fill="none" stroke={ink} strokeWidth="2"/><circle cx="8" cy="12.5" r="1.4"/><circle cx="16" cy="12.5" r="1.4"/></>;
    default:
      return <><path d="M12 4 v6 M9 7 h6" stroke={ink} strokeWidth="2"/><path d="M7 13 q5-3 10 0 v5 h-10z" fill="none" stroke={ink} strokeWidth="2"/></>;
  }
}

export interface AvatarSceneProps extends BotAvatarProps {
  live?: boolean;
  toolName?: string;
}

let flyerSeq = 1;

export function AvatarScene({ live = false, toolName, ...props }: AvatarSceneProps) {
  const size = typeof props.size === "number" && Number.isFinite(props.size) ? Math.max(24, Math.min(512, props.size)) : 52;
  const choice = avatarForBot(props.botId, props.avatar);
  const phase = isAvatarPhase(props.state ?? "") ? props.state as string : "ready";
  const motion = motionPhaseFor(phase);
  const paused = Boolean(props.paused) || !live || motion === "still";
  const focused = live && motion !== "still";
  const seed = seedForAvatar(props.botId ?? choice);
  const [flyers, setFlyers] = useState<Flyer[]>([]);
  const liveRef = useRef(flyers);
  liveRef.current = flyers;

  useEffect(() => {
    if (paused || (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
      setFlyers([]);
      return;
    }
    let dead = false;
    let raf = 0;
    let last = performance.now();
    let nextSpawn = last + 400;
    const tick = (now: number) => {
      if (dead) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      let list = liveRef.current.map(item => ({
        ...item,
        x: item.x + item.vx * dt,
        y: item.y + item.vy * dt,
        r: item.r + item.vr * dt,
      })).filter(item => now - item.born < item.life);
      if (now >= nextSpawn && list.length < 1) {
        const kind = kindFor(toolName, motion);
        list = [...list, {
          id: flyerSeq++,
          kind,
          x: 0.72,
          y: 0.18,
          r: -12,
          s: 0.92,
          born: now,
          life: 2200,
          vx: -0.18,
          vy: 0.12,
          vr: 28,
        }];
        nextSpawn = now + 1600;
      }
      setFlyers(list);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { dead = true; cancelAnimationFrame(raf); };
  }, [paused, motion, seed, toolName]);

  return (
    <span className="bot-avatar-stage" data-avatar={choice} data-state={phase} data-motion={motion} data-live={live ? "true" : "false"} data-focused={focused ? "true" : "false"} style={{ width: size, height: size }}>
      <span className="bot-avatar-plate" aria-hidden="true" />
      <BotAvatar {...props} size={Math.round(size * 0.94)} paused={paused} state={focused ? "working" : phase} />
      {live && <span className="bot-avatar-props" aria-hidden="true">
        {flyers.map(item => (
          <svg key={item.id} className="bot-prop" viewBox="0 0 24 24" width={Math.round(size * 0.38)} height={Math.round(size * 0.38)}
            style={{ transform: `translate(${item.x * size}px, ${item.y * size}px) rotate(${item.r}deg) scale(${item.s})` }}>
            <PropMark kind={item.kind} />
          </svg>
        ))}
      </span>}
    </span>
  );
}
