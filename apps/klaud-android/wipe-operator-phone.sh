#!/usr/bin/env bash
# Wipe this business Ultra, then put only klaʊdbot back.
# System preloads survive a factory reset; they are disabled after boot.
# Does not unlock the bootloader. Does not trip Knox.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APK="${KLAUD_APK:-$ROOT/app/build/outputs/apk/debug/app-debug.apk}"
PKG="org.zermo.klaud"
SERIAL="${ANDROID_SERIAL:-${SERIAL:-R5CY134R03V}}"
ADB=(adb -s "$SERIAL")

KEEP=(
  org.zermo.klaud
  com.samsung.android.dialer
  com.samsung.android.messaging
  com.google.android.apps.messaging
  com.android.phone
  com.sec.phone
  com.samsung.android.honeyboard
  com.sec.android.app.launcher
  com.sec.android.app.camera
  com.sec.android.gallery3d
  com.samsung.android.calendar
  com.sec.android.app.clockpackage
  com.sec.android.app.popupcalculator
  com.samsung.android.app.contacts
  com.samsung.android.app.telephonyui
  com.google.android.webview
  com.google.android.gms
  com.google.android.gsf
  com.google.android.permissioncontroller
  com.google.android.packageinstaller
  com.android.settings
)

# User-facing bloat. Leave Knox/core services alone.
DISABLE=(
  com.google.android.googlequicksearchbox
  com.google.android.apps.bard
  com.android.hotwordenrollment.okgoogle
  com.android.hotwordenrollment.xgoogle
  com.google.android.gm
  com.android.chrome
  com.google.android.youtube
  com.google.android.videos
  com.google.android.apps.docs
  com.google.android.apps.photos
  com.google.android.apps.maps
  com.google.android.apps.walletnfcrel
  com.google.android.apps.tachyon
  com.google.ar.core
  com.samsung.android.bixby.agent
  com.samsung.android.bixby.wakeup
  com.samsung.android.bixby.ondevice.enus
  com.samsung.android.bixby.ondevice.esus
  com.samsung.android.bixbyvision.framework
  com.samsung.android.intellivoiceservice
  com.samsung.android.callassistant
  com.samsung.android.oneconnect
  com.samsung.android.tvplus
  com.samsung.android.voc
  com.samsung.android.spay
  com.samsung.android.spayfw
  com.samsung.android.samsungpass
  com.samsung.android.samsungpassautofill
  com.samsung.android.app.find
  com.samsung.android.kidsinstaller
  com.sec.android.app.chromecustomizations
  com.sec.android.app.kids3d
  com.sec.kidsplat.camera
  com.sec.kidsplat.kidsbcg
  com.sec.kidsplat.kidsbrowser
  com.sec.kidsplat.kidsgallery
  com.sec.kidsplat.kidstalk
  com.sec.kidsplat.media.kidsmusic
  com.sec.kidsplat.phone
  com.facebook.appmanager
  com.facebook.services
  com.facebook.system
  com.tmobile.m1
  com.tmobile.tuesdays
  com.tmobile.vvm.application
  com.tmobile.echolocate
  com.dti.tmobile
  com.tmobile.pr.adapt
  com.tmobile.dm.cm
  com.tmobile.dm.ms.services
)

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

  check       Device + APK present
  debloat     Disable preload bloat (safe to re-run)
  provision   Install klaʊdbot, permissions, assistant role, debloat
  wipe        Factory-reset via test harness (keeps ADB keys), then provision

Wipe requires:  $(basename "$0") wipe --i-understand-wipe

After wipe, the phone reboots. This script waits, then provisions.
If Samsung still shows a setup wizard, tap through it (skip Google restore,
skip Samsung account extras). USB debugging stays authorized.
Then Setup in klaʊdbot: Rein host, bearer, Mailkit, personal number.
EOF
}

need_device() {
  "${ADB[@]}" get-state >/dev/null
}

wait_boot() {
  echo "Waiting for $SERIAL …"
  adb wait-for-device -s "$SERIAL"
  local i=0
  while true; do
    local boot
    boot="$("${ADB[@]}" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
    if [[ "$boot" == "1" ]]; then
      echo "Boot complete."
      return 0
    fi
    i=$((i + 1))
    if (( i % 6 == 0 )); then echo "  still booting (${i}0s)"; fi
    sleep 10
  done
}

