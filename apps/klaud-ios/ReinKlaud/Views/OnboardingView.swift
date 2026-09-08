import SwiftUI

struct OnboardingView: View {
    @ObservedObject var store: ReinAppStore
    @Environment(\.reinTheme) private var theme
    @State private var url = ""
    @State private var token = ""
    @State private var didLoad = false
    @State private var showHost = false
    @StateObject private var discovery = ReinDiscovery()
    @State private var resolvingHost: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                BrandMasthead()
                VStack(alignment: .leading, spacing: 22) {
                    if !showHost {
                    FieldLabel("Welcome aboard", folio: "01 / 03")
                    HStack(alignment: .center, spacing: 14) {
                        BotAvatarView(style: .aviator).frame(width: 100, height: 112).accessibilityHidden(true)
                        Text("LET’S MEET\nYOUR BOT.").font(.reinDisplay(.largeTitle)).minimumScaleFactor(0.7)
                    }
                    Text("A little help with the things that fill your day. Connect a Rein host for tasks and tools, or start with direct model chat on this device.")
                        .font(.reinBody()).foregroundStyle(theme.muted)
                        if !store.savedURL.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("YOUR SAVED HOST IS HERE").font(.reinMono(.caption)).foregroundStyle(theme.accent)
                                Text("Your connection and device settings are still saved. Reconnect to use the bots and conversations already on that host.").font(.reinBody(.footnote))
                                Button("Reconnect to saved host") { showHost = true }.buttonStyle(ReinPrimaryButtonStyle())
                            }.padding(16).background(theme.paperSecondary).overlay(Rectangle().stroke(theme.rule))
                        }
                        routeButton("Connect a Rein host", detail: "Use an existing desktop or always-on machine. Its bots, files, tools, and task history stay there.", icon: "desktopcomputer") { showHost = true }
                        routeButton("Start with a model account", detail: "Add a self-hosted server or cloud API key for direct chat. You can connect a host later.", icon: "key") { store.openCloudAccounts() }
                        Text("Cloud subscription sign-in uses a supported CLI on a connected host. Direct API chat is available without a host.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                    } else {
                        hostForm
                    }
                    Toggle(isOn: Binding(get: { store.sounds.enabled }, set: { store.sounds.setEnabled($0); if $0 { store.sounds.play(.ready) } })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("VINTAGE CONSOLE SOUNDS").font(.reinMono(.callout))
                            Text("Quiet clicks and short cues. You can switch them off any time.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                        }
                    }.tint(theme.accent).frame(minHeight: 52)
                }.padding(.horizontal, 24).padding(.bottom, 24)
            }.frame(maxWidth: 720, alignment: .leading).frame(maxWidth: .infinity)
        }.background(theme.paper)
        .task {
            guard !didLoad else { return }; didLoad = true
            url = store.savedURL; token = store.savedToken
        }
        .onChange(of: url) { _, newURL in token = store.savedToken(for: newURL) }
        .onDisappear { discovery.stop() }
    }

    private func routeButton(_ title: String, detail: String, icon: String, action: @escaping () -> Void) -> some View {
        Button { store.sounds.play(.click); action() } label: {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: icon).font(.title2).frame(width: 28).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 7) {
                    Text(title).font(.reinBody(.headline, weight: .bold))
                    Text(detail).font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.right").accessibilityHidden(true)
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(theme.raised).overlay(Rectangle().stroke(theme.strongRule))
        }.buttonStyle(.plain)
    }

    private var hostForm: some View {
        VStack(alignment: .leading, spacing: 18) {
            Button("← Choose another way") { discovery.stop(); showHost = false }.buttonStyle(ReinSecondaryButtonStyle())
            FieldLabel("Find your host", folio: "02 / 03")
            Text("LINK TO REIN").font(.reinDisplay(.title))
            Text("Open klaʊdbot on your computer and start its local gateway, or run rein serve. Use the address and mobile token shown there. Your phone and host must have a reachable LAN, mesh, or HTTPS route.")
                .font(.reinBody()).foregroundStyle(theme.muted)
            Button(discovery.isSearching ? "Stop local search" : "Find Rein nearby") { discovery.isSearching ? discovery.stop() : discovery.start() }
                .buttonStyle(ReinSecondaryButtonStyle())
            if let message = discovery.message { Text(message).font(.reinBody(.footnote)).foregroundStyle(theme.muted) }
            ForEach(discovery.hosts) { host in
                Button {
                    resolvingHost = host.id
                    Task { if let found = await discovery.resolve(host) { url = found; discovery.stop() }; resolvingHost = nil }
                } label: {
                    HStack { Text(host.name).font(.reinMono(.callout)); Spacer(); if resolvingHost == host.id { ProgressView() } else { Image(systemName: "arrow.right") } }
                }.buttonStyle(ReinSecondaryButtonStyle()).disabled(resolvingHost != nil).accessibilityLabel("Use nearby gateway \(host.name)")
            }
            Text("Search starts when you tap. Mesh hosts may need their address entered below.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
            VStack(alignment: .leading, spacing: 8) {
                Text("GATEWAY ADDRESS").font(.reinMono(.caption)).foregroundStyle(theme.accent)
                TextField("https://rein.example.com", text: $url)
                    .textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled().reinField()
                    .accessibilityHint("Enter the address printed by your Rein mobile gateway")
                Text("Use HTTPS for a public address. Private LAN or mesh IP addresses and .local names can use HTTP.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("MOBILE TOKEN").font(.reinMono(.caption)).foregroundStyle(theme.accent)
                SecureField("Private connection token", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled().reinField()
                Text("Copy the gateway’s mobile token, not a model API key. Stored in this device’s Keychain.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
            }
            ErrorStrip(store: store)
            Button {
                discovery.stop()
                Task { await store.connect(rawURL: url, token: token, assistedSetup: true) }
            } label: {
                if store.isConnecting { ProgressView().tint(theme.accentInk).accessibilityLabel("Checking host and loading its bots") }
                else { Text("Check host & continue") }
            }.buttonStyle(ReinPrimaryButtonStyle()).disabled(store.isConnecting || url.isEmpty || token.isEmpty)
            Text("Next: choose an existing bot or give a new one a name and a hat. Connecting does not start a model task.")
                .font(.reinBody(.footnote)).foregroundStyle(theme.muted)
        }
    }
}

/// A host can already own bots and sessions. Choosing one never duplicates it.
struct BotSetupView: View {
    @ObservedObject var store: ReinAppStore
    @Environment(\.reinTheme) private var theme
    @State private var name = ""
    @State private var avatar = BotAvatarStyle.aviator
    @State private var saving = false

    var body: some View {
        ScreenScaffold {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    FieldLabel("Meet your bot", folio: "03 / 03")
                    Text(store.state.bots.isEmpty ? "A NAME. A HAT.\nYOUR FIRST TASK." : "YOUR BOTS\nARE ALREADY HERE.").font(.reinDisplay(.largeTitle))
                    Text(store.state.bots.isEmpty ? "Choose a name and a look. The hat gives your bot an identity; it does not change its model or permissions." : "Keep using an existing conversation, or create a separate bot below. Existing sessions stay on the host.").font(.reinBody()).foregroundStyle(theme.muted)
                    ErrorStrip(store: store)
                    ForEach(store.state.bots) { bot in
                        Button {
                            saving = true
                            Task { await store.chooseBot(bot.id); if store.errorMessage == nil { store.completeBotSetup() }; saving = false }
                        } label: {
                            HStack(spacing: 14) {
                                BotAvatarView(style: .resolve(bot.avatar, botID: bot.id)).frame(width: 56, height: 64).accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 4) { Text(bot.name).font(.reinBody(.headline, weight: .bold)); Text("Continue this conversation").font(.reinBody(.footnote)).foregroundStyle(theme.muted) }
                                Spacer(); Image(systemName: "arrow.right")
                            }.padding(12).background(theme.raised).overlay(Rectangle().stroke(theme.strongRule))
                        }.buttonStyle(.plain).disabled(saving || store.isConnecting).accessibilityLabel("Continue with \(bot.name)")
                    }
                    if !store.state.bots.isEmpty { Rectangle().fill(theme.rule).frame(height: 1) }
                    FieldLabel(store.state.bots.isEmpty ? "Your first bot" : "Or create a new bot")
                    TextField("What should we call your bot?", text: $name).textInputAutocapitalization(.words).reinField()
                    BotAvatarPicker(selection: $avatar)
                    Button(saving ? "Creating…" : "Create bot & open chat") {
                        saving = true
                        Task { if await store.createBot(name: name, avatar: avatar.rawValue) { store.completeBotSetup() }; saving = false }
                    }.buttonStyle(ReinPrimaryButtonStyle()).disabled(saving || store.isConnecting || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Text("Try a small first task: “Help me decide what to tackle today.” You approve actions according to your Rein host’s policy.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                    Button("Use a different host") { store.disconnect() }.buttonStyle(ReinSecondaryButtonStyle()).disabled(saving)
                }.padding(24).frame(maxWidth: 720, alignment: .leading)
            }
        }
    }
}
