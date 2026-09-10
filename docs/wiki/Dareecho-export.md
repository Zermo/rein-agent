# Dareecho export · Keep your files

Rein's Dareecho path replaces an operating system. That means the current OS image, its settings, and whatever was never backed up go with it. This page is the step you run before any replacement: learn what the machine is, and copy what is yours.

Both commands below are safe to run on any machine you own. The learn pass changes nothing. The export pass copies. Neither one deletes a source file.

## 01 Learn the machine

The learn pass reads the boot chain of trust, the security posture, and the credential and persistence surface. It writes a new dossier — `dossier.json`, `dossier.md`, and one evidence file per probe — under `~/.rein/redteam/`. If that directory name already exists, it takes the next free one instead of overwriting.

Run these in the terminal on the machine you want to learn.

LEARN THIS MACHINE
Copy
rein learn

JSON for scripts
Copy
rein learn --json

An attached iPhone or iPad needs [libimobiledevice](https://www.libimobiledevice.org/):

LEARN AN ATTACHED iOS DEVICE
Copy
brew install libimobiledevice
rein learn ios

Unlock the phone, trust this computer, and run the command with the cable connected. Add `--udid` if two devices are attached.

## 02 Export personal files

Three ways in, same engine underneath.

Browse and choose

REIN EXPORT BROWSE
Copy
rein export browse

A Finder-style listing. `j`/`k` move, `enter` opens a folder or selects a file, `space` selects, `a` selects everything in the folder, `c` clears, `h` goes up, `g` goes home, `e` exports the selection, `q` quits. The destination is shown at the bottom before you export.

Copy the standard groups

REIN EXPORT PRESETS
Copy
rein export presets --to /path/to/destination

This copies Documents, Desktop, Downloads, Pictures, Movies, and Music. On macOS it adds Mail, keychains, browser profiles, and SSH and GPG keys where they exist. Folders that are not present are listed and skipped, not an error.

To see what would be copied without copying:

REIN EXPORT PRESETS LIST
Copy
rein export presets --list

Name exactly what you want

REIN EXPORT PATHS
Copy
rein export ~/Documents/Contracts ~/Desktop --to /Volumes/Backup/keep

## 03 Where the files go

By default the export directory is `~/Dareecho-Export-<date>`. Put it where you will actually find it: an external drive, a network share, another machine over `scp`. Export copies; it does not move. Your originals stay put until you say otherwise.

If the destination already has the same files, they receive newer copies. Nothing in the source tree is ever removed.

## 04 Reading the dossier

Open `~/.rein/redteam/<host>-<timestamp>/dossier.md`. Three things to check before you trust any OS replacement:

- **Boot chain** — every stage from bootrom to kernel, and how much of it you can actually read.
- **Gates** — `verified` means Rein read the state and can show the evidence. `required` means the replacement needs it. `blocked` means it is missing and named.
- **Evidence** — one file per probe, under `evidence/`. The dossier claims nothing without a capture.

## 05 ChromeOS

ChromeOS reports to Node as `linux`. Rein reads `/etc/os-release`, and when it identifies Chrome OS it switches to the ChromeOS pass.

Learn

REIN LEARN
Copy
rein learn

The dossier maps the ChromeOS boot chain — bootrom, firmware (CoreBoot/UEFI), verified boot (dm-verity), the A/B partitions, kernel, userland — and names the model from DMI or the device tree. Whatever a given board cannot expose is recorded as a note, not an error.

Export

REIN EXPORT PRESETS CHROMEOS
Copy
rein export presets --to /media/removable/<drive>

The presets re-home to the chronos user directory (My Files), and add the Chromium profile under `~/.config/chromium`. The engine is unchanged: it copies, and never moves or deletes.

Replace

The `codex/rein-os` branch stages a ChromeOS userland kit. The installer confirms the machine identifies as ChromeOS, then writes only the chronos user's `.local/share/rein-os` and `.local/bin/rein`. The verified root and the A/B partitions stay untouched. Rootfs replacement on ChromeOS is a separate image-level project.

## Notes

- The learn pass is read-only. It runs the same probes on macOS, Windows, Linux, and ChromeOS; whatever a platform cannot answer is recorded as a note, not an error.
- Export needs a destination. Refusing to guess is the point.
- A replacement OS removes the image it replaces. Export first, replace second, verify after.
