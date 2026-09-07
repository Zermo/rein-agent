import SwiftUI

struct BotListView: View {
    @ObservedObject var store: ReinAppStore
    @Environment(\.reinTheme) private var theme
    @State private var name = ""
    @State private var saving = false

    var body: some View {
        ScreenScaffold {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ErrorStrip(store: store)
                    FieldLabel("Agent roster / live", folio: String(format: "%02d", store.state.bots.count))
                    Text("FIELD UNITS").font(.reinDisplay(.largeTitle))
                    Text("Each unit keeps a durable conversation on your Rein host.").font(.reinBody()).foregroundStyle(theme.muted)
                    Rectangle().fill(theme.ink).frame(height: 2)
                    if store.state.bots.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("NO FIELD UNITS YET").font(.reinDisplay(.title2))
                            Text("Register one below to begin a durable conversation.").font(.reinBody()).foregroundStyle(theme.muted)
                        }.padding(.vertical, 20)
                    } else {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(store.state.bots.enumerated()), id: \.element.id) { index, bot in
                                Button { store.sounds.play(.click); Task { await store.chooseBot(bot.id) } } label: {
                                    HStack(spacing: 14) {
                                        Text(String(format: "%02d", index + 1)).font(.reinMono(.callout)).foregroundStyle(store.selectedBotID == bot.id ? theme.accentInk : theme.muted)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(bot.name).font(.reinBody(.headline, weight: .bold))
                                            Text("DURABLE SESSION").font(.reinMono(.caption2)).opacity(0.76)
                                        }
                                        Spacer()
                                        if store.selectedBotID == bot.id { Image(systemName: "arrow.right").accessibilityHidden(true) }
                                    }.padding(.horizontal, 14).frame(minHeight: 64)
                                        .foregroundStyle(store.selectedBotID == bot.id ? theme.accentInk : theme.ink)
                                        .background(store.selectedBotID == bot.id ? theme.accent : theme.paper)
                                        .overlay(alignment: .bottom) { Rectangle().fill(theme.rule).frame(height: 1) }
                                }.buttonStyle(.plain).accessibilityLabel("Open \(bot.name)").accessibilityValue(store.selectedBotID == bot.id ? "Selected" : "")
                            }
                        }.overlay(Rectangle().stroke(theme.ink, lineWidth: 1))
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        FieldLabel("Register new unit")
                        HStack(spacing: 8) {
                            TextField("Agent name", text: $name).textInputAutocapitalization(.words).reinField()
                            Button("Add") {
                                saving = true
                                Task { let made = await store.createBot(name: name); if made { name = "" }; saving = false }
                            }.buttonStyle(ReinPrimaryButtonStyle()).disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }.padding(.top, 12)
                }.padding(20).frame(maxWidth: 760, alignment: .leading)
            }.refreshable { await store.refresh() }
        }
    }
}
