import SwiftUI

struct ChatView: View {
    @ObservedObject var store: ReinAppStore
    @Environment(\.reinTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var composerFocused: Bool

    var body: some View {
        ScreenScaffold {
            VStack(spacing: 0) {
                chatHeading
                ErrorStrip(store: store)
                if store.gatewayUnavailable {
                    Button("Host unavailable · Open fallback accounts") { store.openDirectChat() }.buttonStyle(ReinSecondaryButtonStyle()).padding(12)
                }
                if let recovery = store.pendingRunRecovery { recoveryStrip(recovery) }
                if store.selectedBot == nil { emptyState }
                else { transcript }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { if store.selectedBot != nil { composer } }
    }

    private func recoveryStrip(_ recovery: PendingRunRecovery) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("DELIVERY UNKNOWN").font(.reinMono(.caption)).tracking(1).foregroundStyle(theme.accent)
            Text("Rein could not confirm whether the host received this saved request. Retry sends the exact request with its original ID. Discard removes only the saved retry; it does not cancel work already on the host.")
                .font(.reinBody(.footnote)).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Discard") { Task { await store.discardPendingRun(recovery) } }.buttonStyle(ReinSecondaryButtonStyle())
                Button("Retry same request") { Task { await store.retryPendingRun(recovery) } }.buttonStyle(ReinPrimaryButtonStyle())
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.errorPaper)
        .overlay(alignment: .bottom) { Rectangle().fill(theme.ink).frame(height: 2) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Delivery unknown. Choose whether to retry or discard the saved request.")
    }

    private var chatHeading: some View {
        HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("ACTIVE FIELD UNIT").font(.reinMono(.caption)).foregroundStyle(theme.accent).tracking(1)
                Text(store.selectedBot?.name.uppercased() ?? "NO UNIT SELECTED").font(.reinDisplay(.title)).lineLimit(2).minimumScaleFactor(0.7)
            }
            Spacer()
            if store.state.shell.chrome.showActivity {
                Text(store.isRunning ? "WORKING" : "READY")
                    .font(.reinMono(.caption)).tracking(1).padding(.horizontal, 12).frame(minHeight: 36)
                    .foregroundStyle(theme.greenInk).background(store.isRunning ? theme.gold : theme.green)
                    .overlay(Rectangle().stroke(theme.ink, lineWidth: 1))
                    .accessibilityLabel("Agent status: \(store.isRunning ? "working" : "ready")")
            }
        }.padding(16).background(theme.paper).overlay(alignment: .bottom) { Rectangle().fill(theme.ink).frame(height: 2) }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("OPEN A FIELD UNIT").font(.reinDisplay(.largeTitle))
            Text("Choose an existing unit or register a new one before sending a message.").font(.reinBody()).foregroundStyle(theme.muted)
            Button("Open bots") { store.section = .bots }.buttonStyle(ReinPrimaryButtonStyle())
            Spacer()
        }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
    }

    private var transcript: some View {
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if store.canLoadEarlier {
                        Button { Task { await store.loadEarlier() } } label: { store.isLoadingHistory ? AnyView(ProgressView()) : AnyView(Text("Load earlier messages")) }
                            .buttonStyle(ReinSecondaryButtonStyle()).padding(.vertical, 12).disabled(store.isLoadingHistory)
                    }
                    if store.selectedMessages.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("FRESH CONTEXT. SAME JOURNEY.").font(.reinDisplay(.title))
                            Text("Send the first operator message. Rein keeps the journey on the host while this console renders the current exchange.").font(.reinBody()).foregroundStyle(theme.muted)
                        }.padding(24).frame(maxWidth: 760, alignment: .leading)
                    }
                    ForEach(ledgerItems) { item in
                        MessageLedgerRow(message: item.message, number: item.number, assistantOrdinal: item.assistantOrdinal).id(item.id)
                    }
                    Color.clear.frame(height: 1).id("transcript-end")
                }.padding(.horizontal, 16)
            }
            .onChange(of: store.selectedMessages.count) { _, _ in
                if reduceMotion { reader.scrollTo("transcript-end", anchor: .bottom) }
                else { withAnimation(.easeOut(duration: 0.18)) { reader.scrollTo("transcript-end", anchor: .bottom) } }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Conversation transcript")
        }
    }

    private var ledgerItems: [LedgerItem] {
        var assistantOrdinal = 0
        return store.selectedMessages.enumerated().map { index, message in
            if message.role == .assistant { assistantOrdinal += 1 }
            return LedgerItem(number: index + 1, assistantOrdinal: assistantOrdinal, message: message)
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("OPERATOR INPUT").font(.reinMono(.caption)).foregroundStyle(theme.accent).tracking(1)
                Spacer()
                if let notice = store.notice { Text(notice).font(.reinMono(.caption2)).foregroundStyle(theme.muted).lineLimit(1) }
            }
            TextEditor(text: $store.chatDraft).font(.reinBody()).scrollContentBackground(.hidden).padding(8).frame(minHeight: 70, maxHeight: 150)
                .background(theme.raised).overlay(Rectangle().stroke(theme.ink, lineWidth: 1)).focused($composerFocused)
                .accessibilityLabel("Message to \(store.selectedBot?.name ?? "Rein")")
                .onChange(of: store.chatDraft) { old, new in if new.count > old.count { store.sounds.play(.key) } }
            HStack {
                Text("\(store.chatDraft.utf8.count) / 131072").font(.reinMono(.caption2)).foregroundStyle(theme.muted)
                Spacer()
                if store.isRunning {
                    Button("Stop") { Task { await store.stop() } }.buttonStyle(ReinSecondaryButtonStyle())
                }
                Button("Send") {
                    let outgoing = store.chatDraft
                    Task { if await store.sendWithFallback(outgoing), store.chatDraft == outgoing { store.chatDraft = ""; composerFocused = false } }
                }.buttonStyle(ReinPrimaryButtonStyle()).disabled(store.isRunning || store.isCheckingRoute || store.chatDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.chatDraft.utf8.count > 131_072)
            }
        }.padding(.horizontal, 16).padding(.vertical, 10).background(theme.paperSecondary)
            .overlay(alignment: .top) { Rectangle().fill(theme.ink).frame(height: 2) }
    }
}

