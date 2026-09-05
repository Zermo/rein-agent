// Build once with Go; installed Rein only needs Node to run the shipped WASM.
import { mkdtempSync, cpSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor/meat");
const hash = data => createHash("sha256").update(data).digest("hex");
const manifest = JSON.parse(readFileSync(join(vendor, "manifest.json"), "utf8"));
assert.match(manifest.commit, /^[a-f0-9]{40}$/);
for (const [file, expected] of Object.entries(manifest.files)) {
  assert.ok(!file.startsWith("/") && !file.split("/").includes("..") && !file.includes("\\"));
  assert.equal(hash(readFileSync(join(vendor, "upstream", file))), expected, `Pinned Meat source changed: ${file}`);
}
const env = { ...process.env, GOTOOLCHAIN: "local", GOENV: "off", GOFLAGS: "", GOEXPERIMENT: "", GOWORK: "off", GOPROXY: "off", GOSUMDB: "off", CGO_ENABLED: "0", MEAT_E2E: "0", UPDATE_GOLDEN: "0", CHUNK_SANITY_DIFF: "" };
delete env.GOOS; delete env.GOARCH;
const version = execFileSync("go", ["version"], { encoding: "utf8", env });
assert.match(version, /^go version go1\.26\.5\s/, "Rebuild Meat with Go 1.26.5 to match the shipped runtime.");
if (process.argv.includes("--test")) {
  execFileSync("go", ["test", "-count=1", "./meat"], { cwd: join(vendor, "upstream"), env, stdio: "inherit" });
  console.log("Pinned Meat upstream tests passed without live-model tests.");
  process.exit(0);
}
const temporary = mkdtempSync(join(tmpdir(), "rein-meat-build-"));
const flags = ["-trimpath", "-buildvcs=false", "-ldflags=-s -w"];
try {
  cpSync(join(vendor, "upstream"), temporary, { recursive: true });
  mkdirSync(join(temporary, "cmd/rein-meat"), { recursive: true });
  cpSync(join(root, "src/native/meat/main.go"), join(temporary, "cmd/rein-meat/main.go"));
  cpSync(join(root, "src/native/meat/adapter.go.txt"), join(temporary, "meat/rein_adapter.go"));
  const file = join(temporary, "meat/tools.go");
  const source = readFileSync(file, "utf8");
  const signature = "func (tb *toolbox) run(ctx context.Context, name string, input json.RawMessage) (string, bool) {";
  assert.equal(source.split(signature).length, 2, "Expected one upstream toolbox entry point.");
  writeFileSync(file, "// Modified by Rein during the WASM build: scoped host reads replace OS tools.\n" + source.replace(signature, signature + '\n\tif ReinReadTool != nil && (name == "read_file" || name == "grep") { return ReinReadTool(ctx, tb.root, name, input) }'));
  const wasmFile = join(temporary, "meat.wasm");
  execFileSync("go", ["build", ...flags, "-o", wasmFile, "./cmd/rein-meat"], { cwd: temporary, env: { ...env, GOOS: "js", GOARCH: "wasm" }, stdio: "inherit" });
  const wasm = readFileSync(wasmFile);
  const goroot = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8", env }).trim();
  const runtime = readFileSync(join(goroot, "lib/wasm/wasm_exec.js"));
  const license = [join(goroot, "LICENSE"), join(goroot, "../LICENSE")].find(existsSync);
  assert.ok(license, "Go license must accompany the runtime");
  const goLicense = readFileSync(license);
  const metadata = {
    version: 1, upstreamCommit: manifest.commit, go: "1.26.5", target: "js/wasm", flags,
    wasm: hash(wasm), wasmBytes: wasm.length, runtime: hash(runtime),
    sources: Object.fromEntries(["src/native/meat/main.go", "src/native/meat/adapter.go.txt", "scripts/build-meat.mjs", "vendor/meat/manifest.json"].map(file => [file, hash(readFileSync(join(root, file)))])),
    licenses: { "LICENSE": hash(readFileSync(join(vendor, "LICENSE"))), "APACHE-2.0": hash(readFileSync(join(vendor, "APACHE-2.0"))), "GO-LICENSE": hash(goLicense) },
  };
  if (process.argv.includes("--check")) {
    assert.deepEqual(metadata, JSON.parse(readFileSync(join(vendor, "build.json"), "utf8")));
    assert.equal(hash(gunzipSync(readFileSync(join(vendor, "meat.wasm.gz")))), metadata.wasm, "Shipped Meat WASM differs from the reproducible build.");
    assert.deepEqual(readFileSync(join(vendor, "wasm_exec.cjs")), runtime, "Shipped Go runtime differs from Go 1.26.5.");
    assert.deepEqual(readFileSync(join(vendor, "GO-LICENSE")), goLicense, "Shipped Go license differs from the compiler distribution.");
  } else {
    writeFileSync(join(vendor, "meat.wasm.gz"), gzipSync(wasm, { level: 9 }));
    writeFileSync(join(vendor, "wasm_exec.cjs"), runtime);
    writeFileSync(join(vendor, "GO-LICENSE"), goLicense);
    writeFileSync(join(vendor, "build.json"), JSON.stringify(metadata, null, 2) + "\n");
  }
  console.log(`Embedded Meat engine OK (${wasm.length} WASM bytes)`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
