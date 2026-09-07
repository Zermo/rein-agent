import SwiftUI
import SafariServices

struct CloudWorkspaceView: View {
    @ObservedObject var store: ReinAppStore
    @ObservedObject var workspace: CloudWorkspace
    @Environment(\.reinTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                BrandMasthead(compact: true)
                Picker("Connection workspace", selection: Binding(
                    get: { workspace.page },
                    set: { next in
                        if next == .chat { store.openDirectChat() }
                        else { workspace.page = .accounts }
                    }
                )) {
                    ForEach(CloudWorkspace.Page.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented).padding(16)
                if workspace.page == .accounts { CloudAccountsView(store: store, workspace: workspace, accounts: workspace.accounts) }
                else { DirectConversationView(store: store, workspace: workspace, accounts: workspace.accounts) }
            }.background(theme.paper).foregroundStyle(theme.ink)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Return to host") { dismiss() } } }
        }.tint(theme.accent)
    }
}

private struct CloudAccountsView: View {
    private enum SetupTab: String, CaseIterable { case api = "API keys", subscriptions = "Subscriptions", backups = "Backup hosts" }
    @ObservedObject var store: ReinAppStore
    @ObservedObject var workspace: CloudWorkspace
    @ObservedObject var accounts: CloudAccountStore
    @Environment(\.reinTheme) private var theme
    @State private var provider = CloudProvider.custom
    @State private var name = ""
    @State private var endpoint = ""
    @State private var model = ""
    @State private var key = ""
    @State private var outputLimit = 2048
    @State private var contextLimit = 32768
    @State private var backupName = ""
    @State private var backupURL = ""
    @State private var backupToken = ""
    @State private var listing: GatewayAccountListing?
    @State private var login: GatewayDeviceLogin?
    @State private var loginConnection: GatewayConnection?
    @State private var authModel = "default"
    @State private var busy = false
    @State private var message: String?
    @State private var website: AuthWebsite?
    @State private var setupTab = SetupTab.api

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                FieldLabel("Connection reserve")
                Text("YOUR MODELS. YOUR ROUTES.").font(.reinDisplay(.title))
                Text("Local models, cloud accounts, and a reserve connection when your host goes quiet.").font(.reinBody()).foregroundStyle(theme.muted)
                if let message { Text(message).font(.reinBody(.footnote)).foregroundStyle(theme.accent) }
                Picker("Account setup", selection: $setupTab) {
                    ForEach(SetupTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented)
                DisclosureGroup("Fallback & conversation sharing") {
                Toggle("Use saved fallbacks when a connection fails", isOn: Binding(get: { accounts.allowAutomaticFallback }, set: { accounts.setAutomaticFallback($0) })).tint(theme.accent).disabled(workspace.isRunning)
                Text("Before sending a new host request, try saved backup hosts in order, then the selected API account. Direct API requests may use the remaining accounts after a network or service error. Cloud billing and subscription limits still apply. A task with unknown delivery is never replayed on another host.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                Toggle("Include recent visible messages in direct fallback", isOn: $workspace.includeRecentMessages).tint(theme.accent)
                Text("Off starts a separate conversation. On includes recent operator and assistant text, excluding tool results. Text is sent to the account you choose.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                }.font(.reinBody(.callout))
                rule
                if setupTab == .api {
                FieldLabel("API accounts", folio: "01")
                ForEach(accounts.accounts) { account in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            VStack(alignment: .leading) { Text(account.name.uppercased()).font(.reinMono(.headline)); Text("\(account.provider.displayName) · \(account.model)").font(.reinBody(.footnote)) }
                            Spacer()
                            if accounts.selectedID == account.id { Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.accent).accessibilityLabel("Selected direct account") }
                        }
                        if store.accountConnection != nil, account.provider != .anthropic {
                            Button("Use this API on connected host") {
                                Task {
                                    guard let connection = store.accountConnection else { return }
                                    do {
                                        try await GatewayAccountsClient(connection: connection).configure(account: account, apiKey: accounts.apiKey(for: account))
                                        guard store.connectedURL == connection.baseURL else { return }
                                        message = "The selected host now uses \(account.name)."; await reloadHost()
                                    } catch { message = error.localizedDescription }
                                }
                            }.buttonStyle(ReinSecondaryButtonStyle())
                            Text("Sends this endpoint, model, and API key to the connected host for its next run.").font(.reinBody(.caption)).foregroundStyle(theme.muted)
                        }
                        Text(account.baseURL.absoluteString).font(.reinMono(.caption, weight: .regular)).textSelection(.enabled)
                        HStack {
                            Button("Use for direct chat") { accounts.select(account.id); store.openDirectChat() }.buttonStyle(ReinSecondaryButtonStyle())
                            Button("Remove") { do { try accounts.remove(id: account.id) } catch { message = error.localizedDescription } }.buttonStyle(ReinSecondaryButtonStyle()).disabled(workspace.isRunning)
                        }
                    }.padding(12).overlay(Rectangle().stroke(theme.rule, lineWidth: 1))
                }
                Picker("API provider", selection: $provider) { ForEach(CloudProvider.allCases) { Text($0.displayName).tag($0) } }.reinField()
                    .onChange(of: provider) { _, next in endpoint = next.defaultBaseURL?.absoluteString ?? ""; key = ""; model = "" }
                input("Account name", text: $name, placeholder: "My model server")
                input("API base URL", text: $endpoint, placeholder: "http://model-server.local:1234/v1", url: true)
                    .onChange(of: endpoint) { _, _ in key = "" }
                input("Model ID", text: $model, placeholder: "Exact model ID from your server or provider")
                SecureField(provider == .custom ? "API key, optional for a private server" : "API key", text: $key).textInputAutocapitalization(.never).autocorrectionDisabled().reinField().accessibilityLabel("API key")
                if let url = provider.apiKeyURL { Button("Open \(provider.displayName) API key console") { website = .init(url: url) }.buttonStyle(ReinSecondaryButtonStyle()) }
                Picker("Maximum reply tokens", selection: $outputLimit) { Text("1,024").tag(1024); Text("2,048").tag(2048); Text("4,096").tag(4096); Text("8,192").tag(8192) }.reinField()
                Picker("Model context limit", selection: $contextLimit) { Text("8,192").tag(8192); Text("32,768").tag(32768); Text("65,536").tag(65536); Text("131,072").tag(131072) }.reinField()
                Text("Choose limits supported by your model. Rein checks an estimated input size before sending; the provider may enforce a smaller limit.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                Button("Save API account") {
                    do {
                        let url = try CloudAccount.normalizedEndpoint(endpoint, provider: provider)
                        let account = try CloudAccount(name: name, provider: provider, baseURL: url, model: model, contextTokenLimit: contextLimit, maxOutputTokens: outputLimit)
                        try accounts.save(account, apiKey: key)
                        accounts.select(account.id); key = ""; name = ""; message = "Account saved. Its API key is protected in this device's Keychain."
                    } catch { message = error.localizedDescription }
                }.buttonStyle(ReinPrimaryButtonStyle()).disabled(name.isEmpty || endpoint.isEmpty || model.isEmpty || provider.requiresAPIKey && key.isEmpty || workspace.isRunning)
                Text("Private servers may use HTTP on a LAN or mesh. Public endpoints require HTTPS. API keys stay on this device; a gateway bearer token belongs in the host section below.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                } else if setupTab == .subscriptions {
                    subscriptionSetup
                } else {
                FieldLabel("Backup Rein hosts", folio: "03")
                Text("A reachable backup host can run your authorized CLI subscriptions and its own tools. Each host keeps its own sessions. Switching hosts never transfers a running task.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                ForEach(workspace.backups) { backup in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(backup.name).font(.reinMono(.headline)); Text(backup.origin.absoluteString).font(.reinMono(.caption, weight: .regular))
                        HStack {
                            Button("Connect") { Task { await store.useBackup(backup) } }.buttonStyle(ReinSecondaryButtonStyle())
                            Button("Remove") { do { try workspace.removeBackup(backup) } catch { message = error.localizedDescription } }.buttonStyle(ReinSecondaryButtonStyle())
                        }
                    }
                }
                input("Backup name", text: $backupName, placeholder: "Always-on host")
                input("Backup gateway", text: $backupURL, placeholder: "https://backup.example.com", url: true)
                    .onChange(of: backupURL) { _, _ in backupToken = "" }
                SecureField("Backup gateway bearer token", text: $backupToken).textInputAutocapitalization(.never).autocorrectionDisabled().reinField()
                Button("Save backup host") {
                    do { try workspace.saveBackup(name: backupName, rawURL: backupURL, token: backupToken); backupToken = ""; backupName = ""; backupURL = ""; message = "Backup host saved." }
                    catch { message = error.localizedDescription }
                }.buttonStyle(ReinPrimaryButtonStyle()).disabled(backupName.isEmpty || backupURL.isEmpty || backupToken.isEmpty)
                }
            }.padding(20).frame(maxWidth: 760, alignment: .leading)
        }
        .sheet(item: $website) { SafariAuthorizationView(url: $0.url).ignoresSafeArea() }
        .task(id: store.connectedURL) { listing = nil; login = nil; loginConnection = nil; await reloadHost() }
        .task(id: login?.id) {
            guard let initial = login, !initial.isTerminal, let connection = loginConnection else { return }
            let client = GatewayAccountsClient(connection: connection)
            do {
                while !Task.isCancelled {
                    try await Task.sleep(for: .seconds(2))
                    let update = try await client.login(id: initial.id)
                    try Task.checkCancellation()
                    guard store.connectedURL == connection.baseURL else { return }
                    login = update
                    if update.isTerminal { await reloadHost(); return }
                }
            } catch is CancellationError {} catch { message = "The authorization status could not be checked. Reopen account setup after reconnecting to this host." }
        }
    }

    private var subscriptionSetup: some View {
        VStack(alignment: .leading, spacing: 12) {
            FieldLabel("Cloud subscriptions on this host", folio: "02")
            Text(store.connectedURL?.absoluteString ?? "Connect a Rein host to authorize a subscription.").font(.reinMono(.footnote, weight: .regular)).textSelection(.enabled)
            Text("The official CLI runs on the host. Open its device page here and enter the one-time code. Credentials remain managed by that CLI. API-key accounts above can work when no host is reachable.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
            if let listing {
                Text("Host provider: \(listing.configured.provider ?? "unconfigured") / \(listing.configured.model ?? "default")").font(.reinMono(.footnote))
                if !listing.environmentOverrides.isEmpty { Text("The host has environment overrides. Update its launch configuration before selecting a provider here.").font(.reinBody(.footnote)).foregroundStyle(theme.error) }
                input("CLI model", text: $authModel, placeholder: "default")
                ForEach(listing.subscriptions) { subscription in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(subscription.label).font(.reinMono(.callout))
                        Text(subscription.detail).font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                        HStack {
                            Button("Authorize") { Task { await startLogin(subscription.provider) } }.buttonStyle(ReinSecondaryButtonStyle()).disabled(!subscription.available || busy || login.map { !$0.isTerminal } == true)
                            Button("Use on host") { Task { await selectHostProvider(subscription.provider) } }.buttonStyle(ReinSecondaryButtonStyle()).disabled(!subscription.available || busy || authModel.isEmpty || !listing.environmentOverrides.isEmpty)
                        }
                    }.padding(.vertical, 8)
                }
            }
            if let login {
                VStack(alignment: .leading, spacing: 10) {
                    Text(login.message).font(.reinBody(.footnote))
                    if let code = login.userCode { Text(code).font(.reinMono(.title)).textSelection(.enabled).accessibilityLabel("Device authorization code \(code)") }
                    if let url = login.safeVerificationURL, !login.isTerminal { Button("Open device authorization") { website = .init(url: url) }.buttonStyle(ReinPrimaryButtonStyle()) }
                    if !login.isTerminal { Button("Cancel authorization") { Task { guard let connection = loginConnection, store.connectedURL == connection.baseURL else { return }; do { let result = try await GatewayAccountsClient(connection: connection).cancelLogin(id: login.id); guard store.connectedURL == connection.baseURL else { return }; self.login = result } catch { if store.connectedURL == connection.baseURL { message = error.localizedDescription } } } }.buttonStyle(ReinSecondaryButtonStyle()) }
                }.padding(12).background(theme.paperSecondary)
            }
            Button("Refresh host accounts") { Task { await reloadHost() } }.buttonStyle(ReinSecondaryButtonStyle()).disabled(store.accountConnection == nil || busy)
            Text("Available device flows: ChatGPT through Codex, GitHub Copilot, and eligible Grok subscriptions. Claude and Gemini use API keys here. Subscription eligibility is checked by the provider.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
        }
    }

    private func reloadHost() async {
        guard let connection = store.accountConnection else { return }
        do { let next = try await GatewayAccountsClient(connection: connection).list(); guard store.connectedURL == connection.baseURL else { return }; listing = next }
        catch { guard store.connectedURL == connection.baseURL, !Task.isCancelled else { return }; message = error.localizedDescription }
    }
    private func startLogin(_ provider: String) async {
        guard let connection = store.accountConnection else { return }
        busy = true; defer { busy = false }
        do { let next = try await GatewayAccountsClient(connection: connection).startLogin(provider: provider); guard store.connectedURL == connection.baseURL else { return }; loginConnection = connection; login = next }
        catch { message = error.localizedDescription }
    }
    private func selectHostProvider(_ provider: String) async {
        guard let connection = store.accountConnection else { return }
        busy = true; defer { busy = false }
        do { try await GatewayAccountsClient(connection: connection).select(provider: provider, model: authModel); guard store.connectedURL == connection.baseURL else { return }; message = "The next host run will use \(provider)."; await reloadHost() }
        catch { message = error.localizedDescription }
    }
    private var rule: some View { Rectangle().fill(theme.ink).frame(height: 2) }
    private func input(_ label: String, text: Binding<String>, placeholder: String, url: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 5) { Text(label.uppercased()).font(.reinMono(.caption)); TextField(placeholder, text: text).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(url ? .URL : .default).reinField().accessibilityLabel(label) }
    }
}

