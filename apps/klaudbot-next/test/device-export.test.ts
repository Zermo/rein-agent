import assert from "node:assert/strict";
import test from "node:test";
import { deviceSurface, fileFromInspectDoc, mimeForName, safeExportName } from "../lib/device-export.ts";
import type { InspectDoc } from "../lib/types.ts";

test("safe names stay on the basename and pick a kind fallback", () => {
  assert.equal(safeExportName("../../secret/note.md"), "note.md");
  assert.equal(safeExportName("C:\\\\tmp\\\\shot.png"), "shot.png");
  assert.equal(safeExportName("", "image"), "image.png");
  assert.equal(safeExportName("bad<>name.txt"), "badname.txt");
});

test("mime follows extension then inspect kind", () => {
  assert.equal(mimeForName("shot.PNG", "image"), "image/png");
  assert.equal(mimeForName("index.html", "html"), "text/html");
  assert.equal(mimeForName("notes", "text"), "text/plain");
});

test("device surface maps iPhone, iPad-as-Mac, and Macintosh", () => {
  assert.equal(deviceSurface({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }), "ios");
  assert.equal(deviceSurface({ userAgent: "Mozilla/5.0", platform: "MacIntel", maxTouchPoints: 5 }), "ipados");
  assert.equal(deviceSurface({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 }), "macos");
  assert.equal(deviceSurface({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32" }), "web");
});

test("text inspect docs encode as File bytes without a blob URL", async () => {
  const doc: InspectDoc = { path: "out/note.md", name: "note.md", kind: "text", url: "", text: "# hello\n" };
  const file = await fileFromInspectDoc(doc);
  assert.equal(file.name, "note.md");
  assert.equal(file.type, "text/markdown");
  assert.equal(await file.text(), "# hello\n");
});
