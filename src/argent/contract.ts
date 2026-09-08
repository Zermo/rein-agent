/** Argent device-provider contract, rebuilt from @swmansion/argent schema v1 (frozen). */
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const EXTERNAL_PREFIX = "ext:";
export const PROVIDER_SCHEMA_VERSION = 1;
export const PROVIDER_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SAFE_NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const IOS_UDID_SHAPE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const IOS_PHYSICAL_UDID_SHAPE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/;

export function isIosPhysicalUdid(udid: string): boolean {
	return IOS_PHYSICAL_UDID_SHAPE.test(udid);
}

/** Which platform a native id belongs to, decided by shape alone (Argent's one classifier). */
export function nativeIdPlatform(nativeId: string): "android" | "ios" {
	return IOS_UDID_SHAPE.test(nativeId) || isIosPhysicalUdid(nativeId) ? "ios" : "android";
}

export function makeExternalId(providerId: string, nativeId: string): string {
	if (!PROVIDER_ID_SHAPE.test(providerId)) throw new Error("Provider ids are lowercase slugs of at most 32 characters.");
	if (!SAFE_NATIVE_ID.test(nativeId)) throw new Error("Native ids must be conservative argv-safe identifiers.");
	return `${EXTERNAL_PREFIX}${providerId}:${nativeId}`;
}

export type DevicePlatform = "ios" | "android" | "tv" | "desktop" | "terminal";

export interface DeviceDescriptor {
	id: string;
	platform: DevicePlatform;
	capabilities: string[];
}

export interface ProviderFile {
	schemaVersion: number;
	providerId: string;
	devices: DeviceDescriptor[];
}

export type ProviderValidation = { ok: true; file: ProviderFile } | { ok: false; error: string };

/** Validate a provider document. Unknown fields and capability tokens are ignored by design (v1 rule). */
export function validateProviderFile(value: unknown): ProviderValidation {
	if (typeof value !== "object" || value === null) return { ok: false, error: "Provider file must be a JSON object." };
	const file = value as Record<string, unknown>;
	if (file.schemaVersion !== PROVIDER_SCHEMA_VERSION) return { ok: false, error: `schemaVersion must be ${PROVIDER_SCHEMA_VERSION}.` };
	if (typeof file.providerId !== "string" || !PROVIDER_ID_SHAPE.test(file.providerId)) return { ok: false, error: "providerId must be a lowercase slug of at most 32 characters." };
	if (!Array.isArray(file.devices)) return { ok: false, error: "devices must be an array." };
	const devices: DeviceDescriptor[] = [];
	for (const entry of file.devices) {
		if (typeof entry !== "object" || entry === null) return { ok: false, error: "Each device must be an object." };
		const device = entry as Record<string, unknown>;
		if (typeof device.id !== "string" || !device.id || device.id.length > 256) return { ok: false, error: "Each device needs a nonempty id." };
		if (typeof device.platform !== "string" || !["ios", "android", "tv", "desktop"].includes(device.platform)) return { ok: false, error: `Device platform must be ios, android, tv, or desktop (got: ${String(device.platform)}).` };
		if (!Array.isArray(device.capabilities)) return { ok: false, error: "A device without a capabilities array is rejected outright (v1 rule)." };
		devices.push({ id: device.id, platform: device.platform as DeviceDescriptor["platform"], capabilities: device.capabilities.filter((capability): capability is string => typeof capability === "string") });
	}
	return { ok: true, file: { schemaVersion: PROVIDER_SCHEMA_VERSION, providerId: file.providerId, devices } };
}

export interface ExternalProvider {
	path: string;
	file: ProviderFile;
}

/**
 * Discover external providers in a directory. Degrades to "no external devices"
 * on any malformed, stale, or hostile file — one stderr line at most, never a throw.
 */
export async function readProviders(dir: string, stderr: (text: string) => void = () => {}): Promise<ExternalProvider[]> {
	const root = resolve(dir);
	const found: ExternalProvider[] = [];
	const { readdir } = await import("node:fs/promises");
	try {
		const names = await readdir(root);
		for (const name of names.sort()) {
			if (!name.toLowerCase().endsWith(".json")) continue;
			const path = join(root, name);
			try {
				const stat = await lstat(path);
				if (!stat.isFile() || stat.isSymbolicLink()) continue;
				const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
				const result = validateProviderFile(parsed);
				if (result.ok) found.push({ path, file: result.file });
				else stderr(`argent: external provider ${name} ignored: ${result.error}`);
			} catch (error) {
				stderr(`argent: external provider ${name} ignored: ${(error as Error).message}`);
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") stderr(`argent: provider directory unreadable: ${(error as Error).message}`);
	}
	return found;
}
