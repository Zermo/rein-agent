# Obscura

Source: https://github.com/h4ckf0r0day/obscura

Release: `v0.2.2`, commit `a1e09de68c7617b8079fbb1661b0548c501971c1`.
License: Apache-2.0, complete text in `LICENSE`.

`markdown.rs` is the unchanged upstream file from
`crates/obscura-js/src/markdown.rs`. `markdown.ts` exports the exact expression
from that file so Rein can ask Obscura to return title, final URL and bounded
markdown from one rendered page. `manifest.json` records source checksums.

`releases.json` pins official no-render binary archives for macOS and Linux
arm64/x64 and Windows x64. These builds execute page JavaScript through V8 and
extract DOM content. Screenshots, stealth builds, and hosted services are outside
this integration. The archive sizes and SHA-256 digests come from GitHub's
v0.2.2 release asset metadata.

Rein downloads a platform archive into its state directory on first web use, or
with `rein web install`. It verifies the archive before extracting the two
runtime executables. Binaries are not included in the npm package. An explicit
`OBSCURA_BIN` or `obscura.bin` selects a user-managed installation.
