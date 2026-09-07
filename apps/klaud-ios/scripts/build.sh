#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
command -v xcodegen >/dev/null || { echo "Install XcodeGen first: brew install xcodegen" >&2; exit 1; }
xcodegen generate
xcodebuild \
  -project ReinKlaud.xcodeproj \
  -scheme ReinKlaud \
  -destination "${REIN_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro}" \
  build
