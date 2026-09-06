import SwiftUI

struct OnboardingView: View {
    @ObservedObject var store: ReinAppStore
    @Environment(\.reinTheme) private var theme
    @State private var url = ""
    @State private var token = ""
    @State private var didLoad = false
    @StateObject private var discovery = ReinDiscovery()
    @State private var resolvingHost: String?

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                if proxy.size.width >= 760 {
                    HStack(spacing: 0) { fieldGuide.frame(maxWidth: .infinity); form.frame(maxWidth: .infinity) }
                        .frame(minHeight: proxy.size.height)
                } else {
                    VStack(spacing: 0) { fieldGuide; form }
                }
            }.background(theme.paper)
        }
        .task {
            guard !didLoad else { return }; didLoad = true
            url = store.savedURL; token = store.savedToken
        }
        .onChange(of: url) { _, newURL in
            token = store.savedToken(for: newURL)
        }
    }

    private var fieldGuide: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 12) {
                Image("ReinMark").resizable().scaledToFit().frame(width: 52, height: 52)
                Text("REIN").font(.reinDisplay(.largeTitle)).foregroundStyle(theme.accent)
            }
            Text("FRESH CONTEXT.\nSAME JOURNEY.")
                .font(.reinDisplay(.largeTitle)).minimumScaleFactor(0.65).lineLimit(2)
            Text("LOCAL-FIRST AGENT HARNESS").font(.reinMono(.headline)).tracking(2)
            Rectangle().fill(theme.ink).frame(height: 2)
            Image("FieldGuideCard").resizable().scaledToFit()
                .overlay(Rectangle().stroke(theme.ink, lineWidth: 2))
                .accessibilityLabel("Vintage computer linked to a Rein host")
            Text("Your agent runs on hardware you control. This console carries the conversation, tool activity, and approval controls to iPhone and iPad.")
                .font(.reinBody()).foregroundStyle(theme.muted).fixedSize(horizontal: false, vertical: true)
        }
        .padding(24).frame(maxWidth: .infinity, alignment: .leading).background(theme.paperSecondary)
        .overlay(alignment: .top) { Rectangle().fill(theme.accent).frame(height: 6) }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 18) {
            FieldLabel("Initial link", folio: "01 / 03")
            Text("CONNECT YOUR REIN HOST").font(.reinDisplay(.largeTitle)).minimumScaleFactor(0.65).lineLimit(2)
            Text("Use HTTPS for an internet-reachable gateway or a mesh DNS name. Plain HTTP is accepted for numeric private LAN/mesh addresses, scoped link-local IPv6, and .local names.")
                .font(.reinBody()).foregroundStyle(theme.muted)

            VStack(alignment: .leading, spacing: 8) {
                Button(discovery.isSearching ? "Stop local search" : "Find Rein nearby") {
                    discovery.isSearching ? discovery.stop() : discovery.start()
                }.buttonStyle(ReinSecondaryButtonStyle())
                if let message = discovery.message { Text(message).font(.reinBody(.footnote)).foregroundStyle(theme.muted) }
                ForEach(discovery.hosts) { host in
                    Button {
                        resolvingHost = host.id
                        Task { if let found = await discovery.resolve(host) { url = found; discovery.stop() }; resolvingHost = nil }
                    } label: {
                        HStack { VStack(alignment: .leading) { Text(host.name).font(.reinMono(.callout)); Text("NEARBY REIN GATEWAY").font(.reinMono(.caption2, weight: .regular)) }; Spacer(); if resolvingHost == host.id { ProgressView() } else { Image(systemName: "arrow.right") } }
                    }.buttonStyle(ReinSecondaryButtonStyle()).disabled(resolvingHost != nil).accessibilityLabel("Use nearby gateway \(host.name)")
                }
                Text("Search starts only when you tap the button. For a private mesh, enter the HTTPS name or private numeric IP manually.")
                    .font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("GATEWAY ORIGIN").font(.reinMono(.caption)).foregroundStyle(theme.accent)
                TextField("https://rein.example.com", text: $url)
                    .textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled().reinField()
                    .accessibilityHint("Enter the address printed by your Rein mobile gateway")
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("BEARER TOKEN").font(.reinMono(.caption)).foregroundStyle(theme.accent)
                SecureField("Private connection token", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled().reinField()
                Text("Stored in this device’s Keychain. It is never written to app logs.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
            }
            Toggle(isOn: Binding(get: { store.sounds.enabled }, set: { store.sounds.setEnabled($0); if $0 { store.sounds.play(.ready) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("VINTAGE CONSOLE SOUNDS").font(.reinMono(.callout))
                    Text("Short local cues for keys, tools, replies, and status.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                }
            }.tint(theme.accent).frame(minHeight: 52)
            ErrorStrip(store: store)
            Button { Task { await store.connect(rawURL: url, token: token) } } label: {
                if store.isConnecting { ProgressView().tint(theme.accentInk).accessibilityLabel("Connecting") }
                else { Text("Connect to Rein") }
            }.buttonStyle(ReinPrimaryButtonStyle()).disabled(store.isConnecting || url.isEmpty || token.isEmpty)

            Text("The iOS app is a secure operator console. Long-running agents and tools continue on your Rein host.")
                .font(.reinMono(.caption)).foregroundStyle(theme.muted).padding(.top, 8)
        }
        .padding(24).frame(maxWidth: 620, alignment: .leading).background(theme.paper)
        .overlay(alignment: .top) { Rectangle().fill(theme.ink).frame(height: 2) }
    }
}
