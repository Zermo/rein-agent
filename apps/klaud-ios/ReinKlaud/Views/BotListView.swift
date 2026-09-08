import SwiftUI

struct BotListView: View {
    @ObservedObject var store: ReinAppStore
    @Environment(\.reinTheme) private var theme
    @State private var name = ""
    @State private var avatar = BotAvatarStyle.aviator
    @State private var saving = false
    @State private var editingBot: ReinBot?

    var body: some View {
        ScreenScaffold {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ErrorStrip(store: store)
                    FieldLabel("Your bot roster", folio: String(format: "%02d", store.state.bots.count))
                    Text("THE CREW").font(.reinDisplay(.largeTitle))
                    Text("Each bot keeps a durable conversation on your Rein host. Its eyebrows reflect the work it is doing, or an approval it needs.").font(.reinBody()).foregroundStyle(theme.muted)
                    Rectangle().fill(theme.ink).frame(height: 2)
                    if store.state.bots.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("LET’S MAKE YOUR FIRST BOT").font(.reinDisplay(.title2))
                            Text("Give it a name and a hat below, then start with one small task.").font(.reinBody()).foregroundStyle(theme.muted)
                        }.padding(.vertical, 20)
                    } else {
                        LazyVStack(spacing: 0) {
                            ForEach(store.state.bots) { bot in
                                HStack(spacing: 0) {
                                    Button { store.sounds.play(.click); Task { await store.chooseBot(bot.id) } } label: {
                                        HStack(spacing: 12) {
                                            BotAvatarView(style: .resolve(bot.avatar, botID: bot.id), phase: store.avatarPhase(for: bot)).frame(width: 56, height: 64).accessibilityHidden(true)
                                            VStack(alignment: .leading, spacing: 3) {
                                                Text(bot.name).font(.reinBody(.headline, weight: .bold))
                                                Text(store.avatarPhase(for: bot).label.uppercased()).font(.reinMono(.caption2)).foregroundStyle(theme.muted)
                                            }
                                            Spacer()
                                            if store.selectedBotID == bot.id { Image(systemName: "arrow.right").foregroundStyle(theme.accent).accessibilityHidden(true) }
                                        }.padding(12).frame(minHeight: 80).foregroundStyle(theme.ink)
                                    }.buttonStyle(.plain).accessibilityLabel("Open \(bot.name), \(store.avatarPhase(for: bot).label)").accessibilityValue(store.selectedBotID == bot.id ? "Selected" : "")
                                    Button { editingBot = bot; store.sounds.play(.click) } label: { Image(systemName: "pencil").frame(width: 44, height: 48) }
                                        .buttonStyle(.plain).foregroundStyle(theme.accent).accessibilityLabel("Change \(bot.name)’s avatar")
                                }.background(store.selectedBotID == bot.id ? theme.paperSecondary : theme.paper)
                                    .overlay(alignment: .bottom) { Rectangle().fill(theme.rule).frame(height: 1) }
                            }
                        }.overlay(Rectangle().stroke(theme.ink, lineWidth: 1))
                    }
                    VStack(alignment: .leading, spacing: 14) {
                        FieldLabel("Add a bot")
                        TextField("Bot name", text: $name).textInputAutocapitalization(.words).reinField()
                        BotAvatarPicker(selection: $avatar)
                        Text("The hat is a visual identity. It does not change the model, skills, or permissions.").font(.reinBody(.footnote)).foregroundStyle(theme.muted)
                        Button(saving ? "Creating…" : "Create bot") {
                            saving = true
                            Task { let made = await store.createBot(name: name, avatar: avatar.rawValue); if made { name = "" }; saving = false }
                        }.buttonStyle(ReinPrimaryButtonStyle()).disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }.padding(.top, 12)
                }.padding(20).frame(maxWidth: 760, alignment: .leading)
            }.refreshable { await store.refresh() }
        }
        .sheet(item: $editingBot) { bot in BotAvatarEditor(store: store, bot: bot).environment(\.reinTheme, theme) }
    }
}

struct BotAvatarEditor: View {
    @ObservedObject var store: ReinAppStore
    let bot: ReinBot
    @State private var selection: BotAvatarStyle
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.reinTheme) private var theme

    init(store: ReinAppStore, bot: ReinBot) {
        self.store = store; self.bot = bot
        _selection = State(initialValue: .resolve(bot.avatar, botID: bot.id))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    FieldLabel("Bot identity")
                    Text("A HAT FOR \(bot.name.uppercased())").font(.reinDisplay(.title))
                    BotAvatarPicker(selection: $selection)
                    Text("This appearance follows the bot on connected devices. Its conversation, model, and permissions stay the same.").font(.reinBody()).foregroundStyle(theme.muted)
                    ErrorStrip(store: store)
                    Button(saving ? "Saving…" : "Save avatar") {
                        saving = true
                        Task { if await store.updateBotAvatar(bot, avatar: selection) { dismiss() }; saving = false }
                    }.buttonStyle(ReinPrimaryButtonStyle()).disabled(saving)
                }.padding(24)
            }.background(theme.paper)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) } }
                .navigationTitle("Bot avatar").navigationBarTitleDisplayMode(.inline)
        }.interactiveDismissDisabled(saving)
    }
}
