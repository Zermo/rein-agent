# Dareecho development

The product is one system in three tiers, and Dareecho is the tier that takes the whole machine: **rein-agent** is the CLI agent with its always-running harness — the agent loop, the tmux shells, the bots (named persistent agent identities), and the `rein serve` gateway; **rein-klaʊd** is the GUI for that gateway, with bot mode — the `apps/klaud` app connects to `rein serve` and renders the bots, their conversations, and the approval flow; **Dareecho** is the full Rein takeover as an operating system — the clean install that owns the machine and ships the other two tiers with it.

Dareecho is a replacement OS for an empty machine: the pinned base system (Omarchy 4.0.2) performs the full clean install onto the empty disk, and the Dareecho kit adds the userland — the full agent stack (harness, `rein serve` gateway, bots), the klaudbot app source, the theme, the Rainmeter-rebuilt skin engine, the Argent device toolkit — plus the OS identity. After installation the machine identifies as Dareecho (`~/.local/bin/dareecho`, `~/.local/share/rein-os/dareecho-release`). A second path stages a userland kit for ChromeOS, where the verified (dm-verity) root stays untouched, so that one honestly remains an overlay. The first implementation provides platform plans and runnable terminal surfaces. A fully Dareecho-built image (own base system, kernel and bootable media), physical disk migration, a fully integrated Linux desktop, a validated GUI runtime on Linux, and a ChromeOS rootfs image remain later build gates.

Dareecho is the OS build's display name. The stable CLI is `rein os`, development stays on `codex/rein-os`, and existing filesystem paths and manifest fields keep their names for compatibility.

See [model and OS validation](model-os-validation.md) for completed checks and untested target behavior.

```sh
rein os plan --mode host
rein os plan --mode image --json
rein os prepare --output ./rein-os-kit
node ./rein-os-kit/install-overlay.mjs --verify

rein os prepare --output ./rein-os-kit-cros --target chromeos
node ./rein-os-kit-cros/install-chromeos.mjs --verify
```

Planning reads the hardware profile. Preparing writes only the new output directory and includes the current installed Rein bundle. Both preserve the running computer's operating system, services, accounts, and configuration. The output must not already exist; missing bundles require `npm run bundle` in a source checkout first.

## Platform paths

| Target | Initial path | Checks still required |
| --- | --- | --- |
| Apple Silicon Mac | Native macOS; MLX or llama.cpp with Metal | Actual memory pressure, model compatibility and runtime tests |
| Intel Mac | Native macOS, or a separately validated Omarchy install | Exact Mac model, drivers and boot support |
| Linux x86-64 | Native harness; Dareecho clean install (pinned Omarchy base) as a separate target | Distribution dependencies, graphics/compute drivers and model runtime |
| Linux ARM64 | Native harness and a supported runtime | Hardware-specific Linux support; no Omarchy image from this kit |
| Windows x86-64/ARM64 | Windows remains installed; full terminal execution in WSL2 | WSL2 distribution, Bash/tmux and any GPU forwarding |
| ChromeOS (x86-64/ARM64) | Chronos userland overlay; the verified root and A/B partitions stay untouched | Developer mode, the arc shell, Node 18+ inside it, and an A/B-update survival test |

