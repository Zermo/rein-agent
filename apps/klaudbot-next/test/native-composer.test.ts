import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_COMPOSER_CAPABILITY,
  NATIVE_COMPOSER_VERSION,
  parseNativeComposerCommand,
  supportsNativeComposer,
} from "../lib/native-composer.ts";

test("native composer requires an exact versioned capability", () => {
  assert.equal(supportsNativeComposer({ protocolVersion: NATIVE_COMPOSER_VERSION, capabilities: [NATIVE_COMPOSER_CAPABILITY] }), true);
  assert.equal(supportsNativeComposer({ protocolVersion: 2, capabilities: [NATIVE_COMPOSER_CAPABILITY] }), false);
  assert.equal(supportsNativeComposer({ protocolVersion: NATIVE_COMPOSER_VERSION, capabilities: ["haptics.v1"] }), false);
});

test("draft commands require scope and a nonnegative safe revision", () => {
  assert.deepEqual(parseNativeComposerCommand({
    protocolVersion: 1,
    action: "draft",
    botId: "bot-1",
    sessionId: "session-1",
    revision: 7,
    text: "keep selection semantics native",
  }), {
    action: "draft",
    botId: "bot-1",
    sessionId: "session-1",
    revision: 7,
    text: "keep selection semantics native",
  });
  assert.equal(parseNativeComposerCommand({ protocolVersion: 1, action: "draft", botId: "bot-1", revision: 7, text: "x" }), null);
  assert.equal(parseNativeComposerCommand({ protocolVersion: 1, action: "draft", botId: "bot-1", sessionId: "session-1", revision: -1, text: "x" }), null);
});

test("send commands preserve request identity", () => {
  const parsed = parseNativeComposerCommand({
    protocolVersion: 1,
    action: "send",
    botId: "bot-1",
    sessionId: "session-1",
    revision: 9,
    requestId: "request-9",
    text: "ship this exact revision",
  });
  if (!parsed || parsed.action !== "send") throw new Error("Expected a send command");
  assert.equal(parsed.requestId, "request-9");
  assert.equal(parsed.revision, 9);
});
