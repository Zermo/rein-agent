# Dareecho development

Dareecho has two preparation paths: retain the computer's OS and set up a local model host, or prepare a Rein harness payload for an Omarchy VM. The first implementation provides platform plans and a runnable terminal overlay. Bootable Dareecho media, physical disk migration, and a fully integrated Linux desktop remain later build gates.

Dareecho is the OS build's display name. The stable CLI is `rein os`, development stays on `codex/rein-os`, and existing filesystem paths and manifest fields keep their names for compatibility.

See [model and OS validation](model-os-validation.md) for completed checks and untested target behavior.

```sh
rein os plan --mode host
rein os plan --mode image --json
rein os prepare --output ./rein-os-kit
node ./rein-os-kit/install-overlay.mjs --verify
```

Planning reads the hardware profile. Preparing writes only the new output directory and includes the current installed Rein bundle. Both preserve the running computer's operating system, services, accounts, and configuration. The output must not already exist; missing bundles require `npm run bundle` in a source checkout first.

## Platform paths

| Target | Initial path | Checks still required |
| --- | --- | --- |
| Apple Silicon Mac | Native macOS; MLX or llama.cpp with Metal | Actual memory pressure, model compatibility and runtime tests |
| Intel Mac | Native macOS, or a separately validated Omarchy install | Exact Mac model, drivers and boot support |
| Linux x86-64 | Native harness; Omarchy VM overlay as a separate target | Distribution dependencies, graphics/compute drivers and model runtime |
| Linux ARM64 | Native harness and a supported runtime | Hardware-specific Linux support; no Omarchy image from this kit |
| Windows x86-64/ARM64 | Windows remains installed; full terminal execution in WSL2 | WSL2 distribution, Bash/tmux and any GPU forwarding |

Candidate means a path exists to validate. It does not mean Rein detected working firmware, drivers, model acceleration, or all dependencies. Omarchy's [Mac guide](https://github.com/omacom/omarchy/blob/v4.0.2/manual/44-mac-support.md) has specific Intel Mac limitations and does not directly support M-series machines. Apple Silicon Linux would require a separate port against [Asahi's model-specific support matrix](https://asahilinux.org/docs/platform/feature-support/overview/). The Windows backend follows [Microsoft's WSL installation path](https://learn.microsoft.com/en-us/windows/wsl/install).

## The exported kit

`manifest.json` records the Rein version, payload SHA-256 values and the reviewed Omarchy v4.0.2 source commit, `346e69e1cec6c4e8924531874af6ba010a1bc99e`. The payload includes the CLI bundles, Meat WASM support and shipped runtime skill assets. It omits user profiles, credentials, sessions and the separately packaged native Rein klaud app.

The supported base flow is the [upstream ISO installer](https://github.com/omacom/omarchy/blob/v4.0.2/manual/02-getting-started.md). Install it interactively into a disposable VM with its own empty virtual disk. Verify the downloaded ISO independently: the source pin is not an ISO hash, and export does not download or verify installation media. The kit includes a separate source fetcher that checks out the pinned revision for inspection without running upstream code.

After the VM boots into Omarchy 4.0.2, copy the kit into it. Its `--check` validates the platform, installed base version and empty destinations. Its explicit `--install` creates `~/.local/share/rein-os` and `~/.local/bin/rein` as the desktop user. It refuses to overwrite an existing installation or launcher and leaves `~/.rein` untouched. The generated README contains commands and acceptance gates. Payload hashes detect modification; they do not authenticate a publisher.

The overlay never starts onboarding, downloads a model, opens a listener or enables an autonomy service. Run `rein setup` in the VM to select those options. Keep the small helper separate from foreground model serving and use Rein's existing budgets and approvals.

## Rain theme

```sh
rein os rain --static
rein os rain --animate
REIN_REDUCED_MOTION=1 rein os rain --animate
```

`rein os rain` defaults to a plain static terminal preview. `--animate` explicitly starts sparse rain in the current interactive terminal at eight frames per second. It requires a TTY for both input and output; q or Ctrl-C restores the previous screen and input mode. The preview adapts to terminal resizing and uses no services, models, network calls or saved configuration. It is decorative and does not indicate agent activity.

Set `REIN_REDUCED_MOTION=1` to keep the preview static even when `--animate` is requested. `NO_COLOR` removes palette color from animation. Static output always contains plain text, making it suitable for pipes and logs.

The exported kit includes checksum-verified [theme metadata](../src/os/assets/rain/theme.json) and a [static 1920×1080 wallpaper](../src/os/assets/rain/wallpaper.svg). Both use the field guide's cream, rust, amber, green and ink palette. The overlay stages these files under `~/.local/share/rein-os/src/os/assets/rain/` when installed in the target VM. Existing Omarchy themes and desktop preferences are preserved.

These assets are the basis for a future desktop theme. This stage does not activate an Omarchy theme, install an animated wallpaper, or add a boot animation. Desktop selection, reduced motion, reboot persistence and recovery still require validation against the actual Omarchy target.

## Gates to a distributable OS

1. Boot and test the VM desktop, input, network and storage on a fresh base, then reboot and repeat.
2. Complete Rein onboarding and a real model/tool round trip. Test model fit at the chosen context and concurrency, with latency and memory pressure measured rather than inferred from file size.
3. Exercise the optional headless helper's resource ceiling, stop/restart behavior and approval handling.
4. Test update/recovery on a VM copy before producing a reusable image. Keep a template free of accounts, transcripts and machine identifiers and defer personal onboarding to its owner.
5. Add a versioned desktop integration and reproducible image build. Omarchy's [cidata flow](https://github.com/omacom/omarchy/blob/v4.0.2/manual/51-unattended-installs.md) is documented for later automation; this kit does not fabricate its disk configuration or treat it as a post-install extension hook.
6. Validate exact physical hardware, backups, recovery, encryption and disk selection in a dedicated installer before offering an OS replacement. The ordinary Rein app installer stays separate from disk installation.

Hardware discovery can choose known drivers and model recipes. It cannot generate unsupported firmware, unlock a platform through exploitation, or certify a machine from its CPU architecture alone.
