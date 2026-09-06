import type { AssistantMessageEvent } from "./types.ts";
import type { JsonPatchOp, KlaudSharedState } from "../harness/klaud/shell.ts";

export type AgUiEvent = {
	type: string;
	timestamp?: number;
	[key: string]: unknown;
};

export function toAgUiEvents(
	event: AssistantMessageEvent,
	ids: { threadId: string; runId: string },
): AgUiEvent[] {
	switch (event.type) {
		// Serve owns the run start; thinking is never part of the UI stream.
		case "start":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
			return [];
		case "text_start":
			return [{ type: "TEXT_MESSAGE_START", messageId: `${ids.runId}:${event.contentIndex}`, role: "assistant" }];
		case "text_delta":
			return [{ type: "TEXT_MESSAGE_CONTENT", messageId: `${ids.runId}:${event.contentIndex}`, delta: event.delta }];
		case "text_end":
			return [{ type: "TEXT_MESSAGE_END", messageId: `${ids.runId}:${event.contentIndex}` }];
		case "toolcall_start": {
			const call = event.partial.content[event.contentIndex];
			return call?.type === "toolCall"
				? [{ type: "TOOL_CALL_START", toolCallId: call.id, toolCallName: call.name }]
				: [];
		}
		case "toolcall_end":
			return [
				{ type: "TOOL_CALL_ARGS", toolCallId: event.toolCall.id, delta: JSON.stringify(event.toolCall.arguments) },
				{ type: "TOOL_CALL_END", toolCallId: event.toolCall.id },
			];
		case "done":
			return [{ type: "RUN_FINISHED", threadId: ids.threadId, runId: ids.runId, outcome: { type: "success" } }];
		case "error":
			return [{ type: "RUN_ERROR", message: event.error.errorMessage || "aborted" }];
	}
}

export function stateSnapshot(state: KlaudSharedState): AgUiEvent {
	return { type: "STATE_SNAPSHOT", snapshot: state };
}

export function stateDelta(patch: JsonPatchOp[]): AgUiEvent {
	// Shell tools use shell-relative paths; AG-UI patches the shared document.
	return { type: "STATE_DELTA", delta: patch.map(op => ({ ...op, path: `/shell${op.path}` })) };
}
