The native rein-klaud Mac app includes the Rein gateway, CLI bundle, and its own
runtime. Apple Silicon and Intel ZIPs are separate downloads; the installer
selects the native architecture, checks SHA-256 and code-signature integrity,
and installs into `~/Applications`.

```sh
curl -fsSL https://github.com/Zermo/rein-agent/releases/latest/download/install-macos-app.sh | bash
```

This is a development distribution with an ad hoc signature. It is not
Developer ID signed or notarized. macOS may require its normal approval before
opening it. The installer does not change Gatekeeper or remove quarantine.
The Mac app is distributed directly from this repository, not through the
Mac App Store. iOS distribution is separate.

Quit rein-klaud before updating, then rerun the command. The previous app is
kept beside the new copy. Configuration, accounts, and conversations remain in
their existing local data directories. `--no-launch` installs without opening
the window.

The native app works without a global Node installation. Its local server runs
from `~/.rein/workspace` by default; it never uses the app bundle as a writable
project. Choose **Start local rein serve** in the first window, or connect to a
Rein loopback gateway already running on this Mac.