pkg_installed() {
  "${ADB[@]}" shell pm path "$1" >/dev/null 2>&1
}

disable_pkg() {
  local p="$1"
  pkg_installed "$p" || return 0
  "${ADB[@]}" shell pm disable-user --user 0 "$p" >/dev/null 2>&1 \
    || "${ADB[@]}" shell pm uninstall --user 0 "$p" >/dev/null 2>&1 \
    || echo "  skip $p"
}

cmd_check() {
  need_device
  "${ADB[@]}" shell getprop ro.product.model
  "${ADB[@]}" shell getprop ro.serialno
  if [[ ! -f "$APK" ]]; then
    echo "Missing APK: $APK" >&2
    echo "Build with: (cd $ROOT && ./gradlew :app:assembleDebug)" >&2
    exit 1
  fi
  echo "APK $APK ($(du -h "$APK" | awk '{print $1}'))"
}

cmd_debloat() {
  need_device
  echo "Disabling preload bloat…"
  local p
  for p in "${DISABLE[@]}"; do
    disable_pkg "$p"
  done
  echo "Removing leftover user apps except klaʊdbot…"
  local line pkg
  while IFS= read -r line; do
    pkg="${line#package:}"
    pkg="${pkg%%$'\r'}"
    [[ -n "$pkg" ]] || continue
    local keep=0 k
    for k in "${KEEP[@]}"; do
      if [[ "$pkg" == "$k" ]]; then keep=1; break; fi
    done
    (( keep )) && continue
    "${ADB[@]}" shell pm uninstall --user 0 "$pkg" >/dev/null 2>&1 || true
  done < <("${ADB[@]}" shell pm list packages -3)
  echo "Debloat done."
}

cmd_provision() {
  need_device
  [[ -f "$APK" ]] || { echo "Missing $APK" >&2; exit 1; }
  echo "Installing klaʊdbot…"
  "${ADB[@]}" install -r -t --user 0 "$APK"
  "${ADB[@]}" shell pm grant "$PKG" android.permission.RECORD_AUDIO || true
  "${ADB[@]}" shell pm grant "$PKG" android.permission.CALL_PHONE || true
  "${ADB[@]}" shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true
  "${ADB[@]}" shell cmd role add-role-holder android.app.role.ASSISTANT "$PKG" || true
  echo "Assistant holders: $("${ADB[@]}" shell cmd role get-role-holders android.app.role.ASSISTANT | tr -d '\r')"
  cmd_debloat
  "${ADB[@]}" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
  echo
  echo "klaʊdbot is the assistant. Open Setup and paste:"
  echo "  Rein host     rein serve --mobile --host <this-Mac-IP> --port 4318"
  echo "  Bearer token  from the host token file"
  echo "  Mailkit URL   http://<mac>:8765/ui/"
  echo "  Personal line your other phone number"
}

skip_wizard() {
  "${ADB[@]}" shell settings put global device_provisioned 1 || true
  "${ADB[@]}" shell settings put secure user_setup_complete 1 || true
  "${ADB[@]}" shell settings put global user_setup_complete 1 || true
  "${ADB[@]}" shell settings put secure android_id_setup_complete 1 || true
}

cmd_wipe() {
  if [[ "${1:-}" != "--i-understand-wipe" ]]; then
    echo "This erases every account, photo, and app on $SERIAL." >&2
    echo "klaʊdbot is reinstalled from:" >&2
    echo "  $APK" >&2
    echo "Re-run: $0 wipe --i-understand-wipe" >&2
    exit 2
  fi
  cmd_check
  echo "Enabling test harness (wipe + keep ADB keys)…"
  "${ADB[@]}" shell cmd testharness enable
  echo "Wipe issued. Phone is resetting."
  sleep 8
  wait_boot
  # Samsung may still show a wizard; mark provisioned so we can talk ADB.
  skip_wizard
  sleep 3
  cmd_provision
}

case "${1:-}" in
  check) cmd_check ;;
  debloat) cmd_debloat ;;
  provision) cmd_provision ;;
  wipe) cmd_wipe "${2:-}" ;;
  -h|--help|help|"") usage ;;
  *) usage; exit 2 ;;
esac
