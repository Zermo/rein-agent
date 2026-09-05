/**
 * One-shot mode: rein -p "query". Prints the final assistant text (or the
 * raw event stream with --json). No REPL, no session unless --save.
 */
import { createSession } from "../agent/session.ts";
import type { AssistantMessage } from "../ai/types.ts";
import { dim, red } from "../util/ansi.ts";
import { createRunner } from "./runner.ts";
import type { RunnerOptions } from "./runner.ts";

export interface PrintOptions extends RunnerOptions {
	query?: string;
	json?: boolean;
	save?: boolean;
	systemPrompt?: string;
}

export async function runPrint(opts: PrintOptions): Promise<number> {
	const query = opts.query ?? "";
	if (!query.trim()) {
		console.error("no query given. Usage: rein -p \"what to do\"");
		return 2;
	}

	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.on("SIGINT", interrupt);
	try {
		const runner = await createRunner(opts);
		if (opts.save) {
			const sessionId = createSession({ model: runner.model.id, provider: runner.model.provider, cwd: opts.cwd });
			runner.setSession(sessionId);
			process.stderr.write(dim(`session ${sessionId}\n`));
		}
		const messages = await runner.run({ role: "user", content: query, timestamp: Date.now() }, {
			signal: controller.signal,
			onEvent: opts.json ? (event) => {
				process.stdout.write(JSON.stringify(event) + "\n");
			} : undefined,
		});
		const last = messages.filter((m) => m.role === "assistant").at(-1) as AssistantMessage | undefined;
		if (!opts.json) {
			const text = last?.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
			if (text) console.log(text);
		}
		if (controller.signal.aborted || last?.stopReason === "aborted") return 130;
		if (last?.stopReason === "error") {
			console.error(red(last.errorMessage ?? "error"));
			return 1;
		}
		if (!last || last.stopReason === "length" || last.stopReason === "toolUse") {
			console.error(red("The response ended before completion. Work may be incomplete; check the output budget and last results."));
			return 1;
		}
		return 0;
	} catch (err) {
		console.error(red((err as Error).message));
		return controller.signal.aborted ? 130 : 1;
	} finally {
		process.off("SIGINT", interrupt);
	}
}
