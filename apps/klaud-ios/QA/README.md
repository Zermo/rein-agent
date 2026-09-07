# Native iOS verification

The screenshots in this directory are simulator captures of the native SwiftUI
app. The onboarding images cover the iPhone 17 Pro, iPhone 17 Pro Max, and iPad
Pro 13-inch. All use the same approved field-guide artwork and palette as the
desktop app.

Run `../scripts/test.sh` from this directory after changes to the client. The
tests use local fixtures and do not call a model provider or require an API key.
Host transport coverage runs with:

```sh
node --test test/klaud-mobile.test.ts test/klaud-serve.test.ts test/harness.test.ts
```

Run that command from the repository root.

Before a TestFlight upload, verify on a simulator or device:

1. Connect to a test gateway and open an agent.
2. Send a task that pauses for approval. Background the app and reopen it.
3. Confirm the approval is restored, then allow or deny it.
4. Confirm the transcript distinguishes operator input, agent replies, and tool
   activity, and that the run returns to Ready.
5. Start another run, interrupt the network, and restore connectivity. Confirm
   the app resumes the tracked run without creating another one.
6. Switch between two test gateways while a refresh is in flight. Confirm the
   selected gateway retains its own credentials, state, and active run.
7. Check Light and Night themes, the sound switch, larger text sizes, and
   portrait and landscape layouts.

Use synthetic tasks and gateway details in screenshots. Keep signing identities,
tokens, and personal conversations out of this directory.

## Cloud accounts verification

The September 6 account build passes 77 native fixture tests and the 643-test
harness suite. An iPhone 17 Pro Max simulator also completed account setup and
a direct Chat Completions exchange against a synthetic local API, with no
provider credentials. The reply showed separate operator and agent labels.

Regression coverage includes endpoint-scoped credentials, bounded token-field
compatibility retries, CLI device authorization, cancelled account fallbacks,
draft retention during backup switching, field-unit changes during preflight,
and conversation restoration across new-thread selection and app relaunch.

Live subscription entitlement requires the operator's official CLI login on a
reachable host. Fixture tests do not claim to verify a paid provider account.
