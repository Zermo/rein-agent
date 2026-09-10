# Dareecho Learn and red-team plan

**Dareecho Learn** is Rein's implemented, read-only red-team assessment pass:
it writes a machine dossier covering the boot chain, security posture,
credential and persistence surface, and probe evidence before a Dareecho
replacement is considered. Rein stays the commander and keeps the assessment
inside its existing approvals and budgets.

[CyberStrike](https://github.com/CyberStrikeus/CyberStrike) informed the
research and platform-playbook direction. It is not the engine bundled by this
repository: Rein imports no CyberStrike code, invokes no CyberStrike binary, and
ships none of its offensive or credential-harvesting tooling. Any future
process-bound integration must remain optional, separately licensed, and
explicitly approved.

## Implemented now

- `rein learn [--json] [--output DIR]` — read-only pass on macOS, Windows, Linux (any arch),
  and ChromeOS (reports as linux; detected via `/etc/os-release`, where the model comes
  from DMI or the device tree and the boot chain is bootrom → firmware → verified boot
  (dm-verity) → A/B partitions → kernel → userland); records the boot chain of trust,
  security gates, and per-probe evidence into a new dossier directory under
  `~/.rein/redteam/`. Refuses to overwrite; never deletes.
- `rein learn ios [--udid U]` — learns an attached iOS device through libimobiledevice,
  mapping it onto the iOS boot chain (bootrom → iBSS/iBEC → AppleLL → KernelCache → launchd).
- `rein export` — data-loss prevention before any replacement. `rein export browse` is a
  Finder-style TUI (navigate, select, export); `rein export presets` copies the standard
  personal data groups (Documents, Desktop, Downloads, Pictures, Movies, Music, and on
  macOS Mail, keychains, browser profiles, SSH/GPG keys; on ChromeOS the same groups
  re-homed to the chronos user directory plus the Chromium profile); `rein export <paths...> --to D`
  copies exactly what you name. The engine copies, never moves or deletes; it refuses a
  target inside a source and a source inside a target.
- Focused learn/export/OS fixtures cover dossier creation, iOS and ChromeOS
  detection, copy-only exports, preset selection, the interactive exporter, and
  overlay boundaries. Run `npm test` for the current suite instead of carrying a
  stale test count or host-specific result into public documentation.
- Rebuild engine (`codex/rein-os`): `rein os plan` detects ChromeOS on linux hosts and
  plans a `chromeos-userland` adapter with developer-mode and backup gates; `rein os
  prepare --target chromeos --output DIR` stages a ChromeOS userland kit whose installer
  verifies the machine identifies as ChromeOS, then writes only the chronos user's
  `.local/share/rein-os` and `.local/bin/rein` — the verified (dm-verity) root and A/B
  partitions stay untouched. The Omarchy VM kit remains the default `--target omarchy`.
- Docs: README usage block + Dareecho section, wiki page `Dareecho-export`, the
  field guide, branding previews, and this plan.
- Scope note: the never-delete rule covers our work on the operator's test machines and the
  learn/export paths. Dareecho the OS replacement itself obviously removes the image it
  replaces — the installer says so, and `rein export` exists for the personal data.
- Remaining: a reviewed `rein os plan --dossier` handoff, hardware-specific
  firmware validation, and any separately licensed CyberStrike integration.

## What was learned

### Zermo/rein-agent (this repo)

- `main` — the harness (REPL, loop, native tools, zero runtime deps) and the rein-klaud bot apps.
- `codex/rein-os` — **Dareecho**: `rein os plan` (read-only hardware assessment),
  `rein os prepare` (pinned Omarchy v4.0.2 overlay kit for an x86-64 VM), `rein os rain` (theme).
  Six gates to a distributable OS. Its own words: hardware discovery "cannot generate
  unsupported firmware, unlock a platform through exploitation, or certify a machine from
  its CPU architecture alone." That is exactly the gap a red-team pass fills.
- Skill system: `SKILL.md` + manifest, 24 KB per file, lazy-loaded by a `skill` tool
  (`src/harness/skills.ts`). Same document family as CyberStrike skills.
- `src/hardware/profile.ts` — read-only probes (CPU, RAM, GPUs, Apple bandwidth table).

### CyberStrike

- TypeScript monorepo (Bun, pnpm), **AGPL-3.0**, ~2.6k stars, active (last push 2026-09-06).
  Default branch is `dev`; `main` may lag.
- 13+ agents defined as prompt files + tool sets; 7,600+ lazy-loaded SKILL.md methodology
  files (Ed25519-signed); 56+ built-in tools; 176+ MCP tools (cve-mcp, osint-mcp,
  cloud-audit-mcp, github-security-mcp).
- **machook** (`packages/cyberstrike/src/tool/machook/`): 46 macOS post-exploitation
  programs across recon, credential harvesting, privesc, persistence, monitoring, evasion,
  lateral movement, exfil. Native CLIs; DTrace ones need SIP disabled.
- **Bolt**: remote tool execution over MCP + Ed25519 for machines we don't sit on.
- **Plugin SDK** (`packages/plugin`): a plugin returns hooks; `tool()` takes a zod shape +
  `execute`. This is where our firmware tools go.
- `cyberstrike run --agent <name>` is headless, with a session permission rule. That is
  Rein's entry point.
- Air-gapped capable: Ollama, LM Studio, any OpenAI-compatible server.
- **No BIOS/UEFI/firmware skill exists in its 7,600.** That is the gap we author.

### Synthetic hardware examples

These examples describe supported classes of hardware, not an operator's
installation. Hostnames, OS versions, RAM, firmware settings, access methods,
and serving profiles belong in a private machine dossier.

| Example | Hardware class | What the read-only profile establishes |
| --- | --- | --- |
| `desktop-a.example` | Apple Silicon desktop | Installed OS, boot security, and available userland tools |
| `desktop-b.example` | x86-64 desktop | Installed OS, actual BIOS/UEFI mode, and available userland tools |

Do not infer a machine's security or access posture from its hardware class.
Public tests use synthetic fixtures; real profiling output stays local.

### ChromeOS

- Reports to Node as `linux` (arm64 or x64); `/etc/os-release` carries `ID=chromeos`
  and `CROS_RELEASE=` (the version). User home is `/home/chronos/user/<id>`; My Files
  is that home. Developer mode unlocks the `arc` shell (userland packages, Node) —
  without it the shell is limited, so developer mode is a gate for the red-team pass.
- Boot chain: bootrom → firmware (CoreBoot/UEFI) → verified boot (dm-verity) → A/B
  partitions → kernel → userland. dm-verity rollback plus the A/B switch make rootfs
  replacement an image-level project (`chromeos-image` / coreboot territory). The first
  supported injection surface is a userland overlay in the chronos home, which is what
  the `--target chromeos` kit does.
- Personal data: Downloads/Documents/Pictures/Music/Videos plus the Chromium profile
  under `~/.config/chromium`; `rein export presets` on a ChromeOS host copies exactly
  those, re-homed to the chronos directory.

## How the two combine (decision)

1. **Process boundary, not code coupling.** CyberStrike runs as its own binary (npm/bun
   global). Rein drives it with its existing shell tool under its existing budgets and
   approvals. AGPL stays in a separate process; Rein keeps its zero-runtime-dep promise.
2. **Skills as data.** CyberStrike skills are SKILL.md documents. Vendor a curated subset
   into `vendor/cyberstrike/skills/` with a manifest, the same way `vendor/mattpocock`
   ships. No CyberStrike TypeScript in the Rein bundle.
3. **Firmware plugin.** One small CyberStrike plugin (`dareecho-firmware`) adds
   `firmware_recon`, `boot_chain`, `nvram_dump`, `esp_map` tools. It runs where machook runs.
4. **Dossier as the contract.** Every pass writes a structured dossier (below). Rein's
   `rein os plan` learns to read it. That file, not the tool, is what couples the systems.
5. **MCP bridge only if needed** (Phase 4). Rein querying CyberStrike's findings store
   becomes a CyberStrike plugin exposing an MCP server. Do not build it before a need.

## Phases

### Phase 0 — Groundwork (day 1)

- Install CyberStrike in an isolated test environment: `npm i -g @cyberstrike-io/cyberstrike`; verify
  `cyberstrike run --help` and one trivial agent run.
- Point CyberStrike at the existing local OpenAI-compatible server (same priority Rein
  already probes: Ollama → LM Studio → llama.cpp → vLLM). No cloud, no new API key.
- Set the session permission rule for red-team runs so headless mode does not
  auto-reject every tool call, and so destructive tools (persistence, exfil) stay
  ask-gated.
- Pin the CyberStrike commit in a manifest entry, the same discipline Dareecho already
  applies to Omarchy (`346e69e…`).
- Fix the dossier location: `~/.rein/redteam/<host>/dossier.json` + `dossier.md`.

### Phase 1 — Learn the machine

One pass per host, all read-only, run under Rein's shell budget:

1. **machook recon**: `system_info`, `process_enum`, `network_enum`, `user_enum`,
   `installed_apps`, `security_framework`, `launchd_enum`.
2. **Credential surface** (read): `keychain_dump`, `ssh_keys`, `cloud_creds`,
   `icloud_tokens`. If system protections block a probe, record the gap without changing those protections.
3. **Privesc and persistence surface**: `tcc_bypass`, `dylib_hijack`,
   `launchd_plist_abuse`, `sudo_misconfig`, `authorization_db`, `pkg_abuse`.
4. **CVE pass** via cve-mcp on everything `installed_apps` and the firmware version report.
5. **Firmware and boot chain** (the new plugin, per host):
   - Apple Silicon: `nvram -p`, `bless --info`, `csrutil status`, `fdesetup status`,
     `spctl --status`, `ioreg` secure-boot keys, `softwareupdate --list-full-installers`,
     Asahi support matrix lookup for the selected hardware model.
   - x86 targets (later fleet): `efibootmgr -v`, UEFI variable dump, Secure Boot db/dbx,
     ESP mount and listing, CoreBoot vs vendor firmware.
6. Write the dossier. Review it with the commander before anything else.

### Phase 2 — Rank the injection paths

The dossier maps to four Dareecho injection paths, in ascending risk:

| Path | What it is | Evidence the dossier must show |
| --- | --- | --- |
| A — Overlay | Keep macOS; Rein harness + MLX/Metal model + Omarchy VM kit (current `codex/rein-os` host mode) | Runtime fit, memory headroom, no blocking CVE |
| B — Boot media | Dareecho image on USB, picked in the boot picker; no firmware writes | Support matrix for the selected hardware model, verified ISO, working boot |
| C — Boot entry | Signed boot entry (`bless`) pointing at Dareecho; survives reboot, removable | SIP state, `bless` write access, rollback entry tested |
| D — Firmware | CoreBoot or custom firmware | x86 + CoreBoot-verified board only. Apple Silicon: closed firmware, stays a gate |

`rein os plan` grows an optional `--dossier <path>`: gates that have passing evidence
report `verified` instead of `required`, and the output lists the ranked paths with the
residual risk per path. The six existing gates stay the acceptance criteria; the dossier
is the evidence pack behind them.

### Phase 3 — Execute and verify (each step gated)

1. Dry-run pass on an authorized test machine; keep the real dossier private and commit only synthetic fixtures.
2. Repeat on a second authorized test platform; record observed security differences in its private dossier.
3. Boot Dareecho from media on a disposable x86 VM or spare machine; complete a real
   Rein model/tool round trip; reboot and repeat (existing gate 1).
4. Only then: propose a physical injection (A → B → C order) for a commander-approved
   machine, with backup media, recovery media, and a named rollback step.

### Phase 4 — Red-team Dareecho itself

Once the OS is injected, point CyberStrike at the Dareecho host: llm-security skill
against the agent, proxy testers against the gateway, CVE pass over the Rein bundle,
exposure check on every listener. The system we inject passes the same pass it ran on
its host, or it says why the residual risk is accepted.

## Dossier spec (schemaVersion 1)

The following values are synthetic placeholders, not collected observations.

```json
{
  "schemaVersion": 1,
  "host": { "os": "macos", "arch": "arm64", "model": "ExampleArm64Desktop",
            "sw": "example-version", "sip": "unknown", "hostname": "desktop-a.example" },
  "facts": [ { "id": "MAC-SYSINFO-001", "source": "machook",
               "evidence": "sw_vers", "sha256": "…" } ],
  "surface": {
    "credentials": [ { "store": "keychain", "entries": 0, "extracted": false } ],
    "persistence": [ { "kind": "launchd", "third_party": 0, "writable": 0 } ],
    "cves": [ { "product": "…", "version": "…", "id": "CVE-…", "epss": 0.0 } ]
  },
  "boot_chain": [
    { "stage": "bootrom", "trust": "immutable", "notes": "Apple, per-board" },
    { "stage": "firmware", "trust": "apple-signed", "notes": "update channel: …" },
    { "stage": "secure_boot", "trust": "csrutil enabled/disabled", "notes": "…" },
    { "stage": "boot_entry", "trust": "bless", "notes": "… entries …" },
    { "stage": "kernel", "trust": "amfi", "notes": "…" }
  ],
  "injection": [
    { "path": "A", "rank": 1, "status": "candidate", "gates": ["runtime", "dependencies"],
      "residual": "…" }
  ]
}
```

Rules: every fact carries its evidence command and an output hash, so a dossier entry
is checkable, not an assertion. No serials, no credentials, no personal paths.
`host.hostname` is synthetic or redacted in anything committed.

## Build list

1. `vendor/cyberstrike/` — curated skills (`macos-postexploit`, `recon-methodology`,
   `llm-security`, `linux-postexploit`) + manifest, Rein vendoring format.
2. `rein redteam <recon|creds|privesc|firmware|report>` (or `rein os learn`) — wraps
   machook + the firmware plugin, writes the dossier, prints the ranked paths.
3. Private `dareecho-firmware` CyberStrike plugin — the four firmware tools above,
   zod args, Apple Silicon and x86 variants.
4. `src/os/plan.ts` — optional `--dossier` input; gate status upgrades; ranked injection
   paths in the formatted plan.
5. `test/redteam-dossier.test.ts` — fixture dossier → plan output, per existing test
   style (local fixtures, no model server).
6. `docs/dareecho-redteam.md` — this plan minus the open questions, plus the dossier
   spec as the normative section.

## License and process

- AGPL-3.0 applies to CyberStrike's code. A separate process is fine. Do not copy its
  TypeScript into Rein's bundle; vendored SKILL.md text is data — check each skill's
  license header before it ships in a public repo.
- Pin commits, not branches, for both Omarchy and CyberStrike.
- CyberStrike tests run from package directories, not repo root — matters if we ever
  fork the plugin in-tree.
- Rein's own invariants hold: read-only until an explicit phase says otherwise, no new
  runtime dependency, user config and sessions untouched, budgets and approvals
  unchanged.

## Attribution and use of CyberStrike

CyberStrike is an upstream reference for tool orchestration and security review.
Its code remains subject to its own license. Rein's integration must pin the
upstream revision, preserve required attribution, and follow the licensing and
process constraints above.

Machine-specific research notes, local model choices, and serving profiles are
private working data and are not part of this public plan.

## Open questions (need the commander's call)

1. "Colonel structure" — planned as the boot chain of trust (BootROM → firmware →
   Secure Boot → boot entry → kernel). Correct?
2. "Commander" = the human operator, or the Rein agent itself? If the agent, the
   llm-security skill (prompt injection, tool abuse) becomes a Phase 1 item, not Phase 4.
3. First test target: a disposable virtual machine, or spare hardware with a
   verified backup and an approved recovery plan?
4. Model: use an existing compatible provider or a separate test endpoint? Keep
   the selected host, model, and serving profile in private configuration.
