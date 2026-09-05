# Embedded Meat provenance

Rein embeds the Meat engine from
[boldsoftware/meat](https://github.com/boldsoftware/meat/tree/f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3),
pinned to `f39f41dfe7b5b37a12b35fdfbaecc7e779855bd3`.
`upstream/` is an unchanged snapshot of the engine, its tests and fixtures,
README, module definition, and license notice. `manifest.json` records every
snapshot file's SHA-256 digest.

Meat is copyright 2026 Bold Software, Inc., under Apache 2.0. `LICENSE` preserves
the upstream notice; `APACHE-2.0` contains the complete license from
<https://www.apache.org/licenses/LICENSE-2.0.txt>. The Go runtime and standard
library are covered by `GO-LICENSE`, copied from Go 1.26.5. Rein's adapters retain
the repository's MIT license.

## Adaptation

`scripts/build-meat.mjs` copies the pinned snapshot to a temporary build tree.
It adds `src/native/meat/main.go` as a JavaScript/WebAssembly entry point and
`src/native/meat/adapter.go.txt` as the engine's scoped-read and chunk-budget
hooks. One marked change to the temporary `meat/tools.go` routes `read_file`
and `grep` through Rein. The original snapshot is never rewritten. Meat retains
its chunking, preview/submit loop, edit-plan validation, and diff rendering.

The resulting `meat.wasm.gz` and Go's unchanged `wasm_exec.cjs` run inside Rein's
worker. The installed package needs Node 18 or later; it does not compile Go,
download a toolchain, or install runtime dependencies. The host supplies the
chosen provider and scoped file access.

## Rebuild and verify

Use exactly Go **1.26.5** and run:

```sh
npm run test:meat-upstream
npm run build:meat
npm run check:meat
npm run check:natives
npm run bundle
```

The build targets `GOOS=js GOARCH=wasm` with `-trimpath`, `-buildvcs=false`, and
`-ldflags=-s -w`; it disables external Go modules and toolchain downloads and
ignores ambient Go build flags/workspaces. `build.json` pins the uncompressed
WASM digest and size, runtime digest, upstream commit, both adapter inputs,
build script, snapshot manifest, and all distributed licenses. Verification
compares uncompressed WASM bytes, so Node/zlib compression differences cannot
invalidate an otherwise identical Go build. `check:natives` needs only Node;
`check:meat` rebuilds with the pinned Go compiler and verifies the shipped bytes.

CI runs the upstream fixture tests with live-model tests disabled, checks the
rebuild, verifies both committed JavaScript bundles, and exercises the installed
Meat worker on Node 18, 20, 22, and 24 against a local mock provider.
