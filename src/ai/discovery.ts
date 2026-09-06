/** Bounded model-list probes of configured endpoints and known LAN/mesh peers. */
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { detectEndpoint, normalizeBaseUrl, type DetectedEndpoint } from "./endpoints.ts";

export type DiscoverySource = "configured" | "environment" | "localhost" | "explicit" | "tailscale" | "netbird" | "neighbors";
export type DiscoveryStatus = "ready" | "auth-required" | "no-models" | "unreachable" | "incompatible" | "error" | "skipped";
export interface DiscoveryEndpoint {
	baseUrl: string;
	provider?: string;
	sshHost?: string;
	source: DiscoverySource;
	/** Only supplied for an exact configured endpoint, never inherited by peers. */
	apiKey?: string;
}
export interface DiscoveredServer {
	provider: string;
	baseUrl: string;
	modelsEndpoint: string;
	models: string[];
	sshHost?: string;
	source: DiscoverySource;
	status: DiscoveryStatus;
	error?: string;
}
export interface DiscoverySourceResult { source: DiscoverySource; status: "ok" | "unavailable" | "error"; peers: number; detail?: string; }
export interface ServerDiscoveryReport {
	servers: DiscoveredServer[];
	results: DiscoveredServer[];
	sources: DiscoverySourceResult[];
	scanned: number;
	candidateCount: number;
	truncated: boolean;
	timedOut: boolean;
	network: boolean;
}
export interface DiscoverServersOptions {
	network?: boolean;
	/** Explicit endpoints or hostnames. No range/CIDR expansion is performed. */
	hosts?: string[];
	ports?: number[];
	configured?: DiscoveryEndpoint[];
	timeoutMs?: number;
	budgetMs?: number;
	maxCandidates?: number;
	maxPeers?: number;
	concurrency?: number;
}
export interface DiscoveryDependencies {
	detect?: typeof detectEndpoint;
	platform?: NodeJS.Platform;
	run?: (command: string, args: string[]) => Promise<string>;
	now?: () => number;
}

export const DISCOVERY_PORTS = [11434, 1234, 8080, 8000] as const;
const LIMITS = { peers: 16, candidates: 80, concurrency: 8, timeoutMs: 1200, budgetMs: 10_000 };

/** Neighbor sources must contribute private unicast literals, never public routes. */
export function privatePeerAddress(input: unknown): string | undefined {
	if (typeof input !== "string") return undefined;
	const address = input.replace(/\/\d+$/, "").toLowerCase();
	if (input.includes("/")) {
		const prefix = input.slice(input.lastIndexOf("/") + 1);
		if (!/^\d+$/.test(prefix) || Number(prefix) > (isIP(address) === 4 ? 32 : 128)) return undefined;
	}
	if (isIP(address) === 4) {
		const [a, b, , d] = address.split(".").map(Number);
		// Exclude likely IPv4 network/broadcast entries in ARP output as well as loopback.
		if (d === 0 || d === 255) return undefined;
		if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127) return address;
	}
	if (isIP(address) === 6 && /^(?:fc|fd)/.test(address)) return address;
	return undefined;
}

export function parseTailscalePeers(output: string): string[] {
	const doc = JSON.parse(output);
	if (doc?.BackendState === "Running" && doc.Peer === null) return [];
	if (!doc || typeof doc !== "object" || !doc.Peer || typeof doc.Peer !== "object" || Array.isArray(doc.Peer)) {
		if (doc?.BackendState && doc.BackendState !== "Running") return [];
		throw new Error("Tailscale status did not include a Peer map.");
	}
	return [...new Set(Object.values(doc.Peer).flatMap((peer: any) => peer?.Online === true && Array.isArray(peer.TailscaleIPs)
		? peer.TailscaleIPs.map(privatePeerAddress).filter((ip: unknown): ip is string => typeof ip === "string") : []))] as string[];
}

export function parseNetbirdPeers(output: string): string[] {
	const doc = JSON.parse(output);
	if (doc?.peers?.total === 0 && doc.peers.details === null) return [];
	if (!Array.isArray(doc?.peers?.details)) throw new Error("NetBird status did not include peers.details.");
	return [...new Set(doc.peers.details.flatMap((peer: any) => typeof peer?.status === "string" && peer.status.toLowerCase() === "connected"
		? [privatePeerAddress(peer.netbirdIp), privatePeerAddress(peer.netbirdIpv6)].filter((ip): ip is string => !!ip) : []))] as string[];
}

