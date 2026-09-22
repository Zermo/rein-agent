"use client";

import React, { useEffect, useRef } from "react";
import { AVATAR_BROWS, AVATAR_STATES, AVATAR_STYLES, avatarForBot, isAvatarPhase, kitForSeed, type AvatarId, type AvatarKit } from "../lib/avatar-catalog";
import { attachAvatarMotion, seedForAvatar, type AvatarMotionController } from "../lib/avatar-motion";

export interface BotAvatarProps {
  avatar?: string;
  botId?: string;
  state?: string;
  size?: number;
  decorative?: boolean;
  paused?: boolean;
  accent?: string;
  theme?: "field" | "night" | "paper";
}

export interface AvatarPickerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  accent?: string;
  theme?: "field" | "night" | "paper";
}

const ink = "var(--avatar-ink)", rust = "var(--avatar-rust)", paper = "var(--avatar-paper)", gold = "var(--avatar-gold)";

function Glasses({ kind = "round" }: { kind?: "round" | "square" }) {
  return <g className="bot-avatar-glasses" fill="none" stroke={ink} strokeWidth="3" strokeLinejoin="round">
    {kind === "square" ? <><path d="M27 64 H61 V96 Q44 102 30 93 Z"/><path d="M67 64 H101 L98 93 Q84 102 67 96 Z"/></> : <><circle cx="44" cy="80" r="17"/><circle cx="84" cy="80" r="17"/></>}
    <path d="M57 77 Q64 73 71 77 M25 74 L31 77 M97 77 L103 74"/>
    <path d="M38 76 L44 72 M78 76 L84 72" stroke={gold} strokeWidth="2"/>
  </g>;
}

const EYE_LOOK: Record<string, readonly [number, number, number]> = {
  ready: [1.1, 0.4, 6.2],
  working: [1.8, 0.8, 5.2],
  thinking: [0.2, -2.4, 5.6],
  responding: [1.4, 0.2, 6.8],
  presenting: [0, 0.3, 6.0],
  tool: [2.0, 1.0, 5.0],
  journaling: [1.5, 1.2, 5.4],
  autonomy: [0.5, -0.8, 5.8],
  approval: [0, 0.4, 6.4],
  error: [-0.2, 1.2, 7.2],
};

function Eyes({ phase }: { phase: string }) {
  const [dx, dy, pr] = EYE_LOOK[phase] ?? EYE_LOOK.ready;
  const Eye = ({ cx }: { cx: number }) => (
    <g className="bot-avatar-eye" transform={`translate(${cx} 80)`}>
      <circle className="bot-avatar-sclera" r="15.2" fill="#f4ead4" stroke="#12100e" strokeWidth="3"/>
      <circle className="bot-avatar-iris" cx={dx} cy={dy} r="10.4" fill={rust} stroke="#12100e" strokeWidth="2"/>
      <circle className="bot-avatar-pupil" cx={dx} cy={dy} r={pr} fill="#12100e"/>
      <circle className="bot-avatar-glint" cx={dx - 3.6} cy={dy - 3.4} r="2.4" fill="#f4ead4"/>
    </g>
  );
  return <g className="bot-avatar-eyes" aria-hidden="true"><Eye cx={44}/><Eye cx={84}/></g>;
}

