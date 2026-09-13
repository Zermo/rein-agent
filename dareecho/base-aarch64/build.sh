#!/usr/bin/env bash
# Dareecho base (aarch64, S25 Ultra) — build recipe.
#
# This is the build definition for the aarch64 port. It is the sequence a
# builder (or a Dareecho provisioning run) executes to produce the swap image.
# Steps that depend on the frontier gates are marked GATE and are no-ops until
# the gate clears; see gates.md. Run from a build host with the Omarchy source
# and the pinned commit available.
set -euo pipefail

REIN_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="$REIN_ROOT/dareecho/base-aarch64"
OUT="${1:-./dareecho-s25ultra-aarch64}"

log() { printf '\n== %s\n' "$*"; }
gate() { printf '   [gate: %s] %s\n' "$1" "$2"; }

# --- 0. Inputs -------------------------------------------------------------
log "Inputs"
: "${OMARCHY_SRC:?Set OMARCHY_SRC to a checkout of the pinned Omarchy (v4.0.2)}"
: "${OMARCHY_COMMIT:?Set OMARCHY_COMMIT (pinned: 346e69e1cec6c4e8924531874af6ba010a1bc99e)}"
: "${AARCH64_KERNEL:?Set AARCH64_KERNEL to the aarch64 SM8750 kernel source + version}"
: "${SM8750_DTB:?Set SM8750_DTB to the 'sun' SoC + board device tree(s)}"
echo "Omarchy:   $OMARCHY_SRC @ $OMARCHY_COMMIT"
echo "Kernel:    $AARCH64_KERNEL"
echo "DTB:       $SM8750_DTB"
echo "Output:    $OUT"

# --- 1. Base OS (archlinuxarm aarch64) ------------------------------------
log "Base OS (archlinuxarm aarch64)"
# pacstrap the aarch64 base into a rootfs. The Omarchy package lists are the
# layer applied on top (packages-aarch64.txt).
# GATE: a working archlinuxarm aarch64 seed.
gate base-aarch64 "archlinuxarm seed + pacstrap to aarch64 rootfs"

# --- 2. Omarchy userland (aarch64) ----------------------------------------
log "Omarchy userland (aarch64)"
# Apply the carried package stack (core + optional, aarch64-resolved).
# The userland config/shell/themes/applications are copied from the pinned
# Omarchy tree and are architecture-portable.
# GATE: every package in packages-aarch64.txt resolves in archlinuxarm.
gate packages-aarch64 "archlinuxarm package resolution for the carried stack"

# --- 3. Kernel + device tree (SM8750 / 'sun') ------------------------------
log "Kernel + DTB (SM8750 'sun')"
# Build/collect the aarch64 mainline kernel with CONFIG_ARCH_QCOM, DRM_MSM,
# MSM_GPU, DSI, QMI/RMNET; collect the 'sun' SoC + board DTB and qcom firmware.
# GATE: kernel-sm8750 (frontier)
gate kernel-sm8750 "aarch64 mainline kernel with SM8750/'sun' platform"

# --- 4. GPU + display + modem (Qualcomm) ----------------------------------
log "GPU / display / modem"
# Adreno (msm_gpu/freedreno) + msm-drm DSI panel + qmi/mbim modem.
# GATE: gpu-adreno, display-dsi, modem-telephony
gate gpu-adreno "Adreno 2D/3D acceleration on SM8750"
gate display-dsi "msm-drm DSI panel bring-up (1440x3120)"
gate modem "Qualcomm X modem + RIL (data first)"

# --- 5. Dareecho userland (portable) --------------------------------------
log "Dareecho userland (portable, aarch64)"
# The Rein harness (Node>=18), Meat (WASM), Factory UI, and OS identity are
# architecture-portable: repack the aarch64 Node runtime + the kit payload.
# No reimplementation required.
gate userland-aarch64 "aarch64 Node runtime + kit payload"

# --- 6. Boot: A/B + AVB ----------------------------------------------------
log "Boot (A/B + AVB)"
# Lay the rootfs + kernel + DTB into A/B partitions for slot _b; sign vbmeta_b
# and each partition for AVB 1.3 so the green verified-boot chain holds.
# GATE: avb-signing
gate avb-signing "AVB 1.3 signing for the _b slot"

# --- 7. Unlock + flash + swap ---------------------------------------------
log "Unlock + flash + swap"
# Unlock the S938U bootloader (the access gate), flash slot _b, boot, verify,
# then set _b as default. Slot _a (Android) is the rollback target.
# GATE: bootloader-unlock (S938U US) — the first gate in gates.md
gate bootloader-unlock "S938U bootloader unlock (US model, wipes device)"

log "Done (definition)"
echo "This run executed the build definition. Steps behind a gate are no-ops"
echo "until the gate clears. See $BASE/gates.md for the gate list and status."
