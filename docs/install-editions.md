# One harness, three installation choices

The guided curl installer always installs the Rein Agent CLI first. Onboarding
sets work preferences, task budgets, a model connection, and optional follow-ups.
Its next step selects what to add to that base:

| Edition | Installed or configured | What keeps running |
| --- | --- | --- |
| Rein Agent / gateway | Current-terminal preference; the base includes `rein serve` | Terminal tasks while Rein runs. Explicitly enabled autonomy uses its own user service. |
| Rein Cloud / bot app | Native Mac app, or the included Electron app on Linux | `rein desktop open` owns one local gateway and closes it when its app session exits. Separately enabled autonomy can continue while the app is closed. |
| Dareecho development | Read-only hardware/model-fit assessment and OS compatibility gates | Nothing new in the background. The current deliverable is a separately prepared Omarchy VM overlay. |

These are installation choices, not model providers or permission presets. Each
uses the same `REIN_HOME` (default `~/.rein`), accounts, profile, task limits, and
sessions. The selected edition is recorded in a private `installation.json`.
Changing edition does not delete previous apps, change the default OS terminal,
disable existing services, or reset your credentials and history.

## Guided and unattended commands

The production command remains:

```sh
curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/main/install.sh | bash
```

While this integration branch is under review, test its installer explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/Zermo/rein-agent/codex/install-options/install.sh \
  | bash -s -- --branch codex/install-options
```

Preselect a path by adding `--edition gateway`, `--edition cloud`, or `--edition os`.
Without a flag, interactive onboarding asks. `--yes` alone configures only the
model connection; it never chooses or installs an extra app. `--skip-setup`
without an edition updates the base without changing the saved selection.
An explicit edition with `--skip-setup` applies that choice offline, after the
base is installed. `--no-launch` prevents automatic app/chat launch.

Revisit the choice independently of model setup:

```sh
rein setup edition
rein setup edition --status
rein setup edition --edition gateway --yes
rein setup edition --edition cloud --yes
rein setup edition --edition os --yes
```

Cloud installation downloads the app, so that choice requires internet access.
macOS uses the existing archive checksum, signature, identity, and architecture
checks. Linux installs the locked app dependencies and builds its renderer; it
needs a graphical desktop and Electron's system libraries to open. Windows
terminal users should use WSL; a standalone Windows app installer is not
packaged yet. The legacy `--app-only` utility remains available for installing
the standalone Mac app with its bundled harness and no global CLI.

If an app download or install fails, the working harness and prior edition are
preserved. Retry `rein setup edition --edition cloud --yes`. To update the app
itself, rerun that command; a plain `rein update` updates the base harness.

## Bots and background work

The bot app is a working view over the harness. Opening it starts an owned,
authenticated loopback gateway; it does not turn every bot into an unattended
worker. Enable optional follow-ups for named folders during onboarding, or use
`rein autonomy enable` after reviewing its settings. This service is separate
from the app and keeps using the existing task approvals and budgets.

Use `rein autonomy status` to inspect it, `rein autonomy pause` to pause work,
and `rein autonomy disable` to remove the supervisor. Local model serving and
the optional small headless helper have their own explicit setup and resource
limits. None is started merely because an edition was selected. The computer
must remain powered on and awake for local services to do work.

## Dareecho's current boundary

The OS option inventories the local CPU, memory, GPU, and available serving
tools. It estimates model fit and prints recipes and platform gates. Estimates
are not benchmarks and do not certify firmware, drivers, or a remote server.
It uses ordinary hardware queries; it does not exploit BIOS or kernels, scan
other machines for vulnerabilities, partition disks, or change the host OS.

Prepare a new, checksum-verifiable kit directory with:

```sh
rein os prepare --output ./dareecho-kit
node ./dareecho-kit/install-overlay.mjs --verify
```

Follow its README in a disposable supported Omarchy VM. The overlay installer
refuses unsupported platforms and existing destinations. Bootable images,
physical-machine migration, desktop integration, and rollback still have the
validation gates documented in [Dareecho development](rein-os.md).

## Development branches

- `codex/rein-cloud-reskin`: app appearance, interactions, and supporting controls.
- `codex/rein-os`: Dareecho and managed model-hosting development.
- `codex/install-options`: integration of both with the shared installer. This is
  where combined builds are verified; its OS code must not be copied back into
  the reskin branch.

Product selection never switches a running user's checkout to a feature branch.
`--branch` is a separate, explicit development-install option.

## Integration validation

Validated on 2026-09-07: 801 source regression tests, including real curl-piped
terminal fixtures for gateway, Cloud, and Dareecho routing; native app attachment
and cancellation; private preference preservation; and edition argument checks.
Both provenance checks passed. Bundled CLI smoke passed on Node 18.20.8 and
26.3.0, and rebuilding produced identical bundle bytes. The packaged gateway
and OS commands ran in an isolated private home, and the combined VM kit passed
its exported checksum verifier without installation. Native Mac archive handling
uses the existing installer fixture suite; a fresh GUI app download and physical
OS installation were not performed by this validation.
