# Kernel and device tree — aarch64 / SM8750 ("sun")

The x86 base uses the stock Arch x86-64 kernel (plus the `linux-ptl` Panther
Lake swap). On the S25 Ultra the kernel must be an **aarch64 mainline kernel**
with the Qualcomm SM8750 platform enabled.

## Selection

- **Upstream**: Linux mainline (aarch64), ≥ the first release that carries the
  SM8750/"sun" platform and the `msm` DRM + `msm_gpu` components at a usable
  level. Track the exact version in the build log once selected.
- **Config** (aarch64, `arm64` defconfig baseline +):
  - `CONFIG_ARCH_QCOM` (the Qualcomm platform family)
  - `CONFIG_DRM_MSM` (DPU) + `CONFIG_MSM_HYP` as required
  - `CONFIG_DRM_MSM_HDMI` n/a; **DSI** enabled
  - `CONFIG_MSM_GPU` / freedreno Adreno for this SoC
  - `CONFIG_QCOM_WCNSS` / modem + `CONFIG_NET_VENDOR_QCA` (RMNET/QMI)
  - `CONFIG_SPI`/`CONFIG_MMC`/`CONFIG_UFS` storage
  - `CONFIG_ARM64_VA_BITS_48`, `CONFIG_ARM64_64K_PAGES` (16K/64K page support for
    the 11 GB RAM and UFS)
  - `CONFIG_ANDROID_BINDER_IPC`, `CONFIG_ANDROID_BINDERFS` (for the Android
    HALs that must keep working during the side-by-side phase)
- **Firmware**: `linux-firmware` subset for `qcom` (GPU, WCNSS, modem, display)
  pulled for SM8750.

## Device tree

- The SM8750/"sun" DTB (SoC + the S25 Ultra board overlay) must be present.
  Where Samsung ships it only in the Android tree, the port carries the needed
  SoC DT + board overlay and the panel/modem nodes.
- The active Android DT is `sun` per `ro.board.platform`; the build records the
  exact DTB name(s) it uses.

## initramfs

- `mkinitcpio` (archlinuxarm) with `microcode` n/a, `msm`/`msm_gpu`,
  `msm_drm`, `ufs`/`mmc`, `qcom` storage, and the FBE/`crypt` modules if the
  data payload is to be read.

## Upstream state (grounded)

The SM8750 SoC is **largely mainlined** (verified against `torvalds/linux`):
clock controllers (`gpucc`/`tcsrcc`/`videocc`/`camcc`/`dispcc`-`sm8750.c`),
the **DPU display** (`dpu_12_0_sm8750.h`), interconnect (`sm8750.c`), camera
(`iris_platform_sm8750.h`), and a QRD device tree (`sm8750-qrd.dts`). This is
not a greenfield SoC bring-up.

The open kernel work is narrower:
- the exact S25 Ultra **`sun` board** overlay (panel, modem, cameras) —
  upstream has the QRD board, not Samsung's `sun` board;
- the **Adreno GPU 3D/Vulkan** driver — SM8750 is not yet in
  `drivers/gpu/drm/msm/adreno` (display DPU is separate and mainlined);
- modem/telephony bring-up (non-blocking for boot).

See `gates.md` for the full gate map and status.
