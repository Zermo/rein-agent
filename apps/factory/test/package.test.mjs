import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const appDir = join(directory, "..");

// Collect every local .mjs module the app entry (main.mjs) imports,
// transitively. Electron and node: builtins are not local files.
function localImports(file) {
  const source = readFileSync(file, "utf8");
  const imports = new Set();
  const patterns = [
    /from\s+"(\.\/[^"]+\.mjs)"/g,
    /import\(\s*"(\.\/[^"]+\.mjs)"\s*\)/g,
    /require\(\s*"(\.\/[^"]+\.mjs)"\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) imports.add(match[1]);
  }
  return [...imports];
}

function reachableLocalModules(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const spec of localImports(entry)) {
    reachableLocalModules(join(dirname(entry), spec.replace(/^\.\//, "")), seen);
  }
  return seen;
}

// The package allowlist is the array in `for (const file of [...]) copy(...)`.
function packageCopyList() {
  const source = readFileSync(join(appDir, "package-macos.mjs"), "utf8");
  const match = source.match(/for\s*\(\s*const\s+file\s+of\s+\[([^\]]+)\]\s*\)\s*copy/);
  assert.ok(match, "could not find the package copy allowlist in package-macos.mjs");
  return [...match[1].matchAll(/"([^"]+)"/g)].map(item => item[1]);
}

test("the packaged app bundles every local module the entry imports", () => {
  const entry = join(appDir, "main.mjs");
  const needed = [...reachableLocalModules(entry)].map(file => file.slice(appDir.length + 1).replace(/\\/g, "/"));
  const bundled = new Set(packageCopyList());
  const missing = needed.filter(file => !bundled.has(file));
  assert.deepEqual(missing, [], `package-macos.mjs omits modules the app needs at runtime: ${missing.join(", ")}`);
});

test("every module in the package copy list exists on disk", () => {
  for (const file of packageCopyList()) {
    assert.ok(existsSync(join(appDir, file)), `copy list references a missing file: ${file}`);
  }
});