Candidate means a path exists to validate. It does not mean Rein detected working firmware, drivers, model acceleration, or all dependencies. Omarchy's [Mac guide](https://github.com/omacom/omarchy/blob/v4.0.2/manual/44-mac-support.md) has specific Intel Mac limitations and does not directly support M-series machines. Apple Silicon Linux would require a separate port against [Asahi's model-specific support matrix](https://asahilinux.org/docs/platform/feature-support/overview/). The Windows backend follows [Microsoft's WSL installation path](https://learn.microsoft.com/en-us/windows/wsl/install).

## The exported kit

`manifest.json` records the Rein version, payload SHA-256 values and the reviewed upstream commits — Omarchy v4.0.2 (`346e69e1cec6c4e8924531874af6ba010a1bc99e`), plus the Argent and Rainmeter pins. The payload includes the CLI bundles, Meat WASM support, shipped runtime skill assets, the rain theme and the sample skin. It omits user profiles, credentials, sessions and the separately packaged native Rein klaud app.

The supported base flow is the [upstream ISO installer](https://github.com/omacom/omarchy/blob/v4.0.2/manual/02-getting-started.md). Install it interactively into a disposable VM with its own empty virtual disk. Verify the downloaded ISO independently: the source pin is not an ISO hash, and export does not download or verify installation media. The kit includes a separate source fetcher that checks out the pinned revision for inspection without running upstream code.

After the base boots, copy the kit in. Its `--check` validates the platform, installed base version and empty destinations. Its explicit `--install` creates `~/.local/share/rein-os`, `~/.local/bin/rein` and `~/.local/bin/dareecho` as the desktop user, and writes `dareecho-release` — the Dareecho version, the detected Omarchy base, and all three pins — so the machine identifies as Dareecho. It refuses to overwrite an existing installation, launcher or identity and leaves `~/.rein` untouched. The generated README contains commands and acceptance gates. Payload hashes detect modification; they do not authenticate a publisher.

The install never starts onboarding, downloads a model, opens a listener or enables an autonomy service. Run `rein setup` in the VM to select those options. Keep the small helper separate from foreground model serving and use Rein's existing budgets and approvals.

### The ChromeOS kit

`rein os prepare --target chromeos --output <new-directory>` stages the same verified payload for a ChromeOS user account. Its installer, `install-chromeos.mjs`, confirms the machine identifies as ChromeOS through `/etc/os-release` (`ID=chromeos` or `CROS_RELEASE`) and that it runs as the chronos user, then creates `~/.local/share/rein-os` and `~/.local/bin/rein` in that home, refusing to overwrite either. It never touches the verified (dm-verity) root, the A/B partitions, or Chrome settings. `REIN_OS_OSRELEASE` overrides the os-release path so the kit can be exercised on a non-ChromeOS staging host.

ChromeOS reports as `linux` to the harness; `rein os plan` detects it on the host and reports the `chromeos-userland` adapter with developer-mode and backup gates. Rootfs replacement on ChromeOS is image-level work (coreboot and `chromeos-image` territory) and is not what this kit claims.

## Rain theme

```sh
rein os rain --static
rein os rain --animate
REIN_REDUCED_MOTION=1 rein os rain --animate
```

`rein os rain` defaults to a plain static terminal preview. `--animate` explicitly starts sparse rain in the current interactive terminal at eight frames per second. It requires a TTY for both input and output; q or Ctrl-C restores the previous screen and input mode. The preview adapts to terminal resizing and uses no services, models, network calls or saved configuration. It is decorative and does not indicate agent activity.

Set `REIN_REDUCED_MOTION=1` to keep the preview static even when `--animate` is requested. `NO_COLOR` removes palette color from animation. Static output always contains plain text, making it suitable for pipes and logs.

The exported kit includes checksum-verified [theme metadata](../src/os/assets/rain/theme.json) and a [static 1920×1080 wallpaper](../src/os/assets/rain/wallpaper.svg). Both use the field guide's cream, rust, amber, green and ink palette. The kit stages these files under `~/.local/share/rein-os/src/os/assets/rain/` when installed in the target VM. Existing base themes and desktop preferences are preserved.

These assets are the basis for a future desktop theme. This stage does not activate an Omarchy theme, install an animated wallpaper, or add a boot animation. Desktop selection, reduced motion, reboot persistence and recovery still require validation against the actual Omarchy target.

## Rainmeter rebuild (terminal skin engine)

Rainmeter (`rainmeter/rainmeter.git` @ `be2afe7e`, GPL-2.0) is the Windows skin engine: INI-defined skins built from measures (value providers) and meters (visuals), with variables, styles and conditional behavior. Dareecho rebuilds that model clean-room for the terminal: no GPL-2.0 code is copied, and the pinned commit is the reviewed reference, the way Omarchy and Argent are pinned.

```sh
rein os rainmeter
rein os skin render src/os/assets/skins/dareecho.ini
rein os skin render src/os/assets/skins/dareecho.ini --frames 16
rein os skin install <skin-directory> [--dir <target>]
rein os skin list
```

`rein os skin render` is static by default; `--frames n` animates on the alternate screen, and q or Ctrl-C restores it. `REIN_REDUCED_MOTION=1` keeps skins still, matching the rain preview. Implemented measures: Time, Uptime, SysInfo, String, Loop and Calc (with `[measure]` and `#variable#` references). Meters: String, Bar, Gauge and Line, with IfMeasureName/IfCondition. Windows-API measures (CPU, Net, Ping, WebParser, Registry, NowPlaying) and raster/vector meters are parity gates, not claims: they need their own validation before counting as rebuilt. `rein os rainmeter` prints the full module-by-module mapping.

A terminal dashboard skin ships with the engine and with every exported kit (the kit manifest pins the Rainmeter commit alongside Omarchy and Argent).

## Argent integration (device flows)

Argent (`software-mansion/argent.git` @ `aa90873b`, Apache-2.0; upstream `@swmansion/argent@0.24.0`) is a device-action toolkit: a frozen v1 provider contract (external `ext:` providers with capability tokens), recorded device flows with pass/fail/skip/error step reports, and PNG-based visual verification. Dareecho rebuilds the contract, the flow engine and the PNG pipeline with zero runtime dependencies, and adds the one provider this machine has: the terminal.

```sh
rein argent rebuild
rein argent status
rein argent flow validate <file.json>
rein argent flow run <file.json>
rein argent screenshot <id|image-file> --out <new.png>
rein argent diff <a.png> <b.png> [--threshold n]
```

Flow files follow the upstream v1 schema: steps with `action` (tap, swipe, type, key, screenshot, wait, assert) and `x`, `y`, `x2`, `y2`, `text`, `delayMs`. The built-in terminal provider is honest about its surface: it can type, press keys, wait, capture text and diff screenshots, but has no pointer, so tap and swipe steps skip rather than fail. A step whose provider lacks a mechanism is reported as skipped with the reason, never silently passed.

`rein argent screenshot` renders a terminal surface into a deterministic pixel grid (the same renderer the diff uses), so a flow can capture a terminal state and verify it image-wise. The provider contract is reimplemented against the pinned upstream, so external `ext:` providers and recorded flows keep their shapes.

## Gates to a distributable OS

1. Boot and test the VM desktop, input, network and storage on a fresh base, then reboot and repeat.
2. Complete Rein onboarding and a real model/tool round trip. Test model fit at the chosen context and concurrency, with latency and memory pressure measured rather than inferred from file size.
3. Exercise the optional headless helper's resource ceiling, stop/restart behavior and approval handling.
4. Test update/recovery on a VM copy before producing a reusable image. Keep a template free of accounts, transcripts and machine identifiers and defer personal onboarding to its owner.
5. Add a versioned desktop integration and reproducible image build. Omarchy's [cidata flow](https://github.com/omacom/omarchy/blob/v4.0.2/manual/51-unattended-installs.md) is documented for later automation; this kit does not fabricate its disk configuration or treat it as a post-install extension hook.
6. Validate exact physical hardware, backups, recovery, encryption and disk selection in a dedicated installer before offering an OS replacement. The ordinary Rein app installer stays separate from disk installation.

Hardware discovery can choose known drivers and model recipes. It cannot generate unsupported firmware, unlock a platform through exploitation, or certify a machine from its CPU architecture alone.
