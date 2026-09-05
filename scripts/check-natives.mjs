import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

for (const name of ["fold", "mattpocock"]) {
  const base = new URL(`../vendor/${name}/`, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", base), "utf8"));
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.ok(!file.split("/").includes("..") && !file.startsWith("/"));
    const content = readFileSync(new URL(file, base));
    assert.equal(createHash("sha256").update(content).digest("hex"), hash, `${name} snapshot changed: ${file}`);
  }
}
console.log("Native Fold and Matt Pocock provenance OK");
