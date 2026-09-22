import type { UnitLoop, UnitProfile, UnitRoutine } from "./unit-profile.ts";

export const UNIT_BLOCK_START = "<!-- klaudbot:unit:start -->";
export const UNIT_BLOCK_END = "<!-- klaudbot:unit:end -->";

export type WhenSpec =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "every"; ms: number }
  | { kind: "none" };

const LOOPS: UnitLoop[] = ["scan", "journal", "idle", "watch"];

export function parseWhen(value: string): WhenSpec {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || text === "manual" || text === "on trigger") return { kind: "none" };
  const daily = /^(\d{1,2}):(\d{2})(?:\s*(?:daily|each day)?)?$/.exec(text);
  if (daily) {
    const hour = Number(daily[1]), minute = Number(daily[2]);
    if (hour > 23 || minute > 59) return { kind: "none" };
    return { kind: "daily", hour, minute };
  }
  const every = /^every\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)$/.exec(text);
  if (every) {
    const n = Number(every[1]);
    if (!Number.isInteger(n) || n < 1 || n > 24 * 60) return { kind: "none" };
    const ms = every[2].startsWith("h") ? n * 3_600_000 : n * 60_000;
    if (ms < 60_000 || ms > 24 * 3_600_000) return { kind: "none" };
    return { kind: "every", ms };
  }
  return { kind: "none" };
}

export function routineDue(row: UnitRoutine, now: number): boolean {
  if (!row.enabled) return false;
  const spec = parseWhen(row.when);
  if (spec.kind === "none") return false;
  const last = typeof row.lastFire === "number" && Number.isFinite(row.lastFire) ? row.lastFire : 0;
  if (!last) return false;
  if (spec.kind === "every") return now - last >= spec.ms;
  const current = new Date(now);
  const target = new Date(now);
  target.setHours(spec.hour, spec.minute, 0, 0);
  return now >= target.getTime() && last < target.getTime();
}

export function loopPrompt(row: UnitRoutine): string {
  const spec = parseWhen(row.when);
  const schedule = spec.kind === "daily"
    ? `${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")} daily`
    : spec.kind === "every" ? `every ${spec.ms / 60_000}m` : (row.when.trim() || "manual");
  return [
    "[klaudbot loop]",
    `Kind: ${row.loop}`,
    `Title: ${row.title || "Loop"}`,
    `Schedule: ${schedule}`,
    "This standing pass is due. Follow your soul and directive from identity. Complete this loop, then stop. Do not wait for more operator chat.",
  ].join("\n");
}

export function renderUnitBlock(profile: Pick<UnitProfile, "soul" | "directive" | "routines">): string {
  const soul = profile.soul.trim() || "(unset)";
  const directive = profile.directive.trim() || "(unset)";
  const lines = profile.routines.length
    ? profile.routines.map(row => `- [${row.enabled ? "x" : " "}] ${row.loop} @ ${row.when || "manual"} — ${row.title}`)
    : ["- none"];
  return [
    UNIT_BLOCK_START,
    "# Soul",
    soul,
    "",
    "# Directive",
    directive,
    "",
    "# Routines",
    ...lines,
    UNIT_BLOCK_END,
  ].join("\n");
}

export function upsertUnitBlock(source: string, profile: Pick<UnitProfile, "soul" | "directive" | "routines">): string {
  const block = renderUnitBlock(profile);
  const start = source.indexOf(UNIT_BLOCK_START);
  const end = source.indexOf(UNIT_BLOCK_END);
  if (start >= 0 && end > start) {
    return `${source.slice(0, start).trimEnd()}\n\n${block}\n${source.slice(end + UNIT_BLOCK_END.length).trimStart()}`.trim() + "\n";
  }
  const body = source.trim();
  return `${body ? `${body}\n\n` : ""}${block}\n`;
}

export function parseIdentity(source: string): { soul: string; directive: string; routines: UnitRoutine[] } {
  const marked = parseUnitBlock(source);
  if (marked) return marked;
  const soul = section(source, "Soul", "Directive");
  const directive = section(source, "Directive", "Routines");
  if (soul || directive) return { soul, directive, routines: [] };
  return { soul: source.trim(), directive: "", routines: [] };
}

export function parseUnitBlock(source: string): { soul: string; directive: string; routines: UnitRoutine[] } | null {
  const start = source.indexOf(UNIT_BLOCK_START);
  const end = source.indexOf(UNIT_BLOCK_END);
  if (start < 0 || end <= start) return null;
  const block = source.slice(start + UNIT_BLOCK_START.length, end);
  const soul = section(block, "Soul", "Directive");
  const directive = section(block, "Directive", "Routines");
  const routineText = section(block, "Routines", "");
  const routines = routineText.split("\n").flatMap((line, index) => {
    const match = /^- \[([ xX])\] (scan|journal|idle|watch) @ (.*?) — (.*)$/.exec(line.trim());
    if (!match) return [];
    const loop = LOOPS.includes(match[2] as UnitLoop) ? match[2] as UnitLoop : "idle";
    return [{ id: `r${index}`, title: match[4].slice(0, 80) || "Loop", when: match[3].slice(0, 80), loop, enabled: match[1].toLowerCase() === "x", lastFire: 0 }];
  });
  return { soul, directive, routines };
}

function section(block: string, heading: string, next: string): string {
  const start = block.search(new RegExp(`^# ${heading}\\s*$`, "m"));
  if (start < 0) return "";
  const from = block.indexOf("\n", start);
  const rest = from < 0 ? "" : block.slice(from + 1);
  if (!next) return rest.trim();
  const end = rest.search(new RegExp(`^# ${next}\\s*$`, "m"));
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}
