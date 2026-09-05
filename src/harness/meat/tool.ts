import type { AgentTool } from "../../agent/agent-loop.ts";
import type { RunnerOptions } from "../runner.ts";
import { truncateTail } from "../../../vendor/fold/Truncation.ts";

export function createMeatTool(cwd: string, connection: () => Partial<RunnerOptions> = () => ({})): AgentTool {
	return { name: "meat", executionMode: "sequential", description: "Review a Git diff using the embedded Meat engine and configured model. It validates a remove/replace/fold edit plan against immutable source, producing a reading diff, never an applicable patch. Defaults to the latest commit. Set workingTree or staged for uncommitted tracked changes. Uses up to 32 model requests, without modifying workspace files.",
		parameters: { type: "object", properties: { refs: { type: "array", items: { type: "string" } }, staged: { type: "boolean" }, workingTree: { type: "boolean" } } },
		async execute(_id, args, signal, onUpdate) {
			try {
				const { runMeatReview } = await import("./review.ts");
				const result = await runMeatReview({ ...connection(), cwd, refs: args.refs as string[] | undefined, staged: args.staged === true, workingTree: args.workingTree === true, signal, onProgress: onUpdate });
				const output = truncateTail(result.smart_diff, { maxLines: 500, maxBytes: 20000 });
				return { content: `${result.summary}\nReading diff, not an applicable patch:\n${output.truncated ? "[truncated]\n" : ""}${output.content}`, details: { inputTokens: result.input_tokens, outputTokens: result.output_tokens } };
			} catch (error) { return { content: (error as Error).message, isError: true }; }
		},
	};
}
