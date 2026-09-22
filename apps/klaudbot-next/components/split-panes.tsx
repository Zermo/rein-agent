"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type PointerEvent } from "react";

const KEY = "rein.klaud.pane-widths";
const ROSTER_MIN = 220, ROSTER_MAX = 380, ROSTER_DEFAULT = 260;
const RAIL_MIN = 320, RAIL_MAX = 720, RAIL_DEFAULT = 420;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function readStored(): { roster: number; rail: number } {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const o = raw as { roster?: unknown; rail?: unknown };
      return {
        roster: typeof o.roster === "number" ? clamp(o.roster, ROSTER_MIN, ROSTER_MAX) : ROSTER_DEFAULT,
        rail: typeof o.rail === "number" ? clamp(o.rail, RAIL_MIN, RAIL_MAX) : RAIL_DEFAULT,
      };
    }
  } catch { /* private mode */ }
  return { roster: ROSTER_DEFAULT, rail: RAIL_DEFAULT };
}

function Handle({ label, onDrag }: { label: string; onDrag: (dx: number) => void }) {
  const last = useRef(0);
  const down = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    last.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const move = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const dx = event.clientX - last.current;
    last.current = event.clientX;
    if (dx) onDrag(dx);
  }, [onDrag]);
  return <button type="button" className="pane-resizer" aria-label={label} onPointerDown={down} onPointerMove={move} />;
}

export function SplitPanes({ showLeft, left, center, right, railOpen = true }: {
  showLeft: boolean; left: ReactNode; center: ReactNode; right: ReactNode;
  railOpen?: boolean;
}) {
  const [{ roster, rail }, setWidths] = useState(readStored);
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ roster, rail })); } catch { /* device-only */ }
  }, [roster, rail]);
  return (
    <div className="workspace" data-rail={railOpen ? "open" : "shut"} style={{ ["--roster-w" as string]: `${roster}px`, ["--rail-w" as string]: `${rail}px` }}>
      {showLeft ? <>
        <div className="split-left">{left}</div>
        <Handle label="Resize agent rail" onDrag={dx => setWidths(w => ({ ...w, roster: clamp(w.roster + dx, ROSTER_MIN, ROSTER_MAX) }))} />
      </> : null}
      <div className="split-center">{center}</div>
      {railOpen ? <>
        <Handle label="Resize computer pane" onDrag={dx => setWidths(w => ({ ...w, rail: clamp(w.rail - dx, RAIL_MIN, RAIL_MAX) }))} />
        <div className="split-right">{right}</div>
      </> : null}
    </div>
  );
}