export function parseNeighborPeers(output: string): string[] {
	const ips: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (/\b(?:FAILED|INCOMPLETE|incomplete|Unreachable)\b/.test(line)) continue;
		// macOS/Windows arp -an/-a and Linux ip neighbor share literal IPv4 entries.
		for (const match of line.matchAll(/(?:^|[\s(])((?:\d{1,3}\.){3}\d{1,3})(?=[\s)]|$)/g)) {
			const ip = privatePeerAddress(match[1]);
			if (ip) ips.push(ip);
		}
	}
	return [...new Set(ips)];
}

function parseLinuxNeighbors(output: string): string[] {
	const doc = JSON.parse(output);
	if (!Array.isArray(doc)) throw new Error("IP neighbor status was not an array.");
	return [...new Set(doc.flatMap(row => {
		const state = Array.isArray(row?.state) ? row.state.join(" ") : String(row?.state ?? "");
		if (/FAILED|INCOMPLETE/i.test(state)) return [];
		const address = privatePeerAddress(row?.dst);
		return address ? [address] : [];
	}))];
}

function commandOutput(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => execFile(command, args, { encoding: "utf8", timeout: 1200, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function knownPeers(dependencies: DiscoveryDependencies): Promise<{ peers: { host: string; source: DiscoverySource }[]; sources: DiscoverySourceResult[] }> {
	const platform = dependencies.platform ?? process.platform;
	const run = dependencies.run ?? commandOutput;
	const commands: { source: DiscoverySource; command: string; args: string[]; parse: (output: string) => string[] }[] = [
		{ source: "tailscale", command: "tailscale", args: ["status", "--json"], parse: parseTailscalePeers },
		{ source: "netbird", command: "netbird", args: ["status", "--json"], parse: parseNetbirdPeers },
		platform === "linux" ? { source: "neighbors", command: "ip", args: ["-j", "neighbor", "show"], parse: parseLinuxNeighbors }
			: { source: "neighbors", command: "arp", args: platform === "win32" ? ["-a"] : ["-an"], parse: parseNeighborPeers },
	];
	const results = await Promise.all(commands.map(async command => {
		try {
			const peers = command.parse(await run(command.command, command.args));
			return { peers: peers.map(host => ({ host, source: command.source })), source: { source: command.source, status: "ok", peers: peers.length } as DiscoverySourceResult };
		} catch (error) {
			const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
			return { peers: [], source: { source: command.source, status: missing ? "unavailable" : "error", peers: 0,
				detail: missing ? `${command.command} is not installed or is not on PATH.` : `${command.command} status could not be read. Check that it is running and accessible to this account.` } as DiscoverySourceResult };
		}
	}));
	return { peers: results.flatMap(result => result.peers), sources: results.map(result => result.source) };
}

function limit(value: number | undefined, fallback: number, maximum = fallback): number {
	return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;
}
function endpointStatus(result: DetectedEndpoint): DiscoveryStatus {
	if (result.status) return result.status;
	if (result.models.length) return "ready";
	if (/Authentication .*HTTP (401|403)/.test(result.error ?? "")) return "auth-required";
	if (/API is reachable but has no available models/.test(result.error ?? "")) return "no-models";
	if (/Connection refused|Could not connect|could not be resolved|timed out|Cannot open SSH tunnel/i.test(result.error ?? "")) return "unreachable";
	return "incompatible";
}

/** Network mode reads existing peer tables, then performs only bounded model-list GETs. */
export async function discoverServers(options: DiscoverServersOptions = {}, dependencies: DiscoveryDependencies = {}): Promise<ServerDiscoveryReport> {
	const now = dependencies.now ?? Date.now;
	const started = now();
	const deadline = started + limit(options.budgetMs, LIMITS.budgetMs);
	const detect = dependencies.detect ?? detectEndpoint;
	const maxCandidates = limit(options.maxCandidates, LIMITS.candidates);
	const maxPeers = limit(options.maxPeers, LIMITS.peers);
	const candidates: DiscoveryEndpoint[] = [];
	const seen = new Set<string>();
	const sources: DiscoverySourceResult[] = [];
	let truncated = false;
	const add = (candidate: DiscoveryEndpoint) => {
		let baseUrl: string;
		try { baseUrl = normalizeBaseUrl(candidate.baseUrl, candidate.provider); } catch { return; }
		const key = `${candidate.sshHost ?? ""}\n${baseUrl}`;
		if (seen.has(key)) return;
		seen.add(key);
		if (candidates.length >= maxCandidates) { truncated = true; return; }
		candidates.push({ ...candidate, baseUrl });
	};
	for (const candidate of options.configured ?? []) add(candidate);
	const allPorts = [...new Set([...DISCOVERY_PORTS, ...(options.ports ?? []).filter(port => Number.isInteger(port) && port >= 1 && port <= 65535),
		...(options.configured ?? []).flatMap(endpoint => { try { const port = Number(new URL(normalizeBaseUrl(endpoint.baseUrl)).port); return port ? [port] : []; } catch { return []; } })])];
	const ports = allPorts.slice(0, 8);
	if (allPorts.length > ports.length) truncated = true;
	for (const port of ports) add({ baseUrl: `http://localhost:${port}/v1`, source: "localhost", provider: "openai-compatible" });
	const peers: { host: string; source: DiscoverySource }[] = (options.hosts ?? []).slice(0, maxPeers).map(host => ({ host, source: "explicit" }));
	if ((options.hosts?.length ?? 0) > maxPeers) truncated = true;
	if (options.network) {
		const known = await knownPeers(dependencies);
		peers.push(...known.peers);
		sources.push(...known.sources);
	}
	const peerHosts = new Set<string>();
	for (const peer of peers) {
		if (peerHosts.has(peer.host)) continue;
		if (peerHosts.size >= maxPeers) { truncated = true; break; }
		peerHosts.add(peer.host);
		// Explicit URLs retain their protocol, port and path; a hostname gets known ports.
		if (peer.source === "explicit" && !isIP(peer.host) && (/^https?:\/\//i.test(peer.host) || /:\d+(?:\/|$)/.test(peer.host))) {
			add({ baseUrl: peer.host, source: peer.source, provider: "openai-compatible" });
			continue;
		}
		const host = isIP(peer.host) === 6 ? `[${peer.host}]` : peer.host;
		if (!host || /[\s/@?#]/.test(host) || host.startsWith("-")) continue;
		for (const port of ports) add({ baseUrl: `http://${host}:${port}/v1`, source: peer.source, provider: "openai-compatible" });
	}
	const results: DiscoveredServer[] = new Array(candidates.length);
	let next = 0;
	let scanned = 0;
	let timedOut = false;
	await Promise.all(Array.from({ length: Math.min(limit(options.concurrency, LIMITS.concurrency), candidates.length) }, async () => {
		while (next < candidates.length) {
			const index = next++;
			const candidate = candidates[index];
			const remaining = deadline - now();
			const base = { provider: candidate.provider ?? "openai-compatible", baseUrl: candidate.baseUrl, modelsEndpoint: `${candidate.baseUrl.replace(/\/$/, "")}/models`, models: [], source: candidate.source, ...(candidate.sshHost ? { sshHost: candidate.sshHost } : {}) };
			if (remaining <= 0) { timedOut = true; results[index] = { ...base, status: "skipped", error: "Discovery time budget reached; this endpoint was not checked." }; continue; }
			scanned++;
			try {
				const detected = await detect(candidate.baseUrl, { provider: candidate.provider ?? "openai-compatible", apiKey: candidate.apiKey, sshHost: candidate.sshHost, timeoutMs: Math.min(remaining, limit(options.timeoutMs, LIMITS.timeoutMs, 2500)) });
				results[index] = { ...base, ...detected, modelsEndpoint: `${detected.baseUrl.replace(/\/$/, "")}/models`, status: endpointStatus(detected) };
			} catch { results[index] = { ...base, status: "error", error: "Endpoint probe failed. Enter the API URL manually to check its configuration." }; }
		}
	}));
	return { servers: results.filter(result => ["ready", "auth-required", "no-models"].includes(result.status)), results, sources, scanned, candidateCount: candidates.length, truncated, timedOut, network: !!options.network };
}
