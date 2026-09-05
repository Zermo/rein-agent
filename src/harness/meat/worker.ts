/** Isolated Go/WASM runtime. Model/network/file work stays in the Rein host. */
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const host = globalThis as any;
host.crypto ??= webcrypto;
const pending = new Map<number, (value: string, error: string) => void>();
let sequence = 0;
host.reinMeatRequest = (kind: string, payload: string, callback: (value: string, error: string) => void) => {
	const id = ++sequence; pending.set(id, callback);
	parentPort!.postMessage({ type: "request", id, kind, payload: JSON.parse(payload) });
};
host.reinMeatDone = (value: string, error: string) => parentPort!.postMessage({ type: "done", result: value ? JSON.parse(value) : undefined, error });
host.reinMeatProgress = (text: string) => parentPort!.postMessage({ type: "progress", text });
parentPort!.on("message", reply => {
	const callback = pending.get(reply.id);
	if (!callback) return;
	pending.delete(reply.id); callback(reply.value ?? "", reply.error ?? "");
});

try {
	await import(pathToFileURL(join(workerData.vendor, "wasm_exec.cjs")).href);
	const go = new host.Go();
	const bytes = gunzipSync(readFileSync(join(workerData.vendor, "meat.wasm.gz")));
	const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
	void go.run(instance).catch((error: Error) => parentPort!.postMessage({ type: "done", error: error.message }));
	host.reinMeatStart(JSON.stringify(workerData.input));
} catch (error) { parentPort!.postMessage({ type: "done", error: (error as Error).message }); }
