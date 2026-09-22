export const NATIVE_COMPOSER_VERSION = 1;
export const NATIVE_COMPOSER_CAPABILITY = "composer.v1";
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

export type NativeComposerCommand =
  | (NativeComposerScope & { action: "draft"; revision: number; text: string })
  | (NativeComposerScope & { action: "send"; revision: number; requestId: string; text: string })
  | (NativeComposerScope & { action: "stop"; requestId: string });

interface WebKitMessageHandler {
  postMessage(message: unknown): void;
}

interface NativeComposerWindow extends Window {
  klaudNative?: NativeComposerHost;
  webkit?: { messageHandlers?: { klaud?: WebKitMessageHandler } };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scope(value: Record<string, unknown>): NativeComposerScope | null {
  const botId = typeof value.botId === "string" ? value.botId : "";
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
  return botId && sessionId ? { botId, sessionId } : null;
}

export function supportsNativeComposer(host: NativeComposerHost | undefined): boolean {
  return host?.protocolVersion === NATIVE_COMPOSER_VERSION &&
    Array.isArray(host.capabilities) && host.capabilities.includes(NATIVE_COMPOSER_CAPABILITY);
}

export function parseNativeComposerCommand(value: unknown): NativeComposerCommand | null {
  if (!object(value) || value.protocolVersion !== NATIVE_COMPOSER_VERSION) return null;
  const target = scope(value);
  if (!target || typeof value.action !== "string") return null;
  if (value.action === "draft") {
    return Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 && typeof value.text === "string"
      ? { ...target, action: "draft", revision: value.revision as number, text: value.text }
      : null;
  }
  if (value.action === "send") {
    return Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 &&
      typeof value.requestId === "string" && value.requestId.length > 0 && typeof value.text === "string"
      ? { ...target, action: "send", revision: value.revision as number, requestId: value.requestId, text: value.text }
      : null;
  }
  if (value.action === "stop") {
    return typeof value.requestId === "string" && value.requestId.length > 0
      ? { ...target, action: "stop", requestId: value.requestId }
      : null;
  }
  return null;
}

export function postNativeComposerMessage(message: Record<string, unknown>, target: NativeComposerWindow = window as NativeComposerWindow): boolean {
  const handler = target.webkit?.messageHandlers?.klaud;
  const documentNonce = target.klaudNative?.documentNonce;
  if (!handler || typeof documentNonce !== "string" || !documentNonce) return false;
  handler.postMessage({ kind: "composer", protocolVersion: NATIVE_COMPOSER_VERSION, documentNonce, ...message });
  return true;
}
