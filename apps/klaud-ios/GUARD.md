# iOS ship gate

`ios` is a **manual-only** lane. No agent may commit, push, archive, or TestFlight-upload without Tom saying **ok ios** in the same turn, then minting a one-shot receipt.

## Tom okay (on the Mini)

```bash
cd /Users/macmini/Projects/rein-agent-private
./apps/klaud-ios/scripts/ios-ok.sh both     # git + TestFlight, 2 hours
./apps/klaud-ios/scripts/ios-ok.sh git      # push only
./apps/klaud-ios/scripts/ios-ok.sh testflight
```

Receipt: `.tom-ok-ios` (gitignored, single-use, then deleted).

Blocked attempts: macOS notification + `/Users/macmini/Projects/klaud-ios-dist/ios-guard.log`.

## What is gated

- `git commit` touching `apps/klaud-ios/`
- `git push` of branch `ios`
- `/tmp/klaud-ios-tf.sh` (and `scripts/klaud-ios-tf.sh`)

Agents must not write `.tom-ok-ios` or run `ios-ok.sh` unless Tom just said ok.
