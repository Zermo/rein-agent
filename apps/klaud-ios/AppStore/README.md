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

## Internal TestFlight upload

Install and authenticate `asc`, then keep the credentials in its macOS Keychain profile. Export the app and team identifiers only for the release command:

```sh
export ASC_APP_ID="1234567890"
export REIN_APPLE_TEAM_ID="YOUR_TEAM_ID"
bash apps/klaud-ios/AppStore/publish-testflight.sh
```

Without `TESTFLIGHT_GROUP`, the script builds, tests, uploads, and waits for processing without assigning testers. Set `TESTFLIGHT_GROUP` to an internal group name or id to distribute the processed build, and set `TESTFLIGHT_NOTIFY=1` when testers should receive Apple's notification.
