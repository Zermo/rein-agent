# Fold components in Rein

Source: https://github.com/humanlayer/fold
Revision: `7c5cc8dab311b8575e4a79162964839822b836b6`
License: MIT, copyright 2026 HumanLayer (see LICENSE).

Rein integrates Fold's pure repeated-tool-batch stop policy and UTF-8 truncation
code. The stop-policy port removes only the Effect import and service registration;
the detector remains unchanged. Truncation.ts is an exact upstream copy.
The native skill tool follows Fold's session-stable roster and on-demand loading
design; it is implemented against Rein's tool API.

Exact reference files are in upstream/. manifest.json records every source hash.
This is a component integration, not the complete Fold CLI or Effect runtime.
Rein retains its provider adapters, Posthorse no-summary windows, and session store.