function Headwear({ avatar }: { avatar: AvatarId }) {
  switch (avatar) {
    case "motorcycle": return <>
      <path d="M27 66 C23 37 40 17 64 17 C90 17 106 35 104 65 L98 95 L83 108 H43 L28 89 Z M34 56 L34 83 Q64 97 96 83 L96 56 Z" fill={rust} fillRule="evenodd" stroke={ink} strokeWidth="3"/>
      <path d="M35 52 Q66 43 99 52 M44 97 H82 M51 103 H75" fill="none" stroke={ink} strokeWidth="3"/>
      <path d="M52 21 Q43 31 43 45 H50 Q49 33 58 21 Z" fill={paper}/>
      <path d="M35 84 Q64 94 95 84" fill="none" stroke={gold} strokeWidth="2"/>
      <circle cx="29" cy="61" r="4" fill={paper} stroke={ink} strokeWidth="2"/>
      <circle cx="101" cy="61" r="4" fill={paper} stroke={ink} strokeWidth="2"/>
      <g className="bot-avatar-glasses"><path d="M40 79 H54 M74 79 H88" fill="none" stroke={ink} strokeWidth="3"/></g>
    </>;
    case "builder": return <>
      <path d="M27 56 V49 C27 31 43 23 64 23 C85 23 101 32 101 49 V56 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M58 24 V15 H70 V56 H58 Z" fill={gold} stroke={ink} strokeWidth="3"/>
      <path d="M40 32 L36 52 M87 32 L92 52" fill="none" stroke={ink} strokeWidth="3"/>
      <path d="M18 54 L110 54 V61 H18 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <Glasses kind="square"/>
    </>;
    case "baseball": return <>
      <path d="M28 51 C29 30 45 20 65 22 C86 24 97 35 97 52 L75 55 L43 52 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M27 49 L79 48 Q101 47 115 61 Q91 66 69 56 L28 56 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M62 24 Q47 34 45 49 M73 25 Q86 33 88 47" fill="none" stroke={ink} strokeWidth="2"/>
      <path d="M29 57 V77 L23 85 V55 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M53 32 H61 V39 H53 Z" fill={paper}/>
      <circle cx="63" cy="21" r="3" fill={ink}/>
      <Glasses kind="square"/>
    </>;
    case "medic": return <>
      <path d="M29 52 L26 36 Q29 27 43 28 Q53 18 64 23 Q80 20 87 29 Q101 30 103 40 L99 53 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M29 48 H99 V55 H29 Z" fill={paper} stroke={ink} strokeWidth="3"/>
      <path d="M46 32 L45 43 M77 29 L82 43" fill="none" stroke={ink} strokeWidth="2"/>
      <Glasses/>
      <path d="M38 87 L30 86 M90 87 L98 86" fill="none" stroke={ink} strokeWidth="2"/>
      <path d="M39 83 Q64 87 89 83 L85 99 Q64 111 43 99 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M47 91 H81 M48 97 H80" fill="none" stroke={paper} strokeWidth="2"/>
      <path d="M33 98 V105 Q33 118 46 118 Q59 118 59 107 M38 102 V107 M54 106 V109 M59 108 Q79 131 94 112 V106" fill="none" stroke={ink} strokeWidth="3"/>
      <circle cx="94" cy="103" r="6" fill={gold} stroke={ink} strokeWidth="3"/>
    </>;
    case "explorer": return <>
      <path d="M36 53 L42 24 L55 29 L68 23 L86 29 L94 55 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M39 43 Q63 50 90 44 L93 54 L36 54 Z" fill={ink}/>
      <path d="M12 53 Q26 47 38 51 Q64 59 94 51 Q105 46 116 53 Q110 63 92 64 L29 61 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M60 48 H68 V54 H60 Z" fill={gold}/>
      <Glasses/>
    </>;
    case "radio": return <>
      <path d="M38 56 Q40 32 64 30 Q88 32 90 56" fill={rust} stroke={ink} strokeWidth="3"/>
      <circle cx="28" cy="78" r="7" fill={rust} stroke={ink} strokeWidth="3"/>
      <circle cx="100" cy="78" r="7" fill={rust} stroke={ink} strokeWidth="3"/>
      <Glasses/>
    </>;
    case "ranger": return <>
      <ellipse cx="64" cy="56" rx="44" ry="8" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M42 54 Q44 28 64 26 Q84 28 86 54 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <Glasses/>
    </>;
    case "welder": return <>
      <path d="M34 56 Q36 28 64 26 Q92 30 96 56 L70 60 L40 58 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M32 54 H78 Q98 54 104 64 Q86 68 68 60 H32 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <Glasses kind="square"/>
    </>;
    case "sailor": return <>
      <path d="M32 64 Q34 28 64 26 Q94 28 96 64 L88 70 H40 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M40 46 H88 M42 58 H86" fill="none" stroke={ink} strokeWidth="2"/>
      <Glasses/>
    </>;
    case "courier": return <>
      <path d="M36 58 Q40 26 64 24 Q90 28 94 58 Q64 66 36 58 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M34 56 L62 54 Q86 54 96 64 Q78 68 60 60 L34 60 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <Glasses kind="square"/>
    </>;
    case "watch": return <>
      <path d="M36 56 Q38 30 64 28 Q90 30 92 56 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M28 54 H100 V60 H28 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <Glasses kind="square"/>
    </>;
    case "clerk": return <>
      <path d="M24 62 Q64 72 104 62 L100 70 Q64 80 28 70 Z" fill={gold} stroke={ink} strokeWidth="3"/>
      <path d="M30 58 H98" fill="none" stroke={ink} strokeWidth="3"/>
      <Glasses/>
    </>;
    case "open": return <>
      <path d="M40 102 Q64 110 88 102 L84 118 Q64 112 44 118 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <Glasses/>
    </>;
    default: return <>
      <path d="M26 60 C24 32 41 17 65 18 C91 18 105 35 103 62 L99 89 L87 95 L85 54 Q64 44 43 54 L40 95 L27 90 Z" fill={rust} stroke={ink} strokeWidth="3"/>
      <path d="M39 28 Q32 46 36 61 M86 27 Q97 39 96 58 M60 21 Q56 32 58 45" fill="none" stroke={gold} strokeWidth="2" strokeDasharray="3 3"/>
      <path d="M43 51 Q64 43 85 51 L87 58 Q64 51 41 58 Z" fill={paper} stroke={ink} strokeWidth="2"/>
      <circle cx="34" cy="83" r="3" fill={gold}/><circle cx="93" cy="83" r="3" fill={gold}/>
      <path d="M24 76 H103" fill="none" stroke={rust} strokeWidth="8"/>
      <Glasses/>
      <path d="M41 101 L56 98 L70 103 L83 101 L79 111 L63 108 L47 111 Z" fill={rust} stroke={ink} strokeWidth="3"/>
    </>;
  }
}

