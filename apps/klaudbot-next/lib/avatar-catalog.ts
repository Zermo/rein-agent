export const AVATAR_STYLES = Object.freeze(([
  { id: "aviator", label: "Aviator", description: "Leather flying cap and round flight goggles" },
  { id: "motorcycle", label: "Rider", description: "Motorcycle helmet and an open visor" },
  { id: "builder", label: "Builder", description: "Ribbed hardhat and safety glasses" },
  { id: "baseball", label: "Slugger", description: "Baseball cap and sporting frames" },
  { id: "medic", label: "Medic", description: "Surgical cap, mask, and stethoscope" },
  { id: "explorer", label: "Explorer", description: "Wide-brimmed field hat and round spectacles" },
] as const).map(style => Object.freeze(style)));

export type AvatarId = (typeof AVATAR_STYLES)[number]["id"];

// Stable across machines, reloads, and a change to the bot's display name.
export function avatarForBot(id?: unknown, explicit?: string): AvatarId {
  const selected = AVATAR_STYLES.find(style => style.id === explicit);
  if (selected) return selected.id;
  let hash = 2166136261;
  for (const code of String(id ?? "").slice(0, 4096)) hash = Math.imul(hash ^ code.codePointAt(0)!, 16777619);
  return AVATAR_STYLES[(hash >>> 0) % AVATAR_STYLES.length].id;
}

export const AVATAR_STATES = Object.freeze({
  ready: "Ready", working: "Working", thinking: "Thinking", responding: "Replying",
  presenting: "Showing a file", tool: "Running a tool", journaling: "Writing notes",
  autonomy: "Autonomy work", approval: "Waiting for approval", error: "Needs attention",
});

export type AvatarPhase = keyof typeof AVATAR_STATES;

export function isAvatarPhase(value: string): value is AvatarPhase {
  return Object.hasOwn(AVATAR_STATES, value);
}

// These are expressions of reported activity, not an inferred feeling or mood.
export const AVATAR_BROWS = Object.freeze({
  ready: ["M39 64 Q47 60 56 63", "M72 63 Q81 60 89 64"],
  working: ["M40 59 L56 65", "M72 65 L88 59"],
  thinking: ["M39 63 L56 65", "M72 58 Q81 54 89 57"],
  responding: ["M39 61 Q47 58 56 62", "M72 62 Q81 58 89 61"],
  presenting: ["M39 60 Q47 56 56 61", "M72 60 Q81 56 89 61"],
  tool: ["M40 60 L56 65", "M72 65 L88 60"],
  journaling: ["M39 63 L56 66", "M72 66 L89 63"],
  autonomy: ["M40 59 L56 64", "M72 64 L88 59"],
  approval: ["M39 59 Q47 55 56 59", "M72 65 L89 63"],
  error: ["M39 64 L56 59", "M72 59 L89 64"],
} as const satisfies Record<AvatarPhase, readonly [string, string]>);
