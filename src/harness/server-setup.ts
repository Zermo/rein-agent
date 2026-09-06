/** Read-only guidance shared by the installer and model listing. */
import type { ServerDiscoveryReport } from "../ai/discovery.ts";

export function printDiscoverySummary(report: ServerDiscoveryReport, log: (text: string) => void = console.log): void {
	log(`Discovery: ${report.servers.length} reachable server(s), ${report.scanned}/${report.candidateCount} endpoints checked${report.timedOut ? "; time limit reached" : ""}${report.truncated ? "; candidate limit reached" : ""}.`);
	if (report.network) {
		const peers = report.sources.filter(s => ["neighbors", "netbird", "tailscale"].includes(s.source));
		for (const source of peers) log(`  ${source.source}: ${source.status === "ok" ? `${source.peers} known peer(s)` : source.status}`);
		log("Known peers only; this does not sweep a subnet. An unknown host or unusual port may need its URL entered manually.");
	}
	for (const result of report.results.filter(r => ["configured", "environment", "explicit"].includes(r.source) && !["ready", "auth-required", "no-models"].includes(r.status))) {
		log(`  ${result.baseUrl}: ${result.status}${result.error ? ` — ${result.error}` : ""}`);
	}
	if (!report.servers.length) log("No model API found. Start a server, choose hosting recipes, or enter its host and port. A remote loopback-only server needs an SSH connection.");
	else log("ready = models listed; auth-required = key needed; no-models = server reachable, load a model. Setup tests a chat reply before saving an HTTP connection.");
}

export async function printServingAdvice(detailed = false, log: (text: string) => void = console.log): Promise<void> {
	try {
		const { readOperatorProfile } = await import("./operator-profile.ts");
		const focus = readOperatorProfile().profile?.operator_profile.focus;
		if (detailed) {
			const { printHardwareReport } = await import("../hardware/report.ts");
			await printHardwareReport({ log, focus });
			return;
		}
		const { profileHardware, summarizeHardware } = await import("../hardware/profile.ts");
		const { servingRecommendations } = await import("../hardware/recipes.ts");
		const hardware = await profileHardware();
		const advice = servingRecommendations(hardware, { focus });
		log(`\nThis machine: ${summarizeHardware(hardware)}`);
		if (advice.best) log(`Suggested local model: ${advice.best.model.name} — ${advice.best.reason}`);
		else log("No catalog model has comfortable headroom on this machine right now. A remote server or cloud connection is available below.");
		log(`Fit estimates use ${advice.contextTokens.toLocaleString()} context tokens. Run rein hardware for memory assumptions and serving recipes.`);
		log("For a remote model host, run rein hardware on that host. This gateway's memory does not describe the remote server.\n");
	} catch (error) {
		log(`Hardware advice unavailable: ${(error as Error).message}. You can still connect a server or cloud account.`);
	}
}
