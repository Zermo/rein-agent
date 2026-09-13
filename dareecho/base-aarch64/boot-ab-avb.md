# Boot — A/B + AVB, the unlock gate, and the side-by-side swap

The x86 base boots from UEFI/GPT. The S25 Ultra boots through the Android
bootloader with **A/B slots** and **Android Verified Boot (AVB)**. This is how
Dareecho is built **side by side** and then **swapped in**.

## Measured boot state

- `ro.boot.slot_suffix = _a` (active slot A)
- AVB `ro.boot.avb_version = 1.3`
- `ro.boot.verifiedbootstate = green` (verified boot fully enforced)
- `ro.boot.flash.locked = 1` (bootloader locked)
- `ro.oem_unlock_supported` **empty** — US model `S938U`

## The unlock gate (the access problem)

To flash Dareecho into slot `_b` and change the default boot, the bootloader
must be unlocked. On the S25 Ultra **US model (S938U)** this is the hard gate:

- Samsung does **not** expose an OEM-unlock path on US models
  (`ro.oem_unlock_supported` is unset). International Samsung models offer an
  "OEM unlock" toggle; the S938U does not.
- Unlocking on a US model generally requires a carrier/region path or a
  service-level method, and **wipes the device**.
- Until this clears, the full swap is **blocked** — the phone can still run
  Dareecho as the userland/UI/launcher experience (the overlay path), but it
  cannot boot Dareecho as the replaced OS.

This is the first gate in `gates.md` and the one the `rein learn` dossier
surfaces as the `verified-boot` invariant.

## Side-by-side (A/B) install, once unlocked

1. **Preserve**: `rein export` the user's data; snapshot slot `_a`.
2. **Build** the Dareecho aarch64 image (this directory) as a set of A/B
   partitions: `boot_b`, `system_b` (or the Omarchy rootfs), `vendor_b`,
   `vbmeta_b`, `dtbo_b`, plus the Dareecho userland.
3. **Sign** `vbmeta_b` and each partition for AVB 1.3 so the green
   verified-boot chain is satisfied (or the chain is re-keyed consistently).
4. **Flash** to slot `_b` (`fastboot`), leave slot `_a` intact.
5. **Boot** into `_b`, verify Dareecho comes up (GPU, display, network, the
   Rein harness, the Factory UI, the launcher).
6. **Swap** the default to `_b` only after verification. Slot `_a` (Android)
   remains the rollback target until the user confirms.

This is the "rebuild Dareecho side by side as it replaces the original OS" —
the replacement is reversible to slot `_a` until it is confirmed.

## Gate

The **unlock** is the access gate; the **AVB signing** and the **SM8750
kernel/GPU/display** are the correctness gates. All are listed in `gates.md`.
