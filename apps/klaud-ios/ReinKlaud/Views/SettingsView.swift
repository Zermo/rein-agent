import SwiftUI

struct SettingsView: View {
    @ObservedObject var store: ReinAppStore
    @Environment(\.reinTheme) private var theme

    var body: some View {
        ScreenScaffold {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ErrorStrip(store: store)
                    FieldLabel("Console preferences", folio: "03 / 03")
                    Text("SETTINGS").font(.reinDisplay(.largeTitle))
                    Text("Appearance and sound choices follow this console. Rein stores shared shell choices on the host.").font(.reinBody()).foregroundStyle(theme.muted)
                    Rectangle().fill(theme.ink).frame(height: 2)
                    Button("Cloud subscriptions, API keys & backup hosts") { store.openCloudAccounts() }.buttonStyle(ReinPrimaryButtonStyle())
                    Button("Open direct model chat") { store.openDirectChat() }.buttonStyle(ReinSecondaryButtonStyle())

                    SettingRow(title: "Light / night", detail: "Match the field console to the room.") {
                        Picker("Appearance", selection: Binding(get: { store.state.shell.theme.dark }, set: { value in Task { await store.setDark(value) } })) {
                            Text("Light").tag(false); Text("Night").tag(true)
                        }.pickerStyle(.segmented).frame(maxWidth: 240)
                    }
                    SettingRow(title: "Signal color", detail: "Rust, slate, or terminal green.") {
                        Picker("Signal color", selection: Binding(get: { store.state.shell.theme.accent }, set: { value in Task { await store.setAccent(value) } })) {
                            Text("Rain").tag("rain"); Text("Slate").tag("slate"); Text("Storm").tag("storm")
                        }.labelsHidden().frame(maxWidth: 220).reinField()
                    }
                    SettingRow(title: "Ledger density", detail: "Change spacing without shrinking type.") {
                        Picker("Ledger density", selection: Binding(get: { store.state.shell.theme.density }, set: { value in Task { await store.setDensity(value) } })) {
                            Text("Compact").tag("compact"); Text("Regular").tag("regular"); Text("Roomy").tag("roomy")
                        }.labelsHidden().frame(maxWidth: 220).reinField()
                    }
                    SettingRow(title: "Vintage console sounds", detail: "Device-local synthesized field cues.") {
                        Toggle("Sounds", isOn: Binding(get: { store.sounds.enabled }, set: { store.sounds.setEnabled($0); if $0 { store.sounds.play(.ready) } })).labelsHidden().tint(theme.accent)
                    }
                    SettingRow(title: "Activity marker", detail: "Show Ready or Working beside the active unit.") {
                        Toggle("Activity marker", isOn: Binding(get: { store.state.shell.chrome.showActivity }, set: { value in Task { await store.setActivity(value) } })).labelsHidden().tint(theme.accent)
                    }
                    SettingRow(title: "iPad bot rail", detail: "Keep the field-unit list visible on larger screens.") {
                        Toggle("iPad bot rail", isOn: Binding(get: { store.state.shell.chrome.sidebar }, set: { value in Task { await store.setSidebar(value) } })).labelsHidden().tint(theme.accent)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        FieldLabel("Connection")
                        Text(store.connectedURL?.absoluteString ?? "Disconnected").font(.reinMono(.footnote, weight: .regular)).textSelection(.enabled)
                        HStack { Button("Disconnect") { store.disconnect() }.buttonStyle(ReinSecondaryButtonStyle()); Button("Forget host") { store.disconnect(forget: true) }.buttonStyle(ReinSecondaryButtonStyle()) }
                    }.padding(.top, 8)
                    Text("Bearer tokens remain in the iOS Keychain. Rein conversations and agent tools remain on the connected host.")
                        .font(.reinMono(.caption)).foregroundStyle(theme.muted).padding(.bottom, 24)
                }.padding(20).frame(maxWidth: 820, alignment: .leading)
            }
        }
    }
}

private struct SettingRow<Control: View>: View {
    let title: String
    let detail: String
    let control: Control
    @Environment(\.reinTheme) private var theme
    init(title: String, detail: String, @ViewBuilder control: () -> Control) { self.title = title; self.detail = detail; self.control = control() }
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 20) { words; Spacer(); control }.frame(minHeight: 68)
            VStack(alignment: .leading, spacing: 12) { words; control.frame(maxWidth: .infinity, alignment: .leading) }.padding(.vertical, 10)
        }.overlay(alignment: .bottom) { Rectangle().fill(theme.rule).frame(height: 1) }
    }
    private var words: some View {
        VStack(alignment: .leading, spacing: 2) { Text(title.uppercased()).font(.reinMono(.callout)); Text(detail).font(.reinBody(.footnote)).foregroundStyle(theme.muted) }
    }
}
