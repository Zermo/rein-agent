# App Store Connect material

This directory contains public metadata and release notes for the native iOS app. It never stores App Store Connect keys, signing certificates, server tokens, review credentials, team identifiers, or app-specific passwords.

The release script reads those values from the operator's environment or the macOS Keychain. Internal TestFlight distribution still requires an App Store Connect app record whose bundle identifier matches the Xcode target.

Before external testing, replace the review note placeholder with a dedicated demonstration gateway and complete App Privacy, export-compliance, review-contact, and beta-review fields in App Store Connect.

## Store metadata

`metadata/app-info/en-US.json` and `metadata/version/0.1.0/en-US.json` use the canonical App Store Connect CLI 5 layout. Validate them before each release:

```sh
asc metadata validate \
  --dir apps/klaud-ios/AppStore/metadata \
  --check-urls
```

The support and privacy URLs expect the matching pages in the public GitHub wiki. Publish those pages before applying the metadata. A redirect to the wiki index does not provide a valid support or privacy page.

After the app record and version exist, review the planned changes before applying them:

```sh
asc metadata plan \
  --app "$ASC_APP_ID" \
  --version 0.1.0 \
  --platform IOS \
  --dir apps/klaud-ios/AppStore/metadata

asc metadata apply \
  --app "$ASC_APP_ID" \
  --version 0.1.0 \
  --platform IOS \
  --dir apps/klaud-ios/AppStore/metadata \
  --dry-run
```

## Upload with an account connected to Xcode

Xcode can sign and upload using the Apple Account in **Xcode > Settings > Accounts**. The `asc xcode` commands delegate to `xcodebuild`; they don't copy that account into `asc` API or web authentication.

For the first upload, open the signed archive in Xcode Organizer:

```sh
open apps/klaud-ios/.build/testflight/ReinKlaud.xcarchive
```

Choose **Distribute App > TestFlight Internal Only**. If the app record doesn't exist, enter `klaʊdbot`, SKU `rein-klaud-ios-001`, and English as the primary language. Confirm that the bundle identifier is `org.zermo.rein-klaud.ios`. Xcode can create the record and continue the upload with its connected account. The account needs permission to create apps. [Apple's TestFlight tutorial](https://developer.apple.com/tutorials/develop-in-swift/test-your-beta-app) describes this flow.

Internal-only builds cannot be used for external TestFlight testing or App Store release. For either of those later, upload a new build through **Distribute App > App Store Connect** instead.

Once the app record exists, the same signed archive can be uploaded through `asc xcode export`. Generate the upload options inside the ignored `.build` directory, taking the team from the archive:

```sh
python3 - <<'PY'
from pathlib import Path
import plistlib

release_dir = Path("apps/klaud-ios/.build/testflight")
archive = release_dir / "ReinKlaud.xcarchive"
with (archive / "Info.plist").open("rb") as source:
    team = plistlib.load(source)["ApplicationProperties"]["Team"]
if not isinstance(team, str) or not team:
    raise SystemExit("The signed archive has no development team.")
with (release_dir / "UploadExportOptions.plist").open("wb") as target:
    plistlib.dump({
        "method": "app-store-connect",
        "destination": "upload",
        "signingStyle": "automatic",
        "testFlightInternalTestingOnly": True,
        "teamID": team,
    }, target)
PY

asc xcode export \
  --archive-path apps/klaud-ios/.build/testflight/ReinKlaud.xcarchive \
  --export-options apps/klaud-ios/.build/testflight/UploadExportOptions.plist \
  --ipa-path apps/klaud-ios/.build/testflight/ReinKlaud.ipa \
  --xcodebuild-flag=-allowProvisioningUpdates
```

`destination=upload` sends the build to Apple and does not write an IPA. A local export alone does not upload anything. Choose either Organizer or the command for a given build, then check its processing status in App Store Connect before assigning it to a TestFlight group.

Omit `--wait` unless `asc auth status --validate` confirms API authentication. Upload uses Xcode's account, but `asc` build polling and TestFlight group management require its own API credentials. Keep the generated plist, signing material, and account identifiers out of Git.

## Internal TestFlight upload with API authentication

Install and authenticate `asc`, then keep the credentials in its macOS Keychain profile. Export the app and team identifiers only for the release command:

```sh
export ASC_APP_ID="1234567890"
export REIN_APPLE_TEAM_ID="YOUR_TEAM_ID"
bash apps/klaud-ios/AppStore/publish-testflight.sh
```

Without `TESTFLIGHT_GROUP`, the script builds, tests, uploads, and waits for processing without assigning testers. Set `TESTFLIGHT_GROUP` to an internal group name or id to distribute the processed build, and set `TESTFLIGHT_NOTIFY=1` when testers should receive Apple's notification.
