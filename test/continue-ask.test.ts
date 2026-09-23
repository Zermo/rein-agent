import assert from "node:assert/strict";
import test from "node:test";
import { askedForFact, continueAsked, lastAssistantText } from "../src/harness/continue-ask.ts";

test("an answer to the agent's question continues the task", () => {
	const previous = "What email address is on your Robinhood account?";
	assert.equal(askedForFact(previous), true);
	const wrapped = continueAsked(previous, "person@example.com");
	assert.match(wrapped, /Continue that task/);
	assert.match(wrapped, /person@example.com/);
	assert.equal(continueAsked("Saved. The session is open.", "person@example.com"), "person@example.com");
});

test("the last assistant text is the question, not a tool call", () => {
	const text = lastAssistantText([
		{ role: "assistant", content: [{ type: "text", text: "What email address is on your Robinhood account?" }, { type: "toolCall", name: "mcp" }] },
		{ role: "user", content: "older" },
	]);
	assert.equal(text, "What email address is on your Robinhood account?");
});
