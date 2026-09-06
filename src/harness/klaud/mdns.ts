/** Best-effort Bonjour/Avahi publication for an explicitly enabled mobile gateway. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";

export interface MobileAdvertisement {
	name: "rein-klaʊd";
	serviceType: "_rein-klaud._tcp";
	domain: "local";
	host: string;
	port: number;
	txt: { path: "/v1/mobile"; version: "1" };
}

export interface MobileAdvertisementHandle { close(): void | Promise<void>; }
export type MobileAdvertiser = (service: MobileAdvertisement) => MobileAdvertisementHandle | undefined | Promise<MobileAdvertisementHandle | undefined>;

export function mobileAdvertisementHost(address: string): string {
	return `rein-klaud-${createHash("sha256").update(address).digest("hex").slice(0, 8)}.local`;
}

export function mobileAdvertisementCommands(service: MobileAdvertisement, platform: NodeJS.Platform = process.platform): { command: string; args: string[] }[] | undefined {
	const txt = [`path=${service.txt.path}`, `version=${service.txt.version}`];
	const label = mobileAdvertisementHost(service.host);
	if (platform === "darwin") {
		// Proxy registration pins the advertised address to the same interface the
		// HTTP server actually bound, rather than publishing every address on the Mac.
		return [{ command: "/usr/bin/dns-sd", args: ["-P", service.name, service.serviceType, service.domain, String(service.port), label + ".", service.host, ...txt] }];
	}
	if (platform === "linux") {
		// avahi-publish-address parses addresses with inet_pton(), which cannot
		// carry an IPv6 scope identifier. Keep the reachable explicit URL instead
		// of publishing an SRV target with no usable address record.
		if (service.host.includes("%")) return undefined;
		// Register the exact address record as well as the service. Relying on the
		// daemon's configured machine name can produce a Host value the gateway did
		// not authorize, especially after an mDNS collision rename.
		return [
			{ command: "avahi-publish-address", args: ["-f", label, service.host] },
			{ command: "avahi-publish-service", args: ["-f", "-H", label, service.name, service.serviceType, String(service.port), ...txt] },
		];
	}
	return undefined;
}

/**
 * macOS uses its built-in dns-sd publisher. Linux uses avahi when installed.
 * Unsupported or missing facilities intentionally return no advertisement;
 * discovery must never decide whether the authenticated gateway can start.
 */
export function advertiseMobileGateway(service: MobileAdvertisement): MobileAdvertisementHandle | undefined {
	if (["127.0.0.1", "::1"].includes(service.host.split("%")[0])) return;
	const invocations = mobileAdvertisementCommands(service);
	if (!invocations) return;
	const children = new Set<ChildProcess>();
	try {
		for (const invocation of invocations) {
			const child = spawn(invocation.command, invocation.args, { stdio: "ignore" });
			children.add(child);
			child.once("error", () => children.delete(child));
			child.once("exit", () => children.delete(child));
			child.unref();
		}
	} catch { return; }
	return { close() { for (const child of children) try { child.kill("SIGTERM"); } catch { /* The optional publisher already exited. */ } } };
}
