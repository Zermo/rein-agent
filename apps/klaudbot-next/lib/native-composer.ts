export const NATIVE_COMPOSER_VERSION = 2;
export const NATIVE_COMPOSER_MAX_UTF8 = 128 * 1024;
export const NATIVE_COMPOSER_CAPABILITY = "composer.v2";
export const NATIVE_COMPOSER_EVENT = "klaud-native-composer-command";
export const NATIVE_COMPOSER_READY_EVENT = "klaud-native-ready";

export interface NativeComposerHost {
  protocolVersion?: unknown;
  capabilities?: unknown;
  documentNonce?: unknown;
}

export interface NativeComposerScope {
  botId: string;
  sessionId: string;
}

export type NativeComposerCommand = NativeComposerScope & { documentNonce: string } & (
  | { action: "draft"; revision: number; text: string }
  | { action: "send"; revision: number; requestId: string; text: string }
  | { action: "stop"; requestId: string }
  | { action: "ready"; requestId: string }
);

interface WebKitMessageHandler { postMessage(message: unknown): void }
interface NativeComposerWindow extends Window {
  klaudNative?: NativeComposerHost;
  webkit?: { messageHandlers?: { klaud?: WebKitMessageHandler } };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Same bounded session-ID grammar as the harness; no trimming or partial matches.
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.match(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/)?.[0] === value;
}

export function supportsNativeComposer(host: NativeComposerHost | undefined): boolean {
  return host?.protocolVersion === NATIVE_COMPOSER_VERSION && identifier(host.documentNonce) &&
    Array.isArray(host.capabilities) && host.capabilities.includes(NATIVE_COMPOSER_CAPABILITY);
}

export function parseNativeComposerCommand(value: unknown): NativeComposerCommand | null {
  if (!object(value) || value.protocolVersion !== NATIVE_COMPOSER_VERSION ||
      typeof value.botId !== "string" || value.botId.match(/^klaud-bot-[0-9a-f]{8}$/)?.[0] !== value.botId ||
      !identifier(value.sessionId) || !identifier(value.documentNonce)) return null;
  const target = { botId: value.botId, sessionId: value.sessionId, documentNonce: value.documentNonce };
  if (value.action === "draft" || value.action === "send") {
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
        typeof value.text !== "string" || new TextEncoder().encode(value.text).byteLength > NATIVE_COMPOSER_MAX_UTF8) return null;
    const draft = { ...target, revision: value.revision as number, text: value.text };
    if (value.action === "draft") return { ...draft, action: "draft" };
    return identifier(value.requestId) ? { ...draft, action: "send", requestId: value.requestId } : null;
  }
  if (value.action === "stop" || value.action === "ready") {
    return identifier(value.requestId) ? { ...target, action: value.action, requestId: value.requestId } : null;
  }
  return null;
}

export function postNativeComposerMessage(message: Record<string, unknown>, target: NativeComposerWindow = window as NativeComposerWindow): boolean {
  const handler = target.webkit?.messageHandlers?.klaud;
  const documentNonce = target.klaudNative?.documentNonce;
  if (typeof handler?.postMessage !== "function" || !identifier(documentNonce)) return false;
  try {
    handler.postMessage({ ...message, kind: "composer", protocolVersion: NATIVE_COMPOSER_VERSION, documentNonce });
    return true;
  } catch { return false; }
}
