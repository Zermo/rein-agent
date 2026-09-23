/** An answer to the agent's own question continues that task. */
export function askedForFact(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.endsWith("?") && trimmed.length > 1;
}

export function lastAssistantText(messages: { role: string; content: unknown }[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		return message.content
			.filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: string }).text === "string")
			.map(part => part.text)
			.join("\n")
			.trim();
	}
	return "";
}

export function continueAsked(previous: string, answer: string): string {
	if (!askedForFact(previous)) return answer;
	return `This answers the question you just asked. Continue that task with it. Do not file it as a new account, and do not ask what to do with it. If they changed the task, follow the change.\n\n${answer}`;
}
