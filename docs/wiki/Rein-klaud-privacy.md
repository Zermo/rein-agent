# rein-klaʊd privacy

Effective September 6, 2026

rein-klaʊd is a client for a Rein server chosen and controlled by the operator. Zermo does not receive the server address, access token, prompts, transcripts, tool activity, model responses, or files sent through the app.

The app contains no advertising, tracking, analytics, or third-party crash-reporting SDK. It does not create an account with Zermo. Connection details stay on the device. The access token is stored in the Apple Keychain, and display preferences are stored in the app's local settings.

When the operator connects, the app sends requests directly to the Rein server they selected. A Rein server can in turn use model providers and tools configured by its operator. Those services have their own privacy practices. Local-network access is used only to find and connect to Rein servers on networks the operator can access.

The app displays conversations stored by the selected Rein server. Removing a saved connection deletes its device credential. Uninstalling the app deletes its local app data. Server-side sessions and configuration remain under the operator's control and can be removed on that host.

Questions and privacy requests can be filed in the [Rein issue tracker](https://github.com/Zermo/rein-agent/issues).

Material changes to this policy will be recorded in this page's public revision history.
