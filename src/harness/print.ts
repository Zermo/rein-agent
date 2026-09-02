/**
 * One-shot mode: rein -p "query". Prints the final assistant text (or the
 * raw event stream with --json). No REPL, no session unless --save.
 */
import { appendEntries, createSession } from "../agent/session.ts";
import { dim, red, yellow } from "../util/ansi.ts";
import { createRunner } from "./runner.ts";
import type { RunnerOptions } from "./runner.ts";

export interface PrintOptions extends RunnerOptions {
	query?: string;
	json?: boolean;
	save?: boolean;
	systemPrompt?: string;
}

export async function runPrint(opts: PrintOptions): Promise<number> {
	const query = opts.query ?? process.argv.find((a) => a.length > 1 && !a.startsWith("-")) ?? "";
	if (!query) {
		console.error("no query given. Usage: rein -p \"what to do\"");
		return 2;
	}

	const runner = await createRunner(opts);

	if (opts.json) {
		// Raw event protocol — scriptable.
		const out = runner.run.bind(runner);
		runner.run = (prompt, runOpts) =>
			out(prompt, runOpts).then((messages) => {
				for (const m of messages) {
					process.stdout.write(JSON.stringify({ event: "message", message: m }) + "\n");
				}
				return messages;
			});
	}

	let exitCode = 0;
	try {
		const messages = await runner.run({ role: "user", content: query, timestamp: Date.now() });
		if (opts.save) {
			const sessionId = createSession({ model: runner.model.id, provider: runner.model.provider, cwd: process.cwd() });
			appendEntries(sessionId, messages);
			process.stderr.write(dim(`session ${sessionId}\n`));
		}
		if (!opts.json) {
			const last = messages.filter((m) => m.role === "assistant").at(-1) as import("../ai/types.ts").AssistantMessage | undefined;
			const text = last
				?.content.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join("");
			if (text) console.log(text);
			if (last && last.stopReason === "error") {
				console.error(red(last.errorMessage ?? "error"));
				exitCode = 1;
			}
		}
	} catch (err) {
		console.error(red((err as Error).message));
		exitCode = 1;
	}
	return exitCode;
}
