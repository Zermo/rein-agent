import SwiftUI

struct RootView: View {
    @ObservedObject var store: ReinAppStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var theme: ReinTheme {
        .init(dark: store.state.shell.theme.dark, accentName: store.state.shell.theme.accent, density: store.state.shell.theme.density)
    }

    var body: some View {
        Group {
            if store.connectedURL == nil { OnboardingView(store: store) }
            else if horizontalSizeClass == .regular && store.state.shell.chrome.sidebar { TabletShell(store: store) }
            else { PhoneShell(store: store) }
        }
        .environment(\.reinTheme, theme)
        .background(theme.paper.ignoresSafeArea())
        .foregroundStyle(theme.ink)
        .sheet(isPresented: $store.showCloudWorkspace) {
            CloudWorkspaceView(store: store, workspace: store.cloud).environment(\.reinTheme, theme)
        }
        .alert(item: $store.pendingDecision) { decision in
            let title: String
            switch decision.kind { case .approval(let tool): title = "Allow \(tool)?"; case .confirmation: title = "Confirm this action?" }
            return Alert(title: Text(title), message: Text(decision.summary), primaryButton: .cancel(Text("Deny")) { Task { await store.decide(decision, allow: false) } }, secondaryButton: .default(Text("Allow")) { Task { await store.decide(decision, allow: true) } })
        }
    }
}

private struct PhoneShell: View {
    @ObservedObject var store: ReinAppStore
    var body: some View {
        TabView(selection: $store.section) {
            NavigationStack { BotListView(store: store) }.tabItem { Label("Bots", systemImage: "cpu") }.tag(AppSection.bots)
            NavigationStack { ChatView(store: store) }.tabItem { Label("Chat", systemImage: "text.bubble") }.tag(AppSection.chat)
            NavigationStack { SettingsView(store: store) }.tabItem { Label("Settings", systemImage: "switch.2") }.tag(AppSection.settings)
        }
        .tint(store.state.shell.theme.dark ? Color(hex: 0xF29070) : Color(hex: 0xB54229))
    }
}

private struct TabletShell: View {
    @ObservedObject var store: ReinAppStore
    @Environment(\.reinTheme) private var theme
    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                BrandMasthead(compact: true)
                List {
                    Section("Field index") {
                        sectionButton(.bots, label: "01  Bots", image: "cpu")
                        sectionButton(.chat, label: "02  Chat", image: "text.bubble")
                        sectionButton(.settings, label: "03  Settings", image: "switch.2")
                    }
                    Section("Field units") {
                        ForEach(store.state.bots) { bot in
                            Button { Task { await store.chooseBot(bot.id) } } label: {
                                HStack { Text(bot.name); Spacer(); if store.selectedBotID == bot.id { Image(systemName: "arrow.right") } }
                            }.buttonStyle(.plain).frame(minHeight: 44)
                        }
                    }
                }.scrollContentBackground(.hidden).background(theme.paperSecondary)
            }.background(theme.paperSecondary)
        } detail: {
            NavigationStack {
                switch store.section {
                case .bots: BotListView(store: store)
                case .chat: ChatView(store: store)
                case .settings: SettingsView(store: store)
                }
            }
        }.navigationSplitViewStyle(.balanced)
    }

    private func sectionButton(_ section: AppSection, label: String, image: String) -> some View {
        Button { store.section = section } label: {
            HStack { Label(label, systemImage: image); Spacer(); if store.section == section { Image(systemName: "arrow.right") } }
        }.buttonStyle(.plain).frame(minHeight: 44).accessibilityValue(store.section == section ? "Selected" : "")
    }
}

struct BrandMasthead: View {
    @Environment(\.reinTheme) private var theme
    var compact = false
    var body: some View {
        HStack(spacing: 10) {
            Image("ReinMark").resizable().scaledToFit().frame(width: compact ? 36 : 44, height: compact ? 36 : 44)
            VStack(alignment: .leading, spacing: 0) {
                Text("rein-klaʊd").font(.reinDisplay(.title2)).textCase(.uppercase)
                Text("FIELD CONSOLE / iOS").font(.reinMono(.caption2)).tracking(1.1).foregroundStyle(theme.muted)
            }
            Spacer()
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(theme.paper).overlay(alignment: .top) { Rectangle().fill(theme.accent).frame(height: 6) }
        .overlay(alignment: .bottom) { Rectangle().fill(theme.ink).frame(height: 2) }
    }
}

struct ScreenScaffold<Content: View>: View {
    @Environment(\.reinTheme) private var theme
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        VStack(spacing: 0) { BrandMasthead(); content.frame(maxWidth: .infinity, maxHeight: .infinity) }
            .background(theme.paper).toolbar(.hidden, for: .navigationBar)
    }
}

struct ErrorStrip: View {
    @ObservedObject var store: ReinAppStore
    @Environment(\.reinTheme) private var theme
    var body: some View {
        if let error = store.errorMessage {
            HStack(alignment: .top) {
                Image(systemName: "exclamationmark.triangle.fill").accessibilityHidden(true)
                Text(error).font(.reinBody(.footnote)).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button("Dismiss") { store.errorMessage = nil }.font(.reinMono(.caption)).frame(minHeight: 44)
            }.padding(.horizontal, 16).background(theme.errorPaper).foregroundStyle(theme.error)
                .accessibilityElement(children: .combine).accessibilityLabel("Error. \(error)")
        }
    }
}
