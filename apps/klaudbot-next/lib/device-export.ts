import type { InspectDoc, InspectKind } from "./types";

export type DeviceSurface = "ios" | "ipados" | "macos" | "web";
export type NativeHandoff = {
  saveFile?: (payload: NativeFilePayload) => void | Promise<void>;
  shareFile?: (payload: NativeFilePayload) => void | Promise<void>;
};
export type NativeFilePayload = { action: "save" | "share"; name: string; mime: string; bytes: string; size: number };

type ShareNav = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
};

type SavePickerWindow = {
  klaudNative?: NativeHandoff;
  webkit?: { messageHandlers?: { klaud?: { postMessage: (message: unknown) => void } } };
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }>;
};

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  html: "text/html", htm: "text/html", json: "application/json", md: "text/markdown", txt: "text/plain",
  csv: "text/csv", css: "text/css", js: "text/javascript", ts: "text/plain", tsx: "text/plain",
  mjs: "text/javascript", cjs: "text/javascript", xml: "application/xml", pdf: "application/pdf",
};

export function safeExportName(raw: string, kind: InspectKind = "text"): string {
  const base = raw.replace(/\\/g, "/").split("/").pop()?.replace(/[\u0000-\u001f<>:"|?*]+/g, "").trim() || "";
  const cleaned = base.slice(0, 180) || (kind === "image" ? "image.png" : kind === "html" ? "page.html" : "note.txt");
  return cleaned;
}

export function mimeForName(name: string, kind: InspectKind = "text"): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext && MIME[ext]) return MIME[ext];
  if (kind === "image") return "image/png";
  if (kind === "html") return "text/html";
  return "text/plain";
}

export function deviceSurface(nav: ShareNav = typeof navigator === "undefined" ? {} : navigator): DeviceSurface {
  const ua = nav.userAgent ?? "";
  const platform = nav.platform ?? "";
  const touch = nav.maxTouchPoints ?? 0;
  if (/iPhone|iPod/.test(ua)) return "ios";
  if (/iPad/.test(ua) || (platform === "MacIntel" && touch > 1)) return "ipados";
  if (/Mac/.test(platform + ua) || /macOS/.test(ua)) return "macos";
  return "web";
}

function hostView(view?: SavePickerWindow): SavePickerWindow {
  if (view) return view;
  return typeof window === "undefined" ? {} : window as SavePickerWindow;
}

function hostNav(nav?: ShareNav): ShareNav {
  if (nav) return nav;
  return typeof navigator === "undefined" ? {} : navigator;
}

export function hasNativeBridge(view?: SavePickerWindow): boolean {
  const host = hostView(view);
  return Boolean(host.klaudNative?.saveFile || host.klaudNative?.shareFile || host.webkit?.messageHandlers?.klaud);
}

export async function fileFromInspectDoc(doc: InspectDoc): Promise<File> {
  if (doc.error) throw new Error("This file could not be opened.");
  const name = safeExportName(doc.name || doc.path, doc.kind);
  const mime = mimeForName(name, doc.kind);
  if (doc.url) {
    const blob = await fetch(doc.url).then(response => {
      if (!response.ok) throw new Error("Could not read the file bytes.");
      return response.blob();
    });
    return new File([blob], name, { type: blob.type || mime, lastModified: Date.now() });
  }
  return new File([doc.text ?? ""], name, { type: mime, lastModified: Date.now() });
}

async function bytesBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function nativeHandoff(action: "save" | "share", file: File, view: SavePickerWindow): Promise<boolean> {
  const payload: NativeFilePayload = { action, name: file.name, mime: file.type || "application/octet-stream", bytes: await bytesBase64(file), size: file.size };
  const method = action === "save" ? view.klaudNative?.saveFile : view.klaudNative?.shareFile;
  if (method) { await method(payload); return true; }
  if (view.webkit?.messageHandlers?.klaud) { view.webkit.messageHandlers.klaud.postMessage(payload); return true; }
  return false;
}

function downloadFile(file: File): void {
  const href = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = href;
  link.download = file.name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

async function shareWithSheet(file: File, nav: ShareNav): Promise<boolean> {
  if (typeof nav.share !== "function") return false;
  const withFiles = { files: [file], title: file.name, text: file.name } as ShareData;
  try {
    if (!nav.canShare || nav.canShare(withFiles)) { await nav.share(withFiles); return true; }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return true;
  }
  try {
    await nav.share({ title: file.name, text: file.type.startsWith("text/") ? await file.text() : file.name });
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return true;
    return false;
  }
}

async function saveWithPicker(file: File, view: SavePickerWindow): Promise<boolean> {
  if (typeof view.showSaveFilePicker !== "function") return false;
  try {
    const handle = await view.showSaveFilePicker({
      suggestedName: file.name,
      types: [{ description: "File", accept: { [file.type || "application/octet-stream"]: ["." + (file.name.split(".").pop() || "txt")] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return true;
    return false;
  }
}

export async function saveInspectDoc(doc: InspectDoc, nav?: ShareNav, view?: SavePickerWindow): Promise<void> {
  const file = await fileFromInspectDoc(doc);
  const surface = deviceSurface(hostNav(nav));
  const host = hostView(view);
  if (await nativeHandoff("save", file, host)) return;
  if (surface === "ios" || surface === "ipados") {
    if (await shareWithSheet(file, hostNav(nav))) return;
    downloadFile(file);
    return;
  }
  if (await saveWithPicker(file, host)) return;
  downloadFile(file);
}

export async function shareInspectDoc(doc: InspectDoc, nav?: ShareNav, view?: SavePickerWindow): Promise<void> {
  const file = await fileFromInspectDoc(doc);
  const hostNavValue = hostNav(nav);
  if (await nativeHandoff("share", file, hostView(view))) return;
  if (await shareWithSheet(file, hostNavValue)) return;
  if (deviceSurface(hostNavValue) === "macos" || deviceSurface(hostNavValue) === "web") downloadFile(file);
  else throw new Error("Sharing is not available on this device.");
}
