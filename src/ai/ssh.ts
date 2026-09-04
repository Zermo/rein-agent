import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";

export interface TunnelOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Injection for process-level tests; never read from user config. */
	spawnSsh?: (args: string[]) => ChildProcess;
}

export function validateSshHost(host: string): void {
	if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]*$/.test(host)) {
		throw new Error("SSH host must be an SSH config alias or user@hostname, without spaces or command options.");
	}
}

export function sshArguments(host: string, baseUrl: string, localPort: number): string[] {
	validateSshHost(host);
	const url = new URL(baseUrl);
	if (url.protocol !== "http:" || url.username || url.password) throw new Error("SSH forwarding requires an http:// API URL without embedded credentials.");
	return ["-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10",
		"-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "PermitLocalCommand=no",
		"-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-L",
		`127.0.0.1:${localPort}:${url.hostname}:${url.port || "80"}`, "--", host];
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}

function portReady(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = createConnection({ host: "127.0.0.1", port });
		let done = false;
		const finish = (ready: boolean) => { if (done) return; done = true; socket.destroy(); resolve(ready); };
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.setTimeout(100, () => finish(false));
	});
}

/** A request-scoped tunnel: no daemon, credential copying, or remote listener changes. */
export async function withSshTunnel<T>(baseUrl: string, sshHost: string | undefined, use: (forwardedBaseUrl: string) => Promise<T>, options: TunnelOptions = {}): Promise<T> {
	if (!sshHost) return use(baseUrl);
	validateSshHost(sshHost);
	if (options.signal?.aborted) throw new DOMException("SSH connection aborted", "AbortError");
	const port = await unusedPort();
	const args = sshArguments(sshHost, baseUrl, port);
	const child = options.spawnSsh ? options.spawnSsh(args) : spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
	let failure: Error | undefined;
	let closed = false;
	let stderr = "";
	const exited = new Promise<void>(resolve => {
		child.once("error", error => { failure = error; closed = true; resolve(); });
		child.once("close", code => { closed = true; failure ??= new Error(`SSH exited (${code ?? "signal"}). ${stderr.trim()}`); resolve(); });
	});
	child.stderr?.on("data", chunk => { if (stderr.length < 2000) stderr += String(chunk).slice(0, 2000 - stderr.length); });
	const abort = () => { child.kill("SIGTERM"); };
	options.signal?.addEventListener("abort", abort, { once: true });
	process.once("exit", abort);
	try {
		const deadline = Date.now() + (options.timeoutMs ?? 12_000);
		while (true) {
			if (options.signal?.aborted) throw new DOMException("SSH connection aborted", "AbortError");
			if (failure) throw new Error(`Cannot open SSH tunnel through ${sshHost}: ${failure.message}. Check that ssh ${sshHost} works with key authentication.`);
			if (Date.now() >= deadline) throw new Error(`SSH tunnel through ${sshHost} timed out. Check the VPN and SSH connection.`);
			if (await portReady(port)) break;
			await new Promise(resolve => setTimeout(resolve, 40));
		}
		const forwarded = new URL(baseUrl);
		forwarded.hostname = "127.0.0.1";
		forwarded.port = String(port);
		return await use(forwarded.href.replace(/\/$/, ""));
	} finally {
		options.signal?.removeEventListener("abort", abort);
		process.removeListener("exit", abort);
		if (!closed) {
			child.kill("SIGTERM");
			const hardKill = setTimeout(() => child.kill("SIGKILL"), 500);
			await exited;
			clearTimeout(hardKill);
		}
	}
}
