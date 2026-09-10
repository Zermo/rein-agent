# Dareecho model manager and overlay validation

Development validation on 2026-09-07. This change adds managed GGUF artifacts,
an owned headless server, explicit user services, connection handoff and an
Omarchy VM overlay exporter. The existing release version remains 0.14.2;
these checks do not publish a release.

Dareecho is the OS build's display name. These checks continue to use the
stable `rein os` CLI, filesystem paths and manifest schema.

## Checks completed

| Check | Result |
| --- | --- |
| `npm test` | Source smoke and all 736 regression tests passed, including the rain theme follow-up |
| `npm run check:posthorse` | Pinned provenance passed |
| `npm run check:natives` | Native dependency provenance passed |
| `npm run bundle` | Both distributed bundles rebuilt; a second build produced identical bytes |
| `node test/bundle-smoke.mjs` | Passed on Node 26.3.0 |
| `npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs` | Passed on Node 18.20.8 |
| Model artifact, runner and service fixtures bundled with esbuild for Node 18 | All 33 tests passed under Node 18.20.8 |
| Packaged `rein os prepare`, then generated `install-overlay.mjs --verify` | All 66 payload files, including both rain assets, exported and hash-verified; exported static preview passed |
| Rain, overlay, OS planning and model command tests | All 32 focused tests passed, including q/Ctrl-C restoration in a real pseudoterminal |
| Live public Hub metadata resolution | Exact filename, immutable revision, LFS size and SHA256 resolved without downloading model weights |

The final full-suite output had SHA256
`3647ba0a762fab4ac464a601811919cd71dabb2aedabd4216a8ed3781d59d645`
and 76,369 bytes. Raw local logs are not shipped.

The public metadata check used
[`Qwen/Qwen3-4B-GGUF`](https://huggingface.co/Qwen/Qwen3-4B-GGUF/tree/bc640142c66e1fdd12af0bd68f40445458f3869b),
file `Qwen3-4B-Q4_K_M.gguf`, commit
`bc640142c66e1fdd12af0bd68f40445458f3869b`, size 2,497,280,256 bytes,
SHA256 `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`.
This verifies the resolver against a real publisher response; it does not
establish that model's inference quality or suitability for a particular host.

## What the fixtures exercise

Artifact tests cover pinned metadata, credential handling across redirects,
bounded downloads, interruption/resume, size and hash failures, disk space,
per-artifact locking, version preservation and link rejection. Runtime tests
launch local HTTP fixture children and check model identity, completions,
readiness, private connection state, occupied ports, memory estimates and
termination of an unresponsive child. They do not perform model inference.

Service tests generate actual temporary launchd/systemd files with fixture
service-manager commands. They check literal argument encoding, scoped
ownership, missing runtimes, status/removal without repeat runtime arguments,
and preservation of edited files or failed stops. No real user service was
registered during development.

Connection tests verify that failed probes preserve config, successful probes
keep budgets and fallback accounts, and settings changed during a probe survive
the handoff. Partial GPU offload cannot use an entire GPU's memory to justify
a fit; ambiguous device layouts retain the conservative RAM check.

Overlay tests execute the generated verifier and launcher against temporary
fixture homes. They check checksums, platform/version gates, literal paths,
existing destinations and preservation of configuration. Exporting the real
bundles verifies packaging separately from those fixtures.

Rain preview tests cover the static default, explicit TTY requirement, reduced
motion, terminal resizing, cancellation, output errors and restoration of raw
input mode, cursor visibility and the previous screen. A real pseudoterminal
test checks both q and Ctrl-C through the source CLI. The static preview creates
no configuration. Theme tests verify the shared palette, static SVG, required
manifest entries, same-size asset tampering, link rejection and preservation of
an existing desktop theme. No wallpaper or Omarchy theme was activated.

## Remaining validation

- Boot the intended Omarchy 4.0.2 x86-64 VM and run the overlay there. The kit is
  a post-install terminal overlay, not bootable media or the Rein klaud GUI.
- Download a selected model, test an actual llama.cpp build and measure memory,
  latency, streaming, tool use and sustained task quality on supported hardware.
- Exercise real launchd/systemd restart and shutdown behavior on target hosts.
- Complete the desktop, update/recovery and reusable-image gates in
  [Dareecho development](rein-os.md) before offering an OS installation product.
- Validate desktop theme selection, reduced motion, reboot persistence and
  recovery on the target VM before adding an animated OS wallpaper or boot theme.

No operating system, user model connection, installed helper or user service
was changed by this validation pass.

## Dareecho Learn and export boundary

The integrated `rein learn` and `rein export` paths have their own focused
fixtures for host and iOS dossiers, ChromeOS detection, copy-only export,
preset selection, and the interactive export browser. They are deliberately
separate from the OS-overlay verification above: a dossier is a read-only
assessment and an export copies user-selected data; neither one authorizes an
OS replacement.

The public [Dareecho export wiki page](wiki/Dareecho-export.md) is the
operator-facing runbook. The [red-team plan](dareecho-redteam-plan.md) records
the engine boundary and the remaining CyberStrike integration work. Do not
interpret either document as evidence that a bootable Dareecho image, firmware
writer, or bundled offensive toolkit exists.