private struct DirectConversationView: View {
    @ObservedObject var store: ReinAppStore
    @ObservedObject var workspace: CloudWorkspace
    @ObservedObject var accounts: CloudAccountStore
    @Environment(\.reinTheme) private var theme
    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("DIRECT CONVERSATION").font(.reinMono(.headline)).foregroundStyle(theme.accent)
                Text(workspace.status).font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                Text("Text assistance only. Host tools and running tasks remain on their original host.").font(.reinBody(.footnote))
                if let error = workspace.errorMessage { Text(error).font(.reinBody(.footnote)).foregroundStyle(theme.error) }
                if accounts.accounts.isEmpty { Button("Add an account") { workspace.page = .accounts }.buttonStyle(ReinPrimaryButtonStyle()) }
                else {
                    Picker("Direct account", selection: Binding(get: { accounts.selectedID }, set: { accounts.select($0) })) {
                        ForEach(accounts.accounts) { Text("\($0.name) · \($0.model)").tag(Optional($0.id)) }
                    }.disabled(workspace.isRunning).reinField()
                }
            }.padding(16)
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(workspace.messages.enumerated()), id: \.element.id) { index, message in
                            VStack(alignment: .leading, spacing: 0) {
                                if let route = workspace.routes[message.id] { Text(route).font(.reinMono(.caption2)).foregroundStyle(theme.muted).padding(.top, 12) }
                                MessageLedgerRow(message: message, number: index + 1, assistantOrdinal: workspace.messages.prefix(index + 1).filter { $0.role == .assistant }.count)
                            }.id(message.id)
                        }
                    }.padding(.horizontal, 16)
                }.onChange(of: workspace.messages.count) { _, _ in if let id = workspace.messages.last?.id { reader.scrollTo(id, anchor: .bottom) } }
            }
            VStack(spacing: 10) {
                TextField("Message to the selected account", text: $workspace.draft, axis: .vertical).lineLimit(2...6).reinField().disabled(workspace.isRunning)
                HStack {
                    Button("New conversation") { workspace.newConversation() }.buttonStyle(ReinSecondaryButtonStyle()).disabled(workspace.isRunning)
                    if workspace.isRunning { Button("Stop") { workspace.stop() }.buttonStyle(ReinSecondaryButtonStyle()) }
                    else { Button("Send") { if workspace.send(workspace.draft, sounds: store.sounds) { workspace.draft = "" } }.buttonStyle(ReinPrimaryButtonStyle()).disabled(workspace.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || accounts.selectedAccount == nil) }
                }
            }.padding(16).background(theme.paperSecondary)
        }
    }
}

private struct AuthWebsite: Identifiable { let id = UUID(); let url: URL }
private struct SafariAuthorizationView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
