/** Device-local first-run gates. No tokens. Survives app relaunch in the same WebView origin. */

export const SETUP_PROFILE_KEY = "rein.klaud.setup-profile";
export const SETUP_SEEN_KEY = "rein.klaud.setup-seen";
export const ACCOUNT_READY_KEY = "rein.klaud.account-ready";

export function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeLocal(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private / locked storage */ }
}

export function accountIsReady(): boolean {
  return readLocal(ACCOUNT_READY_KEY) === "1";
}

export function markAccountReady(): void {
  writeLocal(ACCOUNT_READY_KEY, "1");
}

export function setupIsSeen(): boolean {
  return readLocal(SETUP_SEEN_KEY) === "1" || Boolean(readLocal(SETUP_PROFILE_KEY));
}

export function markSetupSeen(): void {
  writeLocal(SETUP_SEEN_KEY, "1");
}

/** Auto-open assisted setup only for a brand-new console with no units yet. */
export function shouldAutoOpenSetup(botCount: number): boolean {
  if (setupIsSeen()) return false;
  if (botCount > 0) {
    markSetupSeen();
    markAccountReady();
    return false;
  }
  return true;
}
