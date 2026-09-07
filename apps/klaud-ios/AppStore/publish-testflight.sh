#!/usr/bin/env bash
set -euo pipefail

fail() {
    printf '%s\n' "$*" >&2
    exit 1
}

command -v asc >/dev/null 2>&1 || fail 'Install App Store Connect CLI 5.x with: brew install asc'
command -v xcodebuild >/dev/null 2>&1 || fail 'Install Xcode and select it with xcode-select.'
command -v xcodegen >/dev/null 2>&1 || fail 'Install XcodeGen with: brew install xcodegen'

: "${ASC_APP_ID:?Set ASC_APP_ID to the numeric App Store Connect app id.}"
: "${REIN_APPLE_TEAM_ID:?Set REIN_APPLE_TEAM_ID to the Apple Developer team id.}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ios_root="$(cd -- "$script_dir/.." && pwd -P)"
build_root="$ios_root/.build/testflight"
project="$ios_root/ReinKlaud.xcodeproj"
notes_file="$script_dir/metadata/en-US/test_notes.txt"

export ASC_TELEMETRY_DISABLED=1
export REIN_APPLE_TEAM_ID

# `asc auth status --validate` exits successfully even when no profile exists.
# Verify both authentication and access to the requested app before a long build.
asc apps view --id "$ASC_APP_ID" >/dev/null
xcodegen generate --spec "$ios_root/project.yml" --project "$ios_root"

xcodebuild test \
    -project "$project" \
    -scheme ReinKlaud \
    -destination "${REIN_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro}" \
    -derivedDataPath "$build_root/DerivedData"

mkdir -p "$build_root"
publish=(
    asc publish testflight
    --app "$ASC_APP_ID"
    --project "$project"
    --scheme ReinKlaud
    --version 0.1.0
    --signing-style automatic
    --team-id "$REIN_APPLE_TEAM_ID"
    --archive-path "$build_root/ReinKlaud.xcarchive"
    --ipa-path "$build_root/ReinKlaud.ipa"
    --test-notes "$(cat "$notes_file")"
    --locale en-US
    --clean
    --wait
    --output json
)

if [[ -n "${TESTFLIGHT_GROUP:-}" ]]; then
    publish+=(--group "$TESTFLIGHT_GROUP")
    [[ "${TESTFLIGHT_NOTIFY:-0}" == 1 ]] && publish+=(--notify)
else
    publish+=(--upload-only)
fi

"${publish[@]}"
