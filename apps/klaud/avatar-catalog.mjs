export const AVATAR_STYLES = Object.freeze([
  { id: "aviator", label: "Aviator", description: "Leather flying cap and round flight goggles" },
  { id: "motorcycle", label: "Rider", description: "Motorcycle helmet and an open visor" },
  { id: "builder", label: "Builder", description: "Ribbed hardhat and safety glasses" },
  { id: "baseball", label: "Slugger", description: "Baseball cap and sporting frames" },
  { id: "medic", label: "Medic", description: "Surgical cap, mask, and stethoscope" },
  { id: "explorer", label: "Explorer", description: "Wide-brimmed field hat and round spectacles" },
].map(style => Object.freeze(style)));

// Stable across machines, reloads, and a change to the bot's display name.
export function avatarForBot(id, explicit) {
  if (AVATAR_STYLES.some(style => style.id === explicit)) return explicit;
  let hash = 2166136261;
  for (const code of String(id ?? "").slice(0, 4096)) hash = Math.imul(hash ^ code.codePointAt(0), 16777619);
  return AVATAR_STYLES[(hash >>> 0) % AVATAR_STYLES.length].id;
}

export const AVATAR_STATES = Object.freeze({
  ready: "Ready", working: "Working", thinking: "Thinking", responding: "Replying",
  tool: "Running a tool", journaling: "Writing notes", autonomy: "Autonomy work",
  approval: "Waiting for approval", error: "Needs attention",
});

// These are expressions of reported activity, not an inferred feeling or mood.
export const AVATAR_BROWS = Object.freeze({
  ready: ["M39 64 Q47 60 56 63", "M72 63 Q81 60 89 64"],
  working: ["M39 62 L56 65", "M72 65 L89 62"],
  thinking: ["M39 64 L56 65", "M72 59 Q81 55 89 58"],
  responding: ["M39 61 Q47 57 56 61", "M72 61 Q81 57 89 61"],
  tool: ["M39 62 L56 65", "M72 65 L89 62"],
  journaling: ["M39 65 L56 66", "M72 66 L89 65"],
  autonomy: ["M39 62 Q47 59 56 62", "M72 62 Q81 59 89 62"],
  approval: ["M39 59 Q47 55 56 59", "M72 65 L89 63"],
  error: ["M39 64 L56 59", "M72 59 L89 64"],
});
