#!/bin/bash
# Direct macOS app installer. Source this file to test its command boundaries.
set -euo pipefail

rein_mac_note() { printf '%s\n' "$*"; }
rein_mac_fail() { printf 'rein-klaud: %s\n' "$*" >&2; return 1; }
rein_mac_bundle_id() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null; }
rein_mac_running() {
    local executable
    executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$1/Contents/Info.plist" 2>/dev/null) || executable=''
    case "$executable" in
        ''|.|..|*/*|*\\*) ;;
        *)
            # Electron changes its process title, hiding the original path from
            # ps. Inspect the actual mapped executable, including owned servers.
            if /usr/sbin/lsof -t -a -d txt "$1/Contents/MacOS/$executable" >/dev/null 2>&1; then return 0; fi ;;
    esac
    # A helper can briefly outlive the main process. Match this exact app's
    # executable directories, never a similarly named app or arbitrary argument.
    ps -axo command= | REIN_MAC_CHECK_APP="$1" awk 'BEGIN { app=ENVIRON["REIN_MAC_CHECK_APP"] } index($0, app "/Contents/MacOS/") == 1 || index($0, app "/Contents/Frameworks/") == 1 { found = 1 } END { exit !found }'
}
rein_mac_verify_signature() { codesign --verify --deep --strict "$1" >/dev/null 2>&1; }
rein_mac_gatekeeper() { spctl --assess --type execute "$1" >/dev/null 2>&1; }
rein_mac_verify_arch() {
    local executable description arch="$2"
    executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$1/Contents/Info.plist" 2>/dev/null) || return 1
    case "$executable" in ''|.|..|*/*|*\\*) return 1 ;; esac
    [ "$arch" != x64 ] || arch=x86_64
    # file ships with macOS; lipo can require a separate Xcode CLT install.
    description=$(LC_ALL=C /usr/bin/file -b "$1/Contents/MacOS/$executable") || return 1
    case "$description" in "Mach-O "*) ;; *) return 1 ;; esac
    printf '%s\n' "$description" | LC_ALL=C awk -v arch="$arch" '{ for (i=1; i<=NF; i++) if ($i == arch) found=1 } END { exit !found }'
}
rein_mac_arch() {
    local machine
    machine=$(uname -m)
    # A Rosetta shell should still install the native Apple Silicon build.
    if [ "$machine" = arm64 ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then printf 'arm64\n'
    elif [ "$machine" = x86_64 ]; then printf 'x64\n'
    else return 1; fi
}
rein_mac_download() {
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 600 --max-filesize "$3" --output "$2" "$1"
}
rein_mac_checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
rein_mac_unpack() {
    # macOS bsdtar reads ZIP and refuses writes through archive symlinks.
    tar -xf "$1" --no-same-owner --no-same-permissions -C "$2"
}
rein_mac_archive_paths() { tar -tf "$1"; }
rein_mac_launch() { open -a "$1"; }

rein_macos_main() (
    # This function already owns a subshell. Keep cleanup state in that shell:
    # Bash 3.2 can unwind function-local variables before an errexit EXIT trap.
    local_archive='' checksum='' launch=true release_base="${REIN_APP_RELEASE_BASE:-https://github.com/Zermo/rein-agent/releases/latest/download}"
    destination="${REIN_APP_INSTALL_DIR:-$HOME/Applications}" machine='' app='' archive='' checksum_file='' temporary='' staged='' backup='' lock='' restored=false gatekeeper=false
    while [ $# -gt 0 ]; do
        case "$1" in
            --no-launch) launch=false ;;
            --archive) [ $# -ge 2 ] || { rein_mac_fail '--archive requires a local ZIP path'; exit 2; }; local_archive="$2"; shift ;;
            --sha256) [ $# -ge 2 ] || { rein_mac_fail '--sha256 requires the local archive hash'; exit 2; }; checksum="$2"; shift ;;
            -h|--help)
                printf '%s\n' 'Install the native rein-klaud Mac app into ~/Applications.' \
                    'Default: download the current GitHub release for this Mac.' \
                    '  --no-launch              Install without opening the app' \
                    '  --archive FILE --sha256 HASH  Install a local development package' \
                    'REIN_APP_INSTALL_DIR sets a different absolute Applications directory.'
                exit 0 ;;
            *) rein_mac_fail "Unknown app installer option: $1"; exit 2 ;;
        esac
        shift
    done
    [ "$(uname -s)" = Darwin ] || { rein_mac_fail 'The native app is currently available for macOS. Rein CLI remains available on Linux and WSL.'; exit 1; }
    machine=$(rein_mac_arch) || { rein_mac_fail 'This Mac architecture is not supported. Use the Rein CLI.'; exit 1; }
    case "$destination" in /*) ;; *) rein_mac_fail 'REIN_APP_INSTALL_DIR must be an absolute directory'; exit 1 ;; esac
    [ ! -L "$destination" ] || { rein_mac_fail 'The Applications destination is a symlink; choose an ordinary directory.'; exit 1; }
    app="$destination/rein-klaud.app"
    if [ -e "$app" ] || [ -L "$app" ]; then
        [ ! -L "$app" ] && [ -d "$app" ] && [ "$(rein_mac_bundle_id "$app")" = org.zermo.rein-klaud ] || { rein_mac_fail "Another app or link already exists at $app. It was preserved."; exit 1; }
        rein_mac_verify_signature "$app" || { rein_mac_fail 'The existing app has local changes or an invalid signature. Preserve it elsewhere before installing an update.'; exit 1; }
        if rein_mac_running "$app"; then rein_mac_fail 'Quit rein-klaud before updating its app. Its running copy was preserved.'; exit 1; fi
    fi
    mkdir -p "$destination" || { rein_mac_fail 'Could not create the Applications directory.'; exit 1; }
    lock="$destination/.rein-klaud-install.lock"
    mkdir "$lock" 2>/dev/null || { rein_mac_fail 'Another app installation is in progress. Retry after it finishes.'; exit 1; }
    cleanup() {
        set +e
        # Only staging directories created above are removed. Previous apps survive.
        if [ "$restored" = false ] && [ -n "$backup" ] && [ -e "$backup" ] && [ ! -e "$app" ]; then mv "$backup" "$app" || true; fi
        [ -z "$temporary" ] || rm -rf "$temporary"
        [ -z "$staged" ] || rm -rf "$staged"
        [ -z "$lock" ] || rmdir "$lock" 2>/dev/null || true
    }
    trap cleanup EXIT
    temporary=$(mktemp -d "${TMPDIR:-/tmp}/rein-klaud-download.XXXXXXXX") || exit 1
    staged=$(mktemp -d "$destination/.rein-klaud-install.XXXXXXXX") || exit 1
    archive="$temporary/rein-klaud-macos-$machine.zip"
    if [ -n "$local_archive" ]; then
        [ -f "$local_archive" ] && [ ! -L "$local_archive" ] || { rein_mac_fail 'Local package must be an ordinary ZIP file.'; exit 1; }
        cp "$local_archive" "$archive" || { rein_mac_fail 'Could not stage the selected archive.'; exit 1; }
        rein_mac_note 'Installing an explicitly selected local development package.'
    else
        case "$release_base" in https://github.com/Zermo/rein-agent/releases/latest/download|https://github.com/Zermo/rein-agent/releases/download/*) ;; *) rein_mac_fail 'App downloads must use the Rein GitHub release origin.'; exit 1 ;; esac
        checksum_file="$temporary/checksum"
        rein_mac_download "$release_base/rein-klaud-macos-$machine.zip.sha256" "$checksum_file" 1024 || { rein_mac_fail "No app checksum is available for $machine. See https://github.com/Zermo/rein-agent/releases and rerun this installer after an app release is published."; exit 1; }
        checksum=$(awk 'NR == 1 { print $1 }' "$checksum_file")
        rein_mac_download "$release_base/rein-klaud-macos-$machine.zip" "$archive" 1073741824 || { rein_mac_fail 'App download failed. The installed app was preserved; retry this curl command.'; exit 1; }
    fi
    [[ "$checksum" =~ ^[a-fA-F0-9]{64}$ ]] || { rein_mac_fail 'The app checksum is missing or invalid.'; exit 1; }
    [ "$(rein_mac_checksum "$archive")" = "$(printf '%s' "$checksum" | tr 'A-F' 'a-f')" ] || { rein_mac_fail 'App checksum verification failed. Nothing was installed.'; exit 1; }
    rein_mac_archive_paths "$archive" > "$temporary/paths" || { rein_mac_fail 'The app archive is unreadable.'; exit 1; }
    awk 'BEGIN { ok=1; count=0 } { count++; if ($0 !~ /^rein-klaud[.]app(\/|$)/ || $0 ~ /(^|\/)\.\.(\/|$)/ || $0 ~ /\\/) ok=0 } END { exit !(ok && count > 0) }' "$temporary/paths" || { rein_mac_fail 'The archive contains an unexpected path. Nothing was extracted.'; exit 1; }
    rein_mac_unpack "$archive" "$staged" || { rein_mac_fail 'Could not unpack the app. The installed app was preserved.'; exit 1; }
    [ ! -L "$staged/rein-klaud.app" ] && [ "$(rein_mac_bundle_id "$staged/rein-klaud.app")" = org.zermo.rein-klaud ] || { rein_mac_fail 'The downloaded app identity is invalid.'; exit 1; }
    rein_mac_verify_signature "$staged/rein-klaud.app" || { rein_mac_fail 'The app signature is invalid. Nothing was installed.'; exit 1; }
    rein_mac_verify_arch "$staged/rein-klaud.app" "$machine" || { rein_mac_fail 'The app executable does not support this Mac architecture.'; exit 1; }
    if rein_mac_gatekeeper "$staged/rein-klaud.app"; then gatekeeper=true; fi
    # Recheck immediately before publishing; do not replace a newly opened app.
    if [ -e "$app" ] || [ -L "$app" ]; then
        [ ! -L "$app" ] && [ "$(rein_mac_bundle_id "$app")" = org.zermo.rein-klaud ] && rein_mac_verify_signature "$app" || { rein_mac_fail 'The existing app changed during installation. It was preserved.'; exit 1; }
        if rein_mac_running "$app"; then rein_mac_fail 'The app opened during installation. Quit it and retry.'; exit 1; fi
        backup="$destination/rein-klaud.previous-$(date +%Y%m%d%H%M%S)-${staged##*.}.app"
        [ ! -e "$backup" ] || { rein_mac_fail 'The app backup path already exists.'; exit 1; }
        mv "$app" "$backup" || { rein_mac_fail 'Could not preserve the existing app; update stopped.'; exit 1; }
    fi
    mv "$staged/rein-klaud.app" "$app" || { rein_mac_fail 'Could not place the app; restoring the previous copy.'; exit 1; }
    restored=true
    rein_mac_note "Installed native app: $app"
    [ -z "$backup" ] || rein_mac_note "Previous app preserved: $backup"
    [ "$gatekeeper" = true ] || rein_mac_note 'macOS has not approved this build on this machine. Development releases are not notarized; normal macOS approval checks still apply. No system protections were changed.'
    if [ "$launch" = true ]; then rein_mac_launch "$app" || { rein_mac_fail "The app installed, but macOS could not open it. Open $app from Finder."; exit 1; }; fi
)

if [ -z "${BASH_SOURCE[0]:-}" ] || [ "${BASH_SOURCE[0]}" = "$0" ]; then rein_macos_main "$@"; fi
