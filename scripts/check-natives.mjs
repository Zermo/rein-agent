import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import assert from "node:assert/strict";

const hash = data => createHash("sha256").update(data).digest("hex");
const root = new URL("../", import.meta.url);
function filesUnder(base, prefix = "") {
  return readdirSync(new URL(prefix || "./", base), { withFileTypes: true }).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), `Vendored sources cannot contain symlinks: ${entry.name}`);
    return entry.isDirectory() ? filesUnder(base, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`];
  }).sort();
}
for (const name of ["fold", "mattpocock", "meat"]) {
  const base = new URL(`../vendor/${name}/`, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", base), "utf8"));
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  const snapshot = name === "meat" ? new URL("upstream/", base) : base;
  if (name === "meat") assert.deepEqual(filesUnder(snapshot), Object.keys(manifest.files).sort(), "Meat snapshot contains untracked or missing files.");
  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.ok(!file.split("/").includes("..") && !file.startsWith("/") && !file.includes("\\"));
    const content = readFileSync(new URL(file, snapshot));
    assert.equal(createHash("sha256").update(content).digest("hex"), hash, `${name} snapshot changed: ${file}`);
  }
}
const meat = new URL("vendor/meat/", root);
const metadata = JSON.parse(readFileSync(new URL("build.json", meat), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("manifest.json", meat), "utf8"));
assert.equal(metadata.version, 1); assert.equal(metadata.go, "1.26.5"); assert.equal(metadata.target, "js/wasm");
assert.equal(metadata.upstreamCommit, manifest.commit);
const wasm = gunzipSync(readFileSync(new URL("meat.wasm.gz", meat)), { maxOutputLength: 32 * 1024 * 1024 });
assert.equal(hash(wasm), metadata.wasm); assert.equal(wasm.length, metadata.wasmBytes);
assert.equal(hash(readFileSync(new URL("wasm_exec.cjs", meat))), metadata.runtime);
const requiredSources = ["src/native/meat/main.go", "src/native/meat/adapter.go.txt", "scripts/build-meat.mjs", "vendor/meat/manifest.json"];
assert.deepEqual(Object.keys(metadata.sources).sort(), requiredSources.sort());
for (const [file, expected] of Object.entries(metadata.sources)) assert.equal(hash(readFileSync(new URL(file, root))), expected, `Meat build input changed; rebuild WASM: ${file}`);
assert.deepEqual(Object.keys(metadata.licenses).sort(), ["APACHE-2.0", "GO-LICENSE", "LICENSE"]);
for (const [file, expected] of Object.entries(metadata.licenses)) assert.equal(hash(readFileSync(new URL(file, meat))), expected, `Meat license changed: ${file}`);
assert.deepEqual(readFileSync(new URL("LICENSE", meat)), readFileSync(new URL("upstream/LICENSE", meat)));
const apache = readFileSync(new URL("APACHE-2.0", meat), "utf8");
assert.ok(apache.length > 10000 && apache.includes("END OF TERMS AND CONDITIONS"), "The complete Apache 2.0 license must accompany Meat.");
console.log("Native Fold, Matt Pocock and embedded Meat provenance OK");
