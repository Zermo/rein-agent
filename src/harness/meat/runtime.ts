import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = [resolve(here, "../../.."), resolve(here, "..")].find(path => existsSync(resolve(path, "vendor/meat/meat.wasm.gz")));
export interface MeatResult { smart_diff: string; summary: string; input_tokens: number; output_tokens: number; }
export interface MeatRuntimeOptions {
	diff: string; cwd?: string; maxTurns?: number; chunkBytes?: number; signal?: AbortSignal;
	onProgress?: (text: string) => void;
	request(kind: "generate" | "read", payload: any): Promise<unknown>;
}
export async function runMeatEngine(options: MeatRuntimeOptions): Promise<MeatResult> {
	options.signal?.throwIfAborted();
	if (!root) throw new Error("The embedded Meat runtime is missing. Reinstall the complete Rein package.");
	const workerPath = existsSync(resolve(here, "worker.ts")) ? resolve(here, "worker.ts") : resolve(here, "meat-worker.js");
	const worker = new Worker(workerPath, { workerData: { vendor: resolve(root, "vendor/meat"), input: { Diff: options.diff, Root: options.cwd ?? "", MaxTurns: options.maxTurns ?? 8, ChunkBytes: options.chunkBytes ?? 24000 } }, execArgv: [] });
	return await new Promise<MeatResult>((resolveResult, reject) => {
		let done = false;
		const finish = (error?: Error, result?: MeatResult) => {
			if (done) return; done = true;
			clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
			void worker.terminate();
			if (error) reject(error); else resolveResult(result!);
		};
		const abort = () => finish(new Error("Meat review cancelled."));
		const timer = setTimeout(() => finish(new Error("Meat review exceeded its five-minute budget.")), 300_000);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		worker.on("error", error => finish(error));
		worker.on("exit", code => { if (!done) finish(new Error(`Meat runtime exited before returning a result (${code}).`)); });
		worker.on("message", async message => {
			if (done) return;
			if (message.type === "progress") { try { options.onProgress?.(message.text); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); } return; }
			if (message.type === "done") { finish(message.error ? new Error(message.error) : undefined, message.result); return; }
			if (message.type === "request") {
				try {
					const response = await options.request(message.kind, message.payload);
					if (!done) worker.postMessage({ id: message.id, value: typeof response === "string" ? response : JSON.stringify(response) });
				} catch (error) { if (!done) worker.postMessage({ id: message.id, error: (error as Error).message }); }
			}
		});
	});
}
