export const PHONE_SECTIONS = ["bots", "chat", "crt", "settings"] as const;
export type PhoneSection = typeof PHONE_SECTIONS[number];

export function phoneSection(view: "bots" | "chat" | "settings", railOpen: boolean): PhoneSection {
  if (view === "bots") return "bots";
  if (view === "settings") return "settings";
  return railOpen ? "crt" : "chat";
}

export function phoneNeighbor(section: PhoneSection, dir: -1 | 1): PhoneSection {
  const index = PHONE_SECTIONS.indexOf(section);
  return PHONE_SECTIONS[Math.max(0, Math.min(PHONE_SECTIONS.length - 1, index + dir))];
}

export function applyPhoneSection(section: PhoneSection): { view: "bots" | "chat" | "settings"; railOpen: boolean; railTab?: "crt" } {
  if (section === "bots") return { view: "bots", railOpen: false };
  if (section === "settings") return { view: "settings", railOpen: false };
  if (section === "crt") return { view: "chat", railOpen: true, railTab: "crt" };
  return { view: "chat", railOpen: false };
}
