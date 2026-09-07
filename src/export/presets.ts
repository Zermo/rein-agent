/** Personal data presets for the pre-injection export step. */
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Preset { id: string; label: string; paths: string[] }

export function personalPresets(home: string, platform: string): Preset[] {
	const p = (...sub: string[]) => join(home, ...sub);
	const presets: Preset[] = [
		{ id: "documents", label: "Documents", paths: [p("Documents")] },
		{ id: "desktop", label: "Desktop", paths: [p("Desktop")] },
		{ id: "downloads", label: "Downloads", paths: [p("Downloads")] },
		{ id: "pictures", label: "Pictures", paths: [p("Pictures")] },
		{ id: "movies", label: "Movies and videos", paths: [p("Movies"), p("Videos")] },
		{ id: "music", label: "Music", paths: [p("Music")] },
	];
	if (platform === "darwin") {
		presets.push(
			{ id: "mail", label: "Mail", paths: [p("Library", "Mail"), p("Library", "Mailboxes")] },
			{ id: "keychains", label: "Keychains", paths: [p("Library", "Keychains")] },
			{ id: "browser-profiles", label: "Browser profiles", paths: [
				p("Library", "Application Support", "Google", "Chrome"),
				p("Library", "Application Support", "Firefox"),
				p("Library", "Safari"),
			] },
			{ id: "keys", label: "SSH and GPG keys", paths: [p(".ssh"), p(".gnupg")] },
		);
	}
	if (platform === "win32") {
		presets.push(
			{ id: "browser-profiles", label: "Browser profiles", paths: [
				p("AppData", "Local", "Google", "Chrome", "User Data"),
				p("AppData", "Roaming", "Mozilla", "Profiles"),
				p("AppData", "Roaming", "Microsoft", "Edge", "User Data"),
			] },
			{ id: "keys", label: "SSH and GPG keys", paths: [p(".ssh"), p(".gnupg")] },
		);
	}
	if (platform === "linux") {
		presets.push(
			{ id: "browser-profiles", label: "Browser profiles", paths: [p(".config", "google-chrome"), p(".mozilla")] },
			{ id: "keys", label: "SSH and GPG keys", paths: [p(".ssh"), p(".gnupg")] },
			{ id: "dotfiles", label: "Shell and app config", paths: [p(".config"), p(".zshrc"), p(".bashrc"), p(".vimrc")] },
		);
	}
	return presets;
}

/** ChromeOS reports as linux to Node; os-release is the reliable marker. */
export function isChromeOS(osRelease?: string): boolean {
	return /ID=chromeos/i.test(osRelease ?? "") || /CROS_RELEASE/i.test(osRelease ?? "");
}

/** ChromeOS user data lives under /home/chronos/user/<id>; the user folders are the personal surface. */
export function chromeosPresets(home: string): Preset[] {
	const p = (...sub: string[]) => join(home, ...sub);
	return [
		{ id: "downloads", label: "Downloads", paths: [p("Downloads")] },
		{ id: "documents", label: "Documents", paths: [p("Documents")] },
		{ id: "pictures", label: "Pictures", paths: [p("Pictures")] },
		{ id: "music", label: "Music", paths: [p("Music")] },
		{ id: "movies", label: "Videos", paths: [p("Videos")] },
		{ id: "chrome-profile", label: "Chrome profile", paths: [p(".config", "chromium")] },
		{ id: "keys", label: "SSH and GPG keys", paths: [p(".ssh"), p(".gnupg")] },
	];
}

/** Keep only presets that have at least one existing path; report what was skipped. */
export function filterExisting(presets: Preset[]): { presets: Preset[]; missing: string[] } {
	const missing: string[] = [];
	const kept = presets.map(preset => ({
		...preset,
		paths: preset.paths.filter(path => {
			if (existsSync(path)) return true;
			missing.push(path);
			return false;
		}),
	})).filter(preset => preset.paths.length > 0);
	return { presets: kept, missing };
}
export function existingPresets(home: string, platform: string): { presets: Preset[]; missing: string[] } {
	return filterExisting(personalPresets(home, platform));
}