function KitGear({ kit }: { kit: AvatarKit }) {
  return <g className="bot-avatar-kit" fill="none">
    {kit.band && <path d="M40 48 H88" stroke={gold} strokeWidth="2"/>}
    {kit.extra === "strap" && <path d="M38 94 Q64 112 90 94" stroke={ink} strokeWidth="3"/>}
    {kit.extra === "badge" && <circle cx="64" cy="40" r="4" fill={gold} stroke={ink} strokeWidth="2"/>}
  </g>;
}

export function BotAvatar({ avatar, botId, state = "ready", size = 48, decorative = false, paused = false, accent, theme = "field" }: BotAvatarProps) {
  const choice = avatarForBot(botId, avatar);
  const phase = isAvatarPhase(state) ? state : "ready";
  const label = AVATAR_STYLES.find(style => style.id === choice)!.label;
  const dimension = typeof size === "number" && Number.isFinite(size) ? Math.max(16, Math.min(512, size)) : 48;
  const brows = AVATAR_BROWS[phase];
  const svg = useRef<SVGSVGElement>(null), motion = useRef<AvatarMotionController | null>(null);
  const seed = seedForAvatar(botId ?? choice);
  const kit = kitForSeed(seed);
  useEffect(() => {
    if (!svg.current) return;
    motion.current = attachAvatarMotion(svg.current);
    return () => { motion.current?.destroy(); motion.current = null; };
  }, [choice]);
  useEffect(() => { motion.current?.update({ phase, seed, paused }); }, [choice, phase, seed, paused]);
  return <svg ref={svg} className="bot-avatar" viewBox="0 0 128 128" width={dimension} height={dimension}
    data-avatar={choice} data-kit={kit.extra} data-theme={theme} data-state={phase} data-paused={paused ? "true" : "false"}
    style={accent ? { ["--avatar-rust" as string]: accent } : undefined}
    role={decorative ? undefined : "img"} aria-hidden={decorative ? "true" : undefined}
    aria-label={decorative ? undefined : `${label} avatar — ${AVATAR_STATES[phase]}`} focusable="false">
    <g className="bot-avatar-portrait"><Headwear avatar={choice}/>
      <Eyes phase={phase}/>
      <g className="bot-avatar-brows" fill="none" stroke={ink} strokeWidth="4" strokeLinecap="round">
        <g className="bot-avatar-brow-left"><path d={brows[0]}/></g>
        <g className="bot-avatar-brow-right"><path d={brows[1]}/></g>
      </g>
      <KitGear kit={kit}/>
    </g>
  </svg>;
}

export function AvatarPicker({ value, onChange, disabled = false, accent, theme = "field" }: AvatarPickerProps) {
  return <div className="avatar-picker" role="group" aria-label="Bot avatar">
    {AVATAR_STYLES.map(style => <button className="avatar-choice" type="button" key={style.id}
      aria-pressed={value === style.id} aria-label={`${style.label}: ${style.description}`} disabled={disabled}
      onClick={() => onChange?.(style.id)}>
      <BotAvatar avatar={style.id} size={72} decorative paused accent={accent} theme={theme}/><span>{style.label}</span>
      <span className="avatar-choice-mark" aria-hidden="true">{value === style.id ? "✓" : "+"}</span>
    </button>)}
  </div>;
}
