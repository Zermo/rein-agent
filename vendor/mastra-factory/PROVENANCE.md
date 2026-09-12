# Provenance: Mastra Factory template

Unmodified copy of the upstream project. The wrapper app
(`apps/factory`) reads from this directory; the generated project is
copied from it into user state and never edited in place.

| Field | Value |
| --- | --- |
| Upstream | `mastra-ai/softwarefactory-template` (github.com) |
| Commit | `dfeb25a03c9b0e93995ec92c771a54570e3f3072` |
| Copied | 2026-09-10 |
| License | Apache-2.0 (see its `package.json` and `README.md`) |
| Branding | Kept as-is: Mastra Factory name, UI, and icon are Mastra's |

Fork for tracking upstream: `tullman17-coder/softwarefactory-template`.

## Dependency security

The source files above are byte-for-byte the upstream copy. The one deliberate
difference is applied **at provision time** to the generated project in user
state (`~/.local/share/rein-factory`), never to this directory: `provision.mjs`
merges an `overrides` block that pins four transitive dependencies to their
first patched release to clear upstream advisories — `undici` 6.28.1,
`lodash` 4.18.1, `adm-zip` 0.6.1, `smol-toml` 1.8.0. A project's own override
for a given package always wins, so a future Mastra release can take over.

This clears 24 of the 34 advisories `npm audit` reports on the template tree.
The remaining 10 are a single chain rooted at `extract-zip` (no patched
release exists yet — `first_patched: NONE` on both GHSAs), reached through
Mastra's browser-automation stack (`agent-browser` → `webdriverio` →
`@wdio/*` → `@puppeteer/browsers` → `extract-zip`). It stays until upstream
ships a fix; bumping `extract-zip` in `SECURITY_OVERRIDES` is the one-line
follow-up.
