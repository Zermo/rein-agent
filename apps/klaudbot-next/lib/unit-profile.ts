export const UNIT_ACCENTS = Object.freeze({
  rain: "#c45c3a",
  rust: "#8f3b24",
  gold: "#c9a227",
  phosphor: "#f4ead4",
  storm: "#3d6b5c",
  slate: "#7a7468",
} as const);

export type UnitAccent = keyof typeof UNIT_ACCENTS;
export type UnitTheme = "field" | "night" | "paper";
export type UnitLoop = "scan" | "journal" | "idle" | "watch";

export interface UnitRoutine {
  id: string;
  title: string;
  when: string;
  loop: UnitLoop;
  enabled: boolean;
  lastFire?: number;
}

export interface UnitProfile {
  version: 1;
  accent: UnitAccent;
  theme: UnitTheme;
  soul: string;
  directive: string;
  routines: UnitRoutine[];
}

export const DEFAULT_UNIT: UnitProfile = Object.freeze({
  version: 1, accent: "rain", theme: "field", soul: "", directive: "", routines: [],
});

const ACCENTS = Object.keys(UNIT_ACCENTS) as UnitAccent[];
const THEMES: UnitTheme[] = ["field", "night", "paper"];
const LOOPS: UnitLoop[] = ["scan", "journal", "idle", "watch"];
const KEY = (id: string) => `rein.klaud.unit.${id}`;

function clip(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
}

export function accentHex(accent: UnitAccent | string | undefined): string {
  return UNIT_ACCENTS[(ACCENTS.includes(accent as UnitAccent) ? accent : "rain") as UnitAccent];
}

export function normalizeUnit(value: unknown): UnitProfile {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const routines = Array.isArray(raw.routines) ? raw.routines.slice(0, 12).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const loop = LOOPS.includes(row.loop as UnitLoop) ? row.loop as UnitLoop : "idle";
    return [{
      id: clip(row.id, 40) || `r${index}`,
      title: clip(row.title, 80) || "Loop",
      when: clip(row.when, 80),
      loop,
      enabled: row.enabled !== false,
      lastFire: typeof row.lastFire === "number" && Number.isFinite(row.lastFire) ? row.lastFire : 0,
    }];
  }) : [];
  return {
    version: 1,
    accent: ACCENTS.includes(raw.accent as UnitAccent) ? raw.accent as UnitAccent : "rain",
    theme: THEMES.includes(raw.theme as UnitTheme) ? raw.theme as UnitTheme : "field",
    soul: clip(raw.soul, 8000),
    directive: clip(raw.directive, 2000),
    routines,
  };
}

export function loadUnit(id: string): UnitProfile {
  if (!id) return { ...DEFAULT_UNIT, routines: [] };
  try { return normalizeUnit(JSON.parse(localStorage.getItem(KEY(id)) ?? "null")); }
  catch { return { ...DEFAULT_UNIT, routines: [] }; }
}

export function saveUnit(id: string, profile: UnitProfile): UnitProfile {
  const next = normalizeUnit(profile);
  try { localStorage.setItem(KEY(id), JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

export function newRoutine(): UnitRoutine {
  return { id: `r${Date.now().toString(36)}`, title: "Loop", when: "", loop: "idle", enabled: true, lastFire: Date.now() };
}
