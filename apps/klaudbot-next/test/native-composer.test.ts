import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_COMPOSER_CAPABILITY, NATIVE_COMPOSER_VERSION, parseNativeComposerCommand, postNativeComposerMessage, supportsNativeComposer } from "../lib/native-composer.ts";

const host = { protocolVersion: NATIVE_COMPOSER_VERSION, capabilities: [NATIVE_COMPOSER_CAPABILITY], documentNonce: "fixture-document" };
const envelope = { protocolVersion: NATIVE_COMPOSER_VERSION, documentNonce: host.documentNonce, botId: "klaud-bot-1234abcd", sessionId: "session-1" };

test("only the nonce-bound handshake capability may replace the web editor", () => {
  assert.equal(supportsNativeComposer(host), true);
  assert.equal(supportsNativeComposer({ protocolVersion: 1, capabilities: ["composer.v1"], documentNonce: host.documentNonce }), false);
  assert.equal(supportsNativeComposer({ ...host, protocolVersion: 99 }), false);
  assert.equal(supportsNativeComposer({ ...host, capabilities: ["haptics.v1"] }), false);
  assert.equal(supportsNativeComposer({ ...host, documentNonce: undefined }), false);
});

test("commands preserve their document, scope, revision and request identity", () => {
  const value = { ...envelope, action: "send", revision: 9, requestId: "request-9", text: "ship this exact revision" };
  const { protocolVersion: _, ...expected } = value;
  assert.deepEqual(parseNativeComposerCommand(value), expected);
  assert.equal(parseNativeComposerCommand({ ...envelope, action: "ready", requestId: "hello-1" })?.action, "ready");
  for (const revision of [-1, 0.5, true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseNativeComposerCommand({ ...value, revision }), null);
  }
  for (const patch of [
    { botId: " " }, { botId: "klaud-bot-1234abcd\n" }, { botId: "bot-1" },
    { sessionId: "../other" }, { sessionId: "a".repeat(161) }, { sessionId: "session-1\n" },
    { documentNonce: "" }, { requestId: "\n" }, { text: "x".repeat(128 * 1024 + 1) },
  ]) assert.equal(parseNativeComposerCommand({ ...value, ...patch }), null);
});

test("outbound envelope cannot spoof its kind, version or document", () => {
  const messages: unknown[] = [];
  const target = { klaudNative: host, webkit: { messageHandlers: { klaud: { postMessage: (message: unknown) => messages.push(message) } } } } as unknown as Parameters<typeof postNativeComposerMessage>[1];
  assert.equal(postNativeComposerMessage({ action: "hello", kind: "spoof", protocolVersion: 99, documentNonce: "spoof" }, target), true);
  assert.deepEqual(messages, [{ action: "hello", kind: "composer", protocolVersion: NATIVE_COMPOSER_VERSION, documentNonce: host.documentNonce }]);
  assert.equal(postNativeComposerMessage({}, { ...target, klaudNative: { ...host, documentNonce: undefined } } as typeof target), false);
  assert.equal(postNativeComposerMessage({}, { klaudNative: host } as unknown as typeof target), false);
  const throwing = { klaudNative: host, webkit: { messageHandlers: { klaud: { postMessage: () => { throw new Error("unavailable"); } } } } } as unknown as typeof target;
  assert.equal(postNativeComposerMessage({}, throwing), false);
});
