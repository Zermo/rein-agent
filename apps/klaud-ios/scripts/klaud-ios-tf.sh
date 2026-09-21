#!/bin/bash
# TestFlight upload — blocked unless Tom minted .tom-ok-ios (scope testflight|both).
set -euo pipefail
ROOT="/Users/macmini/Projects/rein-agent-private"
GUARD="$ROOT/apps/klaud-ios/scripts/ios-guard.sh"
"$GUARD" require testflight

export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Xcode.app/Contents/Developer/usr/bin
LOG=/tmp/klaud-ios-tf.log
exec > >(tee -a "$LOG") 2>&1
echo "START $(date -u +%Y-%m-%dT%H:%M:%SZ) (guarded)"
cd "$ROOT/apps/klaud-ios"
TEAM=FMYLGYWYXW
OUT=/Users/macmini/Projects/klaud-ios-dist
mkdir -p "$OUT"
ARCHIVE="$OUT/ReinKlaud.xcarchive"
rm -rf "$ARCHIVE" "$OUT/export"
xcodebuild archive \
  -project ReinKlaud.xcodeproj \
  -scheme ReinKlaud \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates

cat > "$OUT/ExportOptions.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>upload</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>FMYLGYWYXW</string>
  <key>uploadSymbols</key>
  <true/>
  <key>manageAppVersionAndBuildNumber</key>
  <true/>
</dict>
</plist>
PLIST

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT/export" \
  -allowProvisioningUpdates

"$GUARD" consume testflight
echo "DONE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
