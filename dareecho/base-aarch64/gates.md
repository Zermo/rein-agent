# Gates — aarch64 base port (S25 Ultra)

Honest status of the swap. A gate is **blocked** if it stops the whole swap,
**gate** if it must clear before the image is validated, or **ready** if it is
satisfied by the portable userland or by the measured device.

Order = dependency order for the swap.

| # | Gate | Status | Why |
| - | --- | --- | --- |
| 1 | `bootloader-unlock` | **blocked** | S938U is a **US** model; `ro.oem_unlock_supported` is empty, so Samsung offers no OEM-unlock path. No unlock → no flashing slot `_b`, no default-boot swap. Also wipes the device. This is the access gate. |
| 2 | `board-dt-sun` | gate | The exact S25 Ultra board DT (Samsung's `sun` overlay: panel, modem, cameras) — upstream has `sm8750-qrd.dts` (QRD reference) but not the `sun` board. |
| 3 | `gpu-adreno` | gate | Adreno **3D/Vulkan** (`msm_gpu`/freedreno) for SM8750 is **not yet in mainline** (no SM8750 entry in `drivers/gpu/drm/msm/adreno`). The real frontier driver. Display (2D/DPU) is separate and mainlined. |
| 4 | `display-dsi` | gate | `msm-drm` DPU for SM8750 **is mainlined** (`dpu_12_0_sm8750.h`) — bring-up is the S25 Ultra `sun` panel over DSI. More tractable than a greenfield display. |
| 5 | `avb-signing` | gate | AVB 1.3 `vbmeta` + partition signing so the green verified-boot chain holds on the `_b` slot. |
| 6 | `modem-telephony` | gate | Qualcomm X modem + RIL. Non-blocking for boot/OS, blocking for a daily driver (calls/SMS/5G). |
| 7 | `userland-aarch64` | **ready** | Rein harness (Node≥18), Meat (WASM), Factory UI, OS identity are architecture-portable — repack the aarch64 Node runtime + kit payload. No reimplementation. |
| 8 | `omarchy-userland` | ready | The Omarchy shell/config/themes/applications are arch-portable; only the package builds are aarch64. |

## Grounded upstream state (mainline kernel, verified against `torvalds/linux`)

The SM8750 SoC is **largely mainlined** — this is not a greenfield port:

- Clock controllers: `drivers/clk/qcom/{gpucc,tcsrcc,videocc,camcc,dispcc,cambistmclkcc}-sm8750.c`
- DPU display: `drivers/gpu/drm/msm/disp/dpu1/catalog/dpu_12_0_sm8750.h`
- Interconnect: `drivers/interconnect/qcom/sm8750.c`
- Camera: `drivers/media/platform/qcom/iris/iris_platform_sm8750.h`
- Device tree: `arch/arm64/boot/dts/qcom/sm8750-qrd.dts` (QRD reference board)
- **Not yet mainlined**: the Adreno GPU 3D/Vulkan driver (no SM8750 in
  `drivers/gpu/drm/msm/adreno`) and the exact S25 Ultra `sun` board overlay.

So the SoC bring-up (clocks, display controller, interconnect, camera) is
upstream work already done; the open driver work is the **Adreno 3D** and the
**`sun` board** specifics.

## What is true today

- The **overlay path** (Dareecho userland + UI + launcher + onboarding on top
  of Android, in a proot/Debian or the Mac-hosted Factory) is the working
  "Dareecho on the Galaxy" experience and does not depend on any gate above.
- The **learn** pass already maps this device's trust chain
  (bootrom → ABOOT → AVB → kernel → userland) and names `verified-boot` as the
  invariant — that dossier is the input to gates 1, 5.

## The critical path

`bootloader-unlock` (1) is the first thing that must clear — it is the access
gate and is model-specific (US S938U). In parallel, the frontier engineering is
gates 2–4 (SM8750 kernel + Adreno + DSI). Gate 5 (AVB signing) then makes the
`_b` slot bootable under verified boot, and the swap (flash `_b`, verify, set
default) completes with slot `_a` as rollback.

## Not in scope for this definition

- A bootable image (requires gates 1–5 to clear and hardware-in-the-loop work).
- Camera, biometrics, and full telephony parity (lower priority; modem gate 6).
- A dual-boot coexistence of Android and Dareecho on the same slot (the model
  is A/B side-by-side, then swap).