private struct LedgerItem: Identifiable {
    let number: Int
    let assistantOrdinal: Int
    let message: ReinMessage
    var id: String { message.id }
}

struct MessageLedgerRow: View {
    let message: ReinMessage
    let number: Int
    let assistantOrdinal: Int
    @Environment(\.reinTheme) private var theme

    private var presented: PresentedReply {
        message.role == .assistant
            ? ReplyPresentation.parse(message.content, final: message.completion != nil)
            : .init(pending: false, purpose: .message, text: message.content)
    }
    private var replyMarker: String { ["◐", "◓", "◑", "◒"][max(assistantOrdinal - 1, 0) % 4] }

    private var label: String {
        switch message.role {
        case .user: "OPERATOR INPUT"
        case .assistant: "REIN \(replyMarker) / AGENT REPLY" + (presented.purpose == .message ? "" : " · \(presented.purpose.rawValue)")
        case .tool: "TOOL CALL / EXEC"
        }
    }

    private var accessibleLabel: String {
        switch message.role {
        case .user: "Operator input"
        case .assistant: "Rein agent reply" + (presented.purpose == .message ? "" : ", \(presented.purpose.rawValue.lowercased())")
        case .tool: "Tool call or execution"
        }
    }

    private var identityColor: Color {
        guard message.role == .assistant else { return message.role == .tool ? theme.greenInk : theme.ink }
        return [theme.accent, theme.green, theme.muted, theme.ink][max(assistantOrdinal - 1, 0) % 4]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            FieldLabel(label, folio: String(format: "%03d", number))
                .foregroundStyle(identityColor)
            Text(presented.pending || presented.text.isEmpty ? "…" : presented.text)
                .font(message.role == .tool ? .reinMono(.callout, weight: .regular) : .reinBody())
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            if let calls = message.toolCalls {
                ForEach(calls) { call in
                    DisclosureGroup(call.function.name.uppercased()) {
                        Text(call.function.arguments).font(.reinMono(.caption, weight: .regular)).textSelection(.enabled).padding(.top, 8)
                    }.font(.reinMono(.caption)).frame(minHeight: 44)
                }
            }
            if let completion = message.completion {
                if let status = completion.statusLabel {
                    Text(status).font(.reinMono(.caption)).foregroundStyle(theme.muted)
                        .accessibilityLabel("Completion status: \(status)")
                }
                if let reasoning = completion.reasoningLabel {
                    Text("REASONING · \(reasoning)").font(.reinMono(.caption)).foregroundStyle(theme.muted)
                        .accessibilityLabel("Reasoning metadata: \(reasoning)")
                }
            }
        }
        .padding(.vertical, theme.spacing).padding(.horizontal, message.role == .tool ? 12 : 0)
        .foregroundStyle(message.role == .tool ? theme.greenInk : theme.ink)
        .background(message.role == .tool ? theme.green : message.role == .user ? theme.paperSecondary : theme.paper)
        .overlay(alignment: .bottom) { Rectangle().fill(message.role == .tool ? theme.ink : theme.rule).frame(height: message.role == .tool ? 2 : 1) }
        .accessibilityElement(children: .contain).accessibilityLabel("\(accessibleLabel), entry \(number)")
    }
}
