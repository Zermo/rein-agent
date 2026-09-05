import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readActivity, activityFile } from "./store.ts";
import { canvasPage } from "./page.ts";

export function openCanvas(url: string) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
	const child = spawn(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url], { stdio: "ignore", detached: true, shell: false });
	child.on("error", () => {}); child.unref();
}
export async function startCanvas(id: string) {
	activityFile(id);
	const token = randomBytes(24).toString("hex"), nonce = randomBytes(18).toString("base64");
	let origin = "";
	const server = createServer((req, res) => {
		res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("Referrer-Policy", "no-referrer");
		if (req.headers.host !== origin.slice(7) || req.headers.origin && req.headers.origin !== origin) { res.writeHead(403).end(); return; }
		if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }).end(); return; }
		if (req.url === "/") {
			res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`);
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(canvasPage.replace("REIN_NONCE", nonce)); return;
		}
		if (req.url === "/events") {
			if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
			try { const body = JSON.stringify(readActivity(id) ?? null); res.writeHead(200, { "Content-Type": "application/json" }).end(body); }
			catch { res.writeHead(500).end("Activity could not be read."); }
			return;
		}
		res.writeHead(404).end();
	});
	server.requestTimeout = 5000; server.headersTimeout = 5000;
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	return { url: `${origin}/#${token}`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
