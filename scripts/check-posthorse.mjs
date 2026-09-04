import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const expected = {
  "index.ts": "fbf27aec202e87f43269f74a6c127450a82bc541e03c3a8c644c35a95505acbe",
  "LICENSE": "a69cb493aff5f26dce3939d4b5716f66d3e62bbac7a287de69fdfe177804a0c4",
  "README.md": "5b879482bd0e6acf848361ca6d04c6ab903d905dad8b5a05e03f53fad623d797"
};
for (const [file, hash] of Object.entries(expected)) {
  const content = readFileSync(new URL(`../vendor/pi-posthorse/${file}`, import.meta.url));
  assert.equal(createHash("sha256").update(content).digest("hex"), hash, `Upstream snapshot changed: ${file}`);
}
console.log("Posthorse provenance OK");
