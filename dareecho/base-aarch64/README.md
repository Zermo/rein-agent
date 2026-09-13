# Dareecho base — aarch64 (Galaxy S25 Ultra)

The base is what gets swapped in when Dareecho replaces the original OS. The
pinned base today is **Omarchy 4.0.2** (an Arch Linux–based distro, x86-64).
This directory is the **architecture port of that base to aarch64**, targeting
the Galaxy S25 Ultra, so Dareecho can be the swapped-in OS on the phone rather
than an overlay on Android.

The model is the red-team model: `rein learn` maps the machine's trust chain
(bootrom → ABOOT → AVB verified boot → kernel → userland), the install path
**unlocks** the machine's own gates, builds Dareecho **side by side** (the
A/B `*_b` slot), verifies it, and then **swaps** it in as the default boot.
The base in this directory is the aarch64 side of that.

## Grounded in the measured device

Every target fact below was read from the S25 Ultra during the install test
(`rein learn` dossier + `getprop`), not assumed:

| Fact | Value |
| --- | --- |
| SoC | `ro.soc.model = SM8750`, `ro.hardware = qcom`, `ro.board.platform = sun` |
| GPU | Adreno (`ro.hardware.egl = adreno`, Vulkan) |
| Display | 1440×3120 (QHD+), density 600 |
| CPU ABI | `arm64-v8a` (aarch64) |
| RAM | ~11.4 GB |
| Storage | ~220 GB `/data` |
| Kernel | 6.6 (android15) |
| OS | Android 16 (SDK 36), `samsung/pa3qsqw/pa3q:16/...:S938U` |
| Boot | A/B (`ro.boot.slot_suffix = _a`), AVB 1.3, verified boot `green` |
| Lock | `ro.boot.flash.locked = 1`, `ro.oem_unlock_supported` empty (US model S938U) |
| Policy | SELinux enforcing, file-based encryption |

## What the port changes, and what it keeps

- **Base OS**: x86-64 Arch ISO → **archlinuxarm aarch64** base. The Omarchy
  userland (shell, config, themes, applications, the 147 core + 59 optional
  packages) is carried over as aarch64 package builds.
- **Kernel**: x86-64 (incl. the `linux-ptl` Panther Lake swap) → an
  **aarch64 mainline kernel** with the SM8750/"sun" platform, `msm-drm` DPU,
  and Adreno (`msm_gpu`/freedreno) enabled. See `kernel-dtb.md`.
- **Hardware layer**: the x86 laptop fixes (Intel/Apple/NVIDIA/Framework) are
  replaced by a **Qualcomm/Adreno layer** for this board. See
  `hardware-s25ultra.md`.
- **Boot**: UEFI/GPT on x86 → **A/B + AVB** on the phone. Dareecho is built
  into the `*_b` slot and swapped in after it boots. See `boot-ab-avb.md`.
- **Dareecho userland**: the Rein harness (Node ≥18), Meat (WASM), the Factory
  UI, and the OS identity are **architecture-portable** — they repack as-is for
  aarch64. No reimplementation.

## Files

- `base.json` — the machine-readable base definition (what a builder consumes).
- `packages-aarch64.txt` — the aarch64 package stack (Omarchy core + Qualcomm GPU).
- `hardware-s25ultra.md` — the S25 Ultra hardware layer (drivers, firmware, DTB).
- `kernel-dtb.md` — kernel + device-tree selection.
- `boot-ab-avb.md` — A/B + AVB boot, the unlock gate, and the side-by-side swap.
- `build.sh` — the build recipe (base + packages + kernel + userland → image).
- `gates.md` — the honest gate list: what is ready, what is a frontier gate.

## Status

This is a **build definition and gate map**, produced as the base for the
aarch64 port. It is not yet a booted image: the frontier gates (Adreno 830
driver maturity on SM8750, DSI display bring-up, the S938U bootloader unlock,
and a signed A/B/AVB image) are the work it scopes. See `gates.md`.
