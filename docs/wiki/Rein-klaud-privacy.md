# rein-klaʊd privacy

Effective September 6, 2026

rein-klaʊd connects to Rein hosts and model APIs chosen by the operator. Zermo does not operate an intermediary for these connections or receive their server addresses, credentials, prompts, transcripts, tool activity, model responses, or files.

The app contains no advertising, tracking, analytics, or third-party crash-reporting SDK. It does not create an account with Zermo.

## Connections and credentials

Gateway addresses, API account names, endpoints, model selections, and display preferences are stored in the app's local settings. Gateway bearer tokens and API keys are stored in the Apple Keychain with this-device-only protection. API keys are scoped to a saved account and its endpoint. Changing the endpoint does not move its previous key to the new address. The app does not write credentials to logs.

When the operator authorizes a subscription, the selected Rein host runs the official Codex, Copilot, or Grok CLI. The app receives a verification URL, one-time code, and status, and opens the provider's sign-in page when the operator chooses it. The official CLI manages subscription credentials on that host. The app does not copy its access or refresh tokens to the phone or to a direct API provider.

The operator can explicitly choose **Use this API on connected host** to send an API account's endpoint, model, and key to that host for future runs. Gateway bearer tokens are used only with their selected Rein host and are never included in direct model-provider requests.

## Messages and fallback

Host conversations are sent directly to the Rein server the operator selects. That host can use model providers and tools configured by its operator. Local-network access finds and connects to reachable Rein hosts and configured private model APIs. Discovery does not scan subnets.

In direct conversation, the phone sends the conversation to the selected self-hosted or cloud API endpoint. The app saves these direct transcripts in protected Application Support files and excludes them from device backups. Host sessions remain on their host. The app also keeps a protected, backup-excluded retry record for a host request until acceptance is confirmed or the record is discarded or expires.

Automatic fallback is off by default. When enabled, new work can use saved backup hosts or API accounts after eligible connection failures. Backup hosts keep their own sessions. Accepted tasks and requests with unknown delivery are never replayed on another host or provider. Direct API requests can try other saved API accounts after eligible failures when the operator enables fallback.

Including recent visible host messages in a new direct fallback conversation is a separate option and is off by default. When enabled, it copies recent operator and assistant text while excluding tool results, tool-call messages, and unsent optimistic messages. Those messages are then sent to the selected API provider. Starting a new direct conversation creates a separate local transcript.

Rein hosts, cloud providers, and the identity providers used for subscription sign-in have their own retention and privacy practices. Content sent to them is subject to the operator's configuration and their policies.

## Removing data

Remove an API account or backup host in Accounts to delete its saved device credential. Forget a saved primary connection to remove that gateway credential. These actions do not delete existing direct transcripts, host sessions, or copies retained by providers. Uninstalling the app removes its local app files; remove saved credentials in the app first if you also want them removed from Keychain. Server-side sessions and configuration remain under the operator's control.

Questions and privacy requests can be filed in the [Rein issue tracker](https://github.com/Zermo/rein-agent/issues). Do not include credentials, private addresses, or transcripts in a public issue.

Material changes to this policy will be recorded in this page's public revision history.
