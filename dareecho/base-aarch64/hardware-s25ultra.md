# Hardware layer — Galaxy S25 Ultra (SM8750 / "sun")

This replaces the x86 laptop hardware layer (Intel/Apple/NVIDIA/Framework
fixes) with the Qualcomm layer for this board. Every identifier below was read
from the device; nothing here is assumed.

## SoC and board

- `ro.soc.model = SM8750`, `ro.soc.manufacturer = QTI`
- `ro.hardware = qcom`, `ro.board.platform = sun`
- ABI `arm64-v8a` (aarch64), kernel 6.6 (android15)

The kernel and device tree are therefore selected for the **SM8750 / "sun"**
platform, not for a generic aarch64 board. See `kernel-dtb.md`.

## GPU — Adreno

- `ro.hardware.egl = adreno`, Vulkan API present.
- Linux driver: the Qualcomm **`msm`** DRM driver with the **`msm_gpu`**
  (Adreno) component, i.e. the freedreno/`msm` path in the mainline kernel.
- Firmware: Adreno GPU firmware blobs are loaded from the firmware directory;
  the build must ship the matching `qcom` GPU firmware for SM8750.
- Acceleration target: **2D (GBM/DRM) first**, then Vulkan/`msm_gpu` 3D.
  This is the highest-risk item on the board (see `gates.md`).

## Display — DSI / DPU

- Panel 1440×3120 (QHD+), density 600.
- Linux driver: **`msm-drm`** DPU over the **DSI** controller, panel described
  in the SM8750 device tree.
- Bring-up order: eDP/DSI link → DPU plane/CTM → framebuffer → compositor.

## Modem and telephony

- `ro.boot.baseband = msm` (Qualcomm X modem).
- Linux: the **`qmi`/`mbim`** + **RIL**/`libqmi` stack for data; call/SMS via
  the modem's QMI/RMNET interfaces.
- This is **non-blocking** for the OS swap (Dareecho can boot and run without
  telephony) but **blocking for daily-driver** use (calls, SMS, 5G).

## Storage

- UFS, `/data` ~220 GB, file-based encryption (Android FBE).
- The Dareecho image uses its own partition layout on the `*_b` slot; the
  existing `/data` payload is migrated or left for the user to export
  (`rein export`) before the swap.

## Input and sensors

- Touch, biometrics (UFS/under-display), IMU, cameras: all Qualcomm/SoC-attached.
- Touch + basic input are expected on the `msm` input drivers; camera and
  biometric bring-up are lower priority for the OS swap and tracked as gates.

## What is dropped from the x86 layer

The x86-only packages and fixes do not apply and are excluded from the aarch64
stack (see `packages-aarch64.txt`): `nvidia-*`/`libva-nvidia-driver`,
`intel-ipu7-camera`, `intel-lpmd`, `intel-media-driver`, `libva-intel-driver`,
`linux-ptl`/`linux-ptl-headers`, and the per-vendor laptop scripts
(`intel/`, `apple/`, `nvidia.sh`, `vulkan.sh` x86 ICD, `asus/`, `framework/`,
`lenovo/`, `surface.sh`, `tuxedo*`).
