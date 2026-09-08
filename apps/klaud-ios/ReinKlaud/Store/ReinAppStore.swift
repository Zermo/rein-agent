import Foundation

enum AppSection: String, CaseIterable, Identifiable { case bots, chat, settings; var id: String { rawValue } }

struct PendingDecision: Identifiable, Equatable {
    enum Kind: Equatable { case approval(tool: String), confirmation }
    let id: String
    let runID: String
    let summary: String
    let kind: Kind
}

struct PendingRunRecovery: Identifiable, Equatable {
    let runID: String
    let origin: String
    var id: String { runID }
}

private struct PendingActionKey: Hashable {
    let runID: String
    let id: String
}

private struct StoreConnectionContext {
    let client: ReinGatewayClientProtocol
    let generation: Int
    let origin: URL
}

@MainActor
final class ReinAppStore: ObservableObject {
    @Published private(set) var state = ReinState.empty
    @Published private(set) var connectedURL: URL?
    @Published var selectedBotID: String?
    // Keep the unsent composer alive while connecting replaces the chat view.
    @Published var chatDraft = ""
    @Published var section: AppSection = .chat
    @Published private(set) var messagesByBot: [String: [ReinMessage]] = [:]
    @Published private(set) var historyCursor: [String: Int?] = [:]
    @Published private(set) var isConnecting = false
    @Published private(set) var isRunning = false
    @Published private(set) var isLoadingHistory = false
    @Published var errorMessage: String?
    @Published var notice: String?
    @Published var pendingDecision: PendingDecision?
    @Published private(set) var pendingRunRecovery: PendingRunRecovery?
    @Published var showCloudWorkspace = false
    @Published private(set) var showBotSetup = false
    @Published private(set) var activityBotID: String?
    @Published private(set) var activityPhase = BotAvatarPhase.ready
    @Published private(set) var isCheckingRoute = false
    @Published private(set) var gatewayUnavailable = false
    let cloud: CloudWorkspace

    private(set) var currentRunID: String?
    private var client: ReinGatewayClientProtocol?
    private var connectionGeneration = 0
    private var routingGeneration = 0
    private var runTask: Task<Void, Never>?
    private var runTaskGeneration = 0
    private let secrets: SecretStore
    private let defaults: UserDefaults
    private let eventCursor: RunEventCursor
    private let pendingRunRequests: PendingRunRequestStorage
    private let makeClient: @Sendable (GatewayConnection) -> ReinGatewayClientProtocol
    private let makeRunID: @Sendable () -> String
    private let now: @Sendable () -> Date
    private var decisionQueue: [PendingDecision] = []
    private var decisionInFlight: PendingActionKey?
    private var automaticActionTasks: [PendingActionKey: Task<Void, Never>] = [:]
    private var resolvedPendingActions: Set<PendingActionKey> = []
    let sounds: ReinSoundEngine
    private static let legacyTokenAccount = "gateway-token"
    private static let URLKey = "rein-klaud:gateway-url:v1"
    private static let legacyActiveRunKey = "rein-klaud:active-run:v1"
    private static let activeRunPrefix = "rein-klaud:active-run:v2:"

    init(
        secrets: SecretStore = KeychainStore(),
        defaults: UserDefaults = .standard,
        sounds: ReinSoundEngine? = nil,
        eventCursor: RunEventCursor? = nil,
        pendingRunRequests: PendingRunRequestStorage? = nil,
        cloudWorkspace: CloudWorkspace? = nil,
        makeClient: @escaping @Sendable (GatewayConnection) -> ReinGatewayClientProtocol = { ReinGatewayClient(connection: $0) },
        makeRunID: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.secrets = secrets
        self.defaults = defaults
        self.eventCursor = eventCursor ?? RunEventCursor(defaults: defaults)
        self.pendingRunRequests = pendingRunRequests ?? ProtectedPendingRunRequestStore()
        self.sounds = sounds ?? ReinSoundEngine()
        self.makeClient = makeClient
        self.makeRunID = makeRunID
        self.now = now
        cloud = cloudWorkspace ?? CloudWorkspace(defaults: defaults, secrets: secrets)
    }

    var selectedBot: ReinBot? { state.bots.first { $0.id == selectedBotID } }
    var selectedMessages: [ReinMessage] { selectedBotID.flatMap { messagesByBot[$0] } ?? [] }
    var savedURL: String { defaults.string(forKey: Self.URLKey) ?? "" }
    var savedToken: String { savedToken(for: savedURL) }
    var canLoadEarlier: Bool { selectedBotID.flatMap { historyCursor[$0] ?? nil } != nil }
    var accountConnection: GatewayConnection? {
        guard let connectedURL else { return nil }
        return try? ConnectionValidator.validate(url: connectedURL.absoluteString, token: savedToken(for: connectedURL.absoluteString))
    }

    func openCloudAccounts() { cloud.page = .accounts; showCloudWorkspace = true }
    func openDirectChat() {
        cloud.prepareContext(origin: connectedURL, botID: selectedBotID, recent: selectedMessages)
        cloud.page = .chat; showCloudWorkspace = true
    }

    func useBackup(_ backup: BackupGateway) async {
        routingGeneration &+= 1
        let route = routingGeneration
        do {
            let connection = try cloud.connection(for: backup)
            await connect(rawURL: connection.baseURL.absoluteString, token: connection.token, isBackup: true)
            if routingGeneration == route, connectedURL == connection.baseURL { showCloudWorkspace = false; notice = "Connected to backup \(backup.name). This host has its own sessions; original tasks remain tracked on their host." }
        } catch { if routingGeneration == route { fail(error) } }
    }

    /// A read-only preflight can change routes before a task is submitted. Once
    /// submitted, a missing response never causes automatic task replay.
    func sendWithFallback(_ text: String) async -> Bool {
        guard !isCheckingRoute, !isRunning, trackedRunID == nil, let context = currentConnectionContext() else { return false }
        guard cloud.hasAutomaticFallback else { return send(text) }
        let route = routingGeneration
        let sourceBotID = selectedBotID, sourceMessages = selectedMessages
        isCheckingRoute = true
        defer { isCheckingRoute = false }
        do {
            try await context.client.probe()
            try requireCurrentConnection(context)
            guard selectedBotID == sourceBotID else {
                notice = "The selected field unit changed. Review it before sending your draft."
                return false
            }
            gatewayUnavailable = false
            return send(text)
        } catch {
            guard isCurrentConnection(context), GatewayFallbackPolicy.isUnavailable(error) else {
                if isCurrentConnection(context) { fail(error) }
                return false
            }
            gatewayUnavailable = true
            guard cloud.hasAutomaticFallback else { fail(error); return false }
            if await tryBackup(excluding: context.origin, route: route) {
                notice = "Backup connected. Review its selected field unit, then send your message. The draft has been kept."
                return false
            }
            guard routingGeneration == route, !Task.isCancelled, cloud.hasAutomaticFallback else { return false }
            guard !cloud.accounts.accounts.isEmpty else { fail(error); return false }
            cloud.prepareContext(origin: context.origin, botID: sourceBotID, recent: sourceMessages)
            cloud.page = .chat; showCloudWorkspace = true
            return cloud.send(text, sounds: sounds)
        }
    }

    private func tryBackup(excluding origin: URL, route: Int) async -> Bool {
        for backup in cloud.backups where backup.origin != origin {
            guard !Task.isCancelled, routingGeneration == route, cloud.hasAutomaticFallback else { return false }
            guard let connection = try? cloud.connection(for: backup) else { continue }
            await connect(rawURL: connection.baseURL.absoluteString, token: connection.token, isBackup: true)
            guard !Task.isCancelled, routingGeneration == route else { return false }
            if connectedURL == connection.baseURL { return true }
        }
        return false
    }

    func connect(rawURL: String, token: String, isBackup: Bool = false, assistedSetup: Bool = false) async {
        if !isBackup { routingGeneration &+= 1 }
        let route = routingGeneration
        isConnecting = true; errorMessage = nil
        let connection: GatewayConnection
        do { connection = try ConnectionValidator.validate(url: rawURL, token: token) }
        catch { fail(error); isConnecting = false; return }
        connectionGeneration &+= 1
        let generation = connectionGeneration
        let previousRunID = trackedRunID
        runTask?.cancel(); runTask = nil; runTaskGeneration &+= 1
        clearPendingActions(for: previousRunID)
        activityBotID = nil; activityPhase = .ready
        client = nil; connectedURL = nil; currentRunID = nil; pendingRunRecovery = nil
        isRunning = false; isLoadingHistory = false; notice = nil
        do {
            migrateLegacyActiveRun(from: canonicalOrigin(from: savedURL))
            let candidate = makeClient(connection)
            let snapshot = try await candidate.state()
            guard connectionGeneration == generation, !Task.isCancelled else { return }
            showBotSetup = assistedSetup && !defaults.bool(forKey: setupKey(for: connection.baseURL))
            client = candidate; state = snapshot; connectedURL = connection.baseURL; gatewayUnavailable = false
            if !isBackup { defaults.set(connection.baseURL.absoluteString, forKey: Self.URLKey) }
            try secrets.write(connection.token, account: tokenAccount(for: connection.baseURL))
            try? secrets.delete(account: Self.legacyTokenAccount)
            let context = StoreConnectionContext(client: candidate, generation: generation, origin: connection.baseURL)
            let preferred = snapshot.bots.first { $0.id == snapshot.prefs.lastBotId }?.id ?? snapshot.bots.first?.id
            selectedBotID = preferred
            if let preferred { try await loadMessages(context: context, botID: preferred, before: nil) }
            await recoverStoredRun(context: context)
            guard isCurrentConnection(context) else { return }
            sounds.play(.ready)
        } catch {
            guard connectionGeneration == generation, !Task.isCancelled else { return }
            fail(error)
            if !isBackup, cloud.hasAutomaticFallback, GatewayFallbackPolicy.isUnavailable(error) {
                if await tryBackup(excluding: connection.baseURL, route: route) { showCloudWorkspace = false; return }
                guard routingGeneration == route, !Task.isCancelled else { return }
                if !cloud.accounts.accounts.isEmpty { openDirectChat() }
            }
        }
        if connectionGeneration == generation { isConnecting = false }
    }

    func disconnect(forget: Bool = false) {
        routingGeneration &+= 1
        let tokenOrigin = connectedURL ?? canonicalOrigin(from: savedURL)
        let activeRunID = currentRunID ?? tokenOrigin.flatMap(storedActiveRunID)
        connectionGeneration &+= 1
        runTask?.cancel(); runTask = nil; runTaskGeneration &+= 1
        automaticActionTasks.values.forEach { $0.cancel() }; automaticActionTasks.removeAll()
        showBotSetup = false
        activityBotID = nil; activityPhase = .ready
        client = nil; connectedURL = nil; isConnecting = false; isRunning = false; isLoadingHistory = false; currentRunID = nil; pendingRunRecovery = nil
        gatewayUnavailable = false
        clearPendingActions(for: activeRunID); notice = nil; errorMessage = nil
        if forget {
            defaults.removeObject(forKey: Self.URLKey)
            if let tokenOrigin { clearPersistedActiveRun(for: tokenOrigin) }
            defaults.removeObject(forKey: Self.legacyActiveRunKey)
            if let activeRunID { eventCursor.clear(runID: activeRunID) }
            if let tokenOrigin { try? secrets.delete(account: tokenAccount(for: tokenOrigin)) }
            if let tokenOrigin { try? pendingRunRequests.removeAll(for: tokenOrigin) }
            try? secrets.delete(account: Self.legacyTokenAccount)
        }
    }

    func savedToken(for rawURL: String) -> String {
        guard let origin = canonicalOrigin(from: rawURL) else { return "" }
        return (try? secrets.read(account: tokenAccount(for: origin))) ?? ""
    }

    func refresh() async {
        guard let context = currentConnectionContext() else { return }
        await refresh(context: context)
    }

    private func refresh(context: StoreConnectionContext) async {
        guard isCurrentConnection(context) else { return }
        do {
            let snapshot = try await context.client.state()
            try requireCurrentConnection(context)
            state = snapshot
            normalizeSelection()
        } catch {
            guard isCurrentConnection(context) else { return }
            fail(error)
        }
        guard isCurrentConnection(context) else { return }
        if let runID = trackedRunID {
            await reconcile(runID: runID, context: context)
        }
    }

    func didBecomeActive() async {
        guard let context = currentConnectionContext() else { return }
        guard let runID = trackedRunID else { await refresh(context: context); return }
        await reconcile(runID: runID, restartSubscription: true, context: context)
    }

    func avatarPhase(for bot: ReinBot) -> BotAvatarPhase {
        guard activityBotID == bot.id else { return .ready }
        if pendingDecision != nil { return .approval }
        if activityPhase == .error { return .error }
        guard isRunning else { return .ready }
        if gatewayUnavailable || errorMessage != nil { return .error }
        return activityPhase == .ready ? .working : activityPhase
    }

    func updateBotAvatar(_ bot: ReinBot, avatar: BotAvatarStyle) async -> Bool {
        guard let context = currentConnectionContext() else { return false }
        do {
            let updated = try await context.client.updateBotAvatar(botID: bot.id, avatar: avatar.rawValue)
            try requireCurrentConnection(context)
            guard let index = state.bots.firstIndex(where: { $0.id == bot.id }), updated.id == bot.id else { return false }
            state.bots[index] = updated
            return true
        } catch {
            guard isCurrentConnection(context) else { return false }
            fail(error); return false
        }
    }

    private func setupKey(for origin: URL) -> String { "klaudbot:assisted-setup:v1:" + origin.absoluteString }

    func completeBotSetup() {
        guard let origin = connectedURL, selectedBot != nil else { return }
        defaults.set(true, forKey: setupKey(for: origin))
        showBotSetup = false
        section = .chat
    }

    func createBot(name: String, avatar: String? = nil) async -> Bool {
        guard let context = currentConnectionContext(), !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        do {
            let bot = try await context.client.createBot(name: String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64)), avatar: avatar)
            try requireCurrentConnection(context)
            let snapshot = try await context.client.state()
            try requireCurrentConnection(context)
            state = snapshot
            guard snapshot.bots.contains(where: { $0.id == bot.id }) else { throw GatewayClientError.invalidResponse }
            await chooseBot(bot.id, context: context)
            try requireCurrentConnection(context)
            guard errorMessage == nil else { return false }
            sounds.play(.ready)
            return true
        } catch {
            guard isCurrentConnection(context) else { return false }
            fail(error)
            return false
        }
    }

    func chooseBot(_ id: String, persist: Bool = true) async {
        guard let context = currentConnectionContext() else { return }
        await chooseBot(id, persist: persist, context: context)
    }

    private func chooseBot(_ id: String, persist: Bool = true, context: StoreConnectionContext) async {
        guard isCurrentConnection(context) else { return }
        guard state.bots.contains(where: { $0.id == id }) else { return }
        selectedBotID = id; section = .chat; errorMessage = nil
        do {
            try await loadMessages(context: context, botID: id, before: nil)
            if persist {
                let snapshot = try await context.client.setPreference(lastBotID: id)
                try requireCurrentConnection(context)
                state = snapshot
            }
        } catch {
            guard isCurrentConnection(context) else { return }
            fail(error)
        }
    }

    func loadEarlier() async {
        guard let context = currentConnectionContext() else { return }
        guard let id = selectedBotID, let wrapped = historyCursor[id], let before = wrapped else { return }
        isLoadingHistory = true
        do { try await loadMessages(context: context, botID: id, before: before) }
        catch {
            guard isCurrentConnection(context) else { return }
            fail(error)
        }
        if isCurrentConnection(context) { isLoadingHistory = false }
    }

    @discardableResult
    func send(_ text: String) -> Bool {
        guard let context = currentConnectionContext(), let bot = selectedBot, !isRunning else { return false }
        guard trackedRunID == nil else {
            isRunning = true
            notice = "Rein is still working on the tracked host run. Reconnect or stop it before sending again."
            return false
        }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return false }
        let runID = makeRunID()
        let request = RunRequest(runId: runID, threadId: bot.sessionId, botId: bot.id, message: clean, tools: ReinGatewayClient.frontendTools)
        do { try pendingRunRequests.save(request, for: context.origin, now: now()) }
        catch {
            fail(error)
            notice = "The request was not sent because its protected retry copy could not be saved."
            return false
        }
        activityBotID = bot.id; activityPhase = .working
        errorMessage = nil; notice = "Streaming from \(bot.name)…"; isRunning = true
        let optimistic = ReinMessage(id: "pending-user-\(UUID().uuidString)", role: .user, content: clean)
        messagesByBot[bot.id, default: []].append(optimistic)
        sounds.play(.send)
        currentRunID = runID
        persistActiveRun(runID, origin: context.origin)
        runTask?.cancel()
        runTaskGeneration &+= 1
        let generation = runTaskGeneration
        runTask = Task { [weak self] in
            guard let self else { return }
            var accepted = false
            do {
                let receipt = try await context.client.startRun(request)
                guard self.isCurrentRun(generation, context: context) else { return }
                accepted = true
                self.clearPendingRunRequest(runID: runID, for: context.origin)
                self.pendingRunRecovery = nil
                for try await item in context.client.resume(runID: receipt.runId, after: self.eventCursor.lastHandled(runID: receipt.runId)) {
                    try Task.checkCancellation()
                    guard self.isCurrentRun(generation, context: context) else { return }
                    guard self.eventCursor.shouldHandle(runID: item.runID, sequence: item.sequence) else { continue }
                    await self.consume(item.event, botID: bot.id, context: context)
                    guard self.isCurrentRun(generation, context: context) else { return }
                    self.eventCursor.markHandled(runID: item.runID, sequence: item.sequence)
                }
                try Task.checkCancellation()
                guard self.isCurrentRun(generation, context: context) else { return }
                await self.finishRun(botID: bot.id, context: context)
            } catch is CancellationError { return }
            catch {
                guard self.isCurrentRun(generation, context: context) else { return }
                if !accepted, self.isKnownStartRejection(error) {
                    self.clearPendingRunRequest(runID: runID, for: context.origin)
                    self.pendingRunRecovery = nil
                    self.clearPersistedActiveRun(for: context.origin)
                    self.currentRunID = nil; self.isRunning = false; self.runTask = nil
                    self.messagesByBot[bot.id]?.removeAll { $0.id == optimistic.id }
                    self.clearPendingActions(for: runID)
                    self.fail(error)
                    self.notice = "The host rejected the saved request, so it will not be retried."
                    return
                }
                self.fail(error); self.isRunning = true
                self.notice = accepted
                    ? "Connection paused. Rein continues on the host; reopen the app to reconnect."
                    : "Delivery is unknown. The protected request was not replayed; choose Retry or Discard."
                if !accepted {
                    self.pendingRunRecovery = .init(runID: runID, origin: context.origin.absoluteString)
                }
                self.runTask = nil
            }
        }
        return true
    }

    func stop() async {
        guard let context = currentConnectionContext() else { return }
        guard let runID = trackedRunID else {
            errorMessage = "Rein is still starting this run. Try Stop again in a moment."
            notice = "The stop request was not sent."
            sounds.play(.error)
            return
        }
        guard clearPendingRunRequest(runID: runID, for: context.origin) else {
            notice = "The stop request was not sent because the protected retry copy could not be cleared safely. Try Stop again."
            return
        }
        pendingRunRecovery = nil
        do {
            try await context.client.cancel(runID: runID)
            try requireCurrentConnection(context)
        }
        catch {
            guard isCurrentConnection(context) else { return }
            fail(error)
            currentRunID = runID
            persistActiveRun(runID, origin: context.origin)
            isRunning = true
            notice = "The stop request did not reach the host. The run is still tracked; try Stop again."
            await reconcileAfterFailedCancel(runID: runID, context: context)
            return
        }
        runTask?.cancel(); runTask = nil; runTaskGeneration &+= 1; isRunning = false; currentRunID = nil; notice = "Run stopped by operator."
        clearPersistedActiveRun(for: context.origin)
        eventCursor.clear(runID: runID)
        clearPendingActions(for: runID)
    }

    func retryPendingRun(_ recovery: PendingRunRecovery) async {
        guard let context = currentConnectionContext(),
              recovery.origin == context.origin.absoluteString,
              recovery.runID == trackedRunID else { return }
        do {
            let saved = try pendingRunRequests.load(for: context.origin, now: now())
            guard case .pending(let request) = saved, request.runId == recovery.runID,
                  state.bots.contains(where: { $0.id == request.botId && $0.sessionId == request.threadId }) else {
                pendingRunRecovery = nil
                if trackedRunID == recovery.runID {
                    clearPersistedActiveRun(for: context.origin)
                    currentRunID = nil; isRunning = false
                    eventCursor.clear(runID: recovery.runID)
                    clearPendingActions(for: recovery.runID)
                }
                notice = "The protected request is no longer available to retry."
                return
            }
            pendingRunRecovery = nil; isRunning = true
            notice = "Retrying the protected request with its original ID…"
            await submitPersistedRun(request, context: context)
        } catch {
            guard isCurrentConnection(context) else { return }
            fail(error)
            notice = "The protected request could not be opened. It was not sent."
        }
    }

    func discardPendingRun(_ recovery: PendingRunRecovery) async {
        guard let context = currentConnectionContext(), recovery.origin == context.origin.absoluteString else { return }
        guard clearPendingRunRequest(runID: recovery.runID, for: context.origin) else {
            notice = "The saved retry could not be discarded. It was not sent."
            return
        }
        pendingRunRecovery = nil
        guard trackedRunID == recovery.runID else {
            notice = "Saved retry discarded."
            return
        }
        notice = "Saved retry discarded. Checking whether the host already started this run."
        await reconcile(runID: recovery.runID, restartSubscription: true, context: context)
        guard isCurrentConnection(context) else { return }
        if trackedRunID == nil, notice == "The tracked run is no longer available on this host." {
            notice = "Saved retry discarded. It may have run earlier; no cancellation was sent."
        }
    }

    func decide(_ decision: PendingDecision, allow: Bool) async {
        let key = pendingKey(decision)
        guard let context = currentConnectionContext(), decisionInFlight == nil,
              decisionQueue.first.map(pendingKey) == key else { return }
        decisionInFlight = key
        pendingDecision = nil
        do {
            switch decision.kind {
            case .approval: try await context.client.answerApproval(runID: decision.runID, approvalID: decision.id, allow: allow)
            case .confirmation:
                let payload = String(data: try JSONEncoder().encode(["confirmed": allow]), encoding: .utf8) ?? "{\"confirmed\":false}"
                try await context.client.answerTool(runID: decision.runID, callID: decision.id, result: payload, isError: false)
            }
            guard isCurrentConnection(context) else { return }
            resolvedPendingActions.insert(key)
            decisionQueue.removeAll { pendingKey($0) == key }
            decisionInFlight = nil
            presentNextDecision()
            await refresh(context: context)
        } catch {
            guard isCurrentConnection(context) else { return }
            decisionInFlight = nil
            await refresh(context: context)
            guard isCurrentConnection(context) else { return }
            fail(error)
            let stillWaiting = decisionQueue.contains { pendingKey($0) == key }
            notice = stillWaiting
                ? "That answer was not accepted. It is still waiting; try again."
                : "That request changed on the host. The next waiting action is ready."
            presentNextDecision()
        }
    }

    func setDark(_ dark: Bool) async { await patch([.init(op: "replace", path: "/theme/dark", value: .bool(dark))]) }
    func setAccent(_ accent: String) async { await patch([.init(op: "replace", path: "/theme/accent", value: .string(accent))]) }
    func setDensity(_ density: String) async { await patch([.init(op: "replace", path: "/theme/density", value: .string(density))]) }
    func setSidebar(_ visible: Bool) async { await patch([.init(op: "replace", path: "/chrome/sidebar", value: .bool(visible))]) }
    func setActivity(_ visible: Bool) async { await patch([.init(op: "replace", path: "/chrome/showActivity", value: .bool(visible))]) }

    private func patch(_ patch: [ShellPatch]) async {
        guard let context = currentConnectionContext() else { return }
        do {
            let snapshot = try await context.client.patchShell(patch)
            try requireCurrentConnection(context)
            state = snapshot
        } catch {
            guard isCurrentConnection(context) else { return }
            fail(error)
        }
    }

    private func loadMessages(context: StoreConnectionContext, botID: String, before: Int?) async throws {
        let page = try await context.client.messages(botID: botID, before: before)
        try requireCurrentConnection(context)
        if before == nil { messagesByBot[botID] = page.messages }
        else {
            let existing = messagesByBot[botID] ?? []
            messagesByBot[botID] = page.messages + existing.filter { item in !page.messages.contains(where: { $0.id == item.id }) }
        }
        historyCursor[botID] = .some(page.before)
    }

    private func consume(_ event: GatewayEvent, botID: String, context: StoreConnectionContext) async {
        guard isCurrentConnection(context) else { return }
        do {
            activityBotID = botID
            switch event.type {
            case "RUN_STARTED", "TOOL_CALL_END": activityPhase = .working
            case "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT": activityPhase = .responding
            case "TOOL_CALL_START": activityPhase = .tool
            case "RUN_ERROR": activityPhase = .error
            case "RUN_FINISHED": activityPhase = .ready
            default: break
            }
            if event.type == "RUN_STARTED" { currentRunID = event.runId }
            if event.type == "RUN_STARTED", let id = event.runId { persistActiveRun(id, origin: context.origin) }
            if event.type == "TEXT_MESSAGE_START" { sounds.play(.reply) }
            if event.type == "TOOL_CALL_START" { sounds.play(.tool) }
            var messages = messagesByBot[botID] ?? []
            try StateReducer.apply(event: event, state: &state, messages: &messages)
            messagesByBot[botID] = messages
            if event.type == "CUSTOM" { try await handleFrontend(event, context: context) }
            try requireCurrentConnection(context)
            if event.type == "RUN_ERROR" { errorMessage = event.message ?? "Run failed."; sounds.play(.error) }
            if event.type == "RUN_FINISHED" { notice = "Run complete."; sounds.play(.ready) }
        } catch {
            guard isCurrentConnection(context) else { return }
            fail(error)
        }
    }

    private func handleFrontend(_ event: GatewayEvent, context: StoreConnectionContext) async throws {
        try requireCurrentConnection(context)
        guard let value = event.value?.objectValue,
              let runID = value["runId"]?.stringValue else { throw StateReducerError.invalidPatch }
        let identifier = value["toolCallId"]?.stringValue ?? value["id"]?.stringValue
        guard let identifier else { throw StateReducerError.invalidPatch }
        if event.name == "klaud.approval" {
            enqueueDecision(.init(id: identifier, runID: runID, summary: value["summary"]?.stringValue ?? "Review this action.", kind: .approval(tool: value["tool"]?.stringValue ?? "tool"))); return
        }
        guard event.name == "klaud.frontend_tool", let name = value["toolName"]?.stringValue else { return }
        let args = value["args"]?.objectValue ?? [:]
        if name == "confirmAction" {
            enqueueDecision(.init(id: identifier, runID: runID, summary: args["action"]?.stringValue ?? "Confirm this action.", kind: .confirmation)); return
        }
        try await executeFrontend(client: context.client, connectionGeneration: context.generation, runID: runID, identifier: identifier, name: name, args: args)
    }

    private func executeFrontend(client: ReinGatewayClientProtocol, connectionGeneration generation: Int, runID: String, identifier: String, name: String, args: [String: JSONValue]) async throws {
        try requireCurrentConnection(generation)
        let output: JSONValue, isError: Bool
        do {
            switch name {
            case "navigateTo":
                guard let raw = args["dest"]?.stringValue, let target = AppSection(rawValue: raw) else { throw StateReducerError.invalidPatch }
                section = target; output = .object(["dest": .string(raw)])
            case "setPref":
                guard args["key"]?.stringValue == "lastBotId", let id = args["value"]?.stringValue, state.bots.contains(where: { $0.id == id }) else { throw StateReducerError.invalidPatch }
                let page = try await client.messages(botID: id, before: nil)
                try requireCurrentConnection(generation)
                selectedBotID = id; section = .chat; messagesByBot[id] = page.messages; historyCursor[id] = .some(page.before)
                output = .object(["key": .string("lastBotId"), "value": .string(id)])
            case "patchShell":
                guard let rawPatch = args["patch"] else { throw StateReducerError.invalidPatch }
                let data = try JSONEncoder().encode(rawPatch)
                let patch = try JSONDecoder().decode([ShellPatch].self, from: data)
                let patched = try await client.patchShell(patch)
                try requireCurrentConnection(generation)
                state = patched; output = .object(["ok": .bool(true)])
            default: throw StateReducerError.invalidPatch
            }
            isError = false
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            output = .object(["error": .string((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)])
            isError = true
        }
        try requireCurrentConnection(generation)
        let result = String(data: try JSONEncoder().encode(output), encoding: .utf8) ?? "{}"
        try await client.answerTool(runID: runID, callID: identifier, result: result, isError: isError)
        try requireCurrentConnection(generation)
    }

    private func finishRun(botID: String, context: StoreConnectionContext, terminalStatus: String? = nil, terminalError: String? = nil) async {
        guard isCurrentConnection(context) else { return }
        let finishedRunID = currentRunID ?? storedActiveRunID(for: context.origin)
        let completion = messagesByBot[botID]?.last(where: { $0.role == .assistant })?.completion
        isRunning = false; currentRunID = nil; runTask = nil
        presentTerminalStatus(terminalStatus, error: terminalError)
        if let finishedRunID { clearPendingRunRequest(runID: finishedRunID, for: context.origin) }
        if pendingRunRecovery?.runID == finishedRunID { pendingRunRecovery = nil }
        clearPersistedActiveRun(for: context.origin)
        if let finishedRunID { eventCursor.clear(runID: finishedRunID) }
        clearPendingActions(for: finishedRunID)
        do {
            try await loadMessages(context: context, botID: botID, before: nil)
            if let completion, let index = messagesByBot[botID]?.lastIndex(where: { $0.role == .assistant }) {
                messagesByBot[botID]?[index].completion = completion
            }
            let snapshot = try await context.client.state()
            try requireCurrentConnection(context)
            state = snapshot
        }
        catch {
            guard isCurrentConnection(context) else { return }
            fail(error)
        }
    }

    private func normalizeSelection() {
        if !state.bots.contains(where: { $0.id == selectedBotID }) { selectedBotID = state.bots.first { $0.id == state.prefs.lastBotId }?.id ?? state.bots.first?.id }
    }

    private func recoverStoredRun(context: StoreConnectionContext) async {
        guard isCurrentConnection(context) else { return }
        let activeRunID = storedActiveRunID(for: context.origin)
        let saved: PendingRunRequestLoadResult
        do { saved = try pendingRunRequests.load(for: context.origin, now: now()) }
        catch {
            fail(error)
            if let activeRunID {
                currentRunID = activeRunID; isRunning = true
                await reattach(runID: activeRunID, context: context)
            }
            return
        }

        switch saved {
        case .none:
            if let activeRunID { await reattach(runID: activeRunID, context: context) }
        case .expired(let runID):
            notice = "A protected request expired and will not be started automatically. Checking the host for an existing run."
            if let activeRunID { await reattach(runID: activeRunID, context: context) }
            else { eventCursor.clear(runID: runID) }
        case .pending(let request):
            guard state.bots.contains(where: { $0.id == request.botId && $0.sessionId == request.threadId }) else {
                clearPendingRunRequest(runID: request.runId, for: context.origin)
                if activeRunID == request.runId { clearPersistedActiveRun(for: context.origin) }
                notice = "A saved request no longer matches this gateway and was not replayed."
                return
            }
            if let activeRunID, activeRunID != request.runId {
                notice = "A different saved request was not replayed while another run is tracked."
                await reattach(runID: activeRunID, context: context)
                return
            }
            currentRunID = request.runId; isRunning = true
            persistActiveRun(request.runId, origin: context.origin)
            await reattach(runID: request.runId, context: context)
        }
    }

    private func recoverPendingRun(runID: String, context: StoreConnectionContext) async -> Bool {
        let saved: PendingRunRequestLoadResult
        do { saved = try pendingRunRequests.load(for: context.origin, now: now()) }
        catch let error as PendingRunRequestStoreError {
            fail(error)
            return false
        } catch {
            currentRunID = runID; isRunning = true
            notice = "The protected request is temporarily unavailable. Rein will defer recovery instead of clearing it."
            fail(error)
            return true
        }
        switch saved {
        case .pending(let request) where request.runId == runID:
            guard state.bots.contains(where: { $0.id == request.botId && $0.sessionId == request.threadId }) else {
                clearPendingRunRequest(runID: runID, for: context.origin)
                return false
            }
            currentRunID = runID; isRunning = true
            pendingRunRecovery = .init(runID: runID, origin: context.origin.absoluteString)
            notice = "The host does not recognize this run. Its protected request was not replayed; choose Retry or Discard."
            return true
        case .expired(let expiredID) where expiredID == runID:
            clearPersistedActiveRun(for: context.origin)
            currentRunID = nil; isRunning = false
            eventCursor.clear(runID: runID); clearPendingActions(for: runID)
            notice = "The saved request expired and was not replayed."
            return true
        case .pending(let request):
            clearPersistedActiveRun(for: context.origin)
            currentRunID = request.runId; isRunning = true
            persistActiveRun(request.runId, origin: context.origin)
            notice = "The earlier tracked run is unavailable. Checking the separately saved request without replaying it."
            await reattach(runID: request.runId, context: context)
            return true
        case .none, .expired:
            return false
        }
    }

    private func submitPersistedRun(_ request: RunRequest, context: StoreConnectionContext) async {
        do {
            let receipt = try await context.client.startRun(request)
            try requireCurrentConnection(context)
            clearPendingRunRequest(runID: request.runId, for: context.origin)
            currentRunID = receipt.runId; isRunning = true
            persistActiveRun(receipt.runId, origin: context.origin)
            await reattach(runID: receipt.runId, context: context)
        } catch {
            guard isCurrentConnection(context) else { return }
            if isKnownStartRejection(error) {
                clearPendingRunRequest(runID: request.runId, for: context.origin)
                pendingRunRecovery = nil
                clearPersistedActiveRun(for: context.origin)
                currentRunID = nil; isRunning = false
                eventCursor.clear(runID: request.runId); clearPendingActions(for: request.runId)
                fail(error)
                notice = "The host rejected the saved request, so it will not be retried."
            } else {
                currentRunID = request.runId; isRunning = true
                persistActiveRun(request.runId, origin: context.origin)
                pendingRunRecovery = .init(runID: request.runId, origin: context.origin.absoluteString)
                fail(error)
                notice = "Delivery is still unknown. The protected request was not replayed; choose Retry or Discard."
            }
        }
    }

    @discardableResult
    private func clearPendingRunRequest(runID: String, for origin: URL) -> Bool {
        do {
            try pendingRunRequests.remove(runID: runID, for: origin)
            return true
        } catch {
            fail(error)
            return false
        }
    }

    private func isKnownStartRejection(_ error: Error) -> Bool {
        guard case GatewayClientError.http(let status, _) = error else { return false }
        return [400, 401, 403, 404, 409, 413, 415].contains(status)
    }

    private func presentTerminalStatus(_ status: String?, error: String?) {
        switch status {
        case "failed":
            errorMessage = error ?? "The run ended with an error."
            notice = "Run ended with an error."
        case "cancelled": notice = "Run stopped."
        case "completed": notice = "Run complete."
        default:
            if notice?.hasPrefix("Streaming from ") == true { notice = "Run complete." }
        }
    }

    private func reattach(runID: String, context: StoreConnectionContext) async {
        guard isCurrentConnection(context) else { return }
        do {
            let snapshot = try await context.client.runStatus(runID: runID)
            try requireCurrentConnection(context)
            clearPendingRunRequest(runID: runID, for: context.origin)
            if pendingRunRecovery?.runID == runID { pendingRunRecovery = nil }
            guard !snapshot.isTerminal else {
                if let bot = state.bots.first(where: { $0.sessionId == snapshot.threadId }) {
                    await finishRun(botID: bot.id, context: context, terminalStatus: snapshot.status, terminalError: snapshot.error)
                } else {
                    runTask?.cancel(); runTask = nil; runTaskGeneration &+= 1
                    clearPersistedActiveRun(for: context.origin); currentRunID = nil; isRunning = false
                    eventCursor.clear(runID: runID)
                    clearPendingActions(for: runID)
                    presentTerminalStatus(snapshot.status, error: snapshot.error)
                }
                return
            }
            guard let bot = state.bots.first(where: { $0.sessionId == snapshot.threadId }) else { throw GatewayClientError.invalidResponse }
            selectedBotID = bot.id
            activityBotID = bot.id; activityPhase = .working
            try await loadMessages(context: context, botID: bot.id, before: nil)
            currentRunID = runID; isRunning = true; adoptPending(from: snapshot, context: context)
            let resumeAfter = min(max(eventCursor.lastHandled(runID: runID), snapshot.oldestSequence - 1), snapshot.lastSequence)
            runTask?.cancel()
            runTaskGeneration &+= 1
            let generation = runTaskGeneration
            runTask = Task { [weak self] in
                guard let self else { return }
                do {
                    for try await item in context.client.resume(runID: runID, after: resumeAfter) {
                        try Task.checkCancellation()
                        guard self.isCurrentRun(generation, context: context) else { return }
                        guard self.eventCursor.shouldHandle(runID: item.runID, sequence: item.sequence) else { continue }
                        await self.consume(item.event, botID: bot.id, context: context)
                        guard self.isCurrentRun(generation, context: context) else { return }
                        self.eventCursor.markHandled(runID: item.runID, sequence: item.sequence)
                    }
                    try Task.checkCancellation()
                    guard self.isCurrentRun(generation, context: context) else { return }
                    await self.finishRun(botID: bot.id, context: context)
                } catch is CancellationError { return }
                catch {
                    guard self.isCurrentRun(generation, context: context) else { return }
                    self.fail(error); self.isRunning = true; self.notice = "Connection paused. Rein continues on the host; reopen the app to reconnect."; self.runTask = nil
                }
            }
        } catch GatewayClientError.http(404, _) {
            guard isCurrentConnection(context) else { return }
            if await recoverPendingRun(runID: runID, context: context) { return }
            runTask?.cancel(); runTask = nil; runTaskGeneration &+= 1
            clearPersistedActiveRun(for: context.origin); currentRunID = nil; isRunning = false
            clearPendingActions(for: runID)
        }
        catch {
            guard isCurrentConnection(context) else { return }
            currentRunID = runID; isRunning = true; notice = "Rein is still on the host. This console will reconnect when the gateway is reachable."
        }
    }

    private func reconcile(runID: String, restartSubscription: Bool = false, context: StoreConnectionContext) async {
        guard isCurrentConnection(context) else { return }
        do {
            let snapshot = try await context.client.runStatus(runID: runID)
            try requireCurrentConnection(context)
            clearPendingRunRequest(runID: runID, for: context.origin)
            if pendingRunRecovery?.runID == runID { pendingRunRecovery = nil }
            if snapshot.isTerminal {
                runTask?.cancel(); runTask = nil; runTaskGeneration &+= 1
                if let bot = state.bots.first(where: { $0.sessionId == snapshot.threadId }) {
                    await finishRun(botID: bot.id, context: context, terminalStatus: snapshot.status, terminalError: snapshot.error)
                } else {
                    clearPersistedActiveRun(for: context.origin)
                    currentRunID = nil
                    isRunning = false
                    eventCursor.clear(runID: runID)
                    clearPendingActions(for: runID)
                    presentTerminalStatus(snapshot.status, error: snapshot.error)
                }
            }
            else if restartSubscription || runTask == nil { await reattach(runID: runID, context: context) }
            else { currentRunID = runID; isRunning = true; adoptPending(from: snapshot, context: context) }
        } catch GatewayClientError.http(404, _) {
            guard isCurrentConnection(context) else { return }
            if await recoverPendingRun(runID: runID, context: context) { return }
            runTask?.cancel(); runTask = nil; runTaskGeneration &+= 1
            clearPersistedActiveRun(for: context.origin); currentRunID = nil; isRunning = false
            eventCursor.clear(runID: runID)
            clearPendingActions(for: runID)
            notice = "The tracked run is no longer available on this host."
        } catch {
            guard isCurrentConnection(context) else { return }
            fail(error)
        }
    }

    private func adoptPending(from snapshot: MobileRunSnapshot, context: StoreConnectionContext) {
        guard isCurrentConnection(context) else { return }
        var seen: Set<PendingActionKey> = []
        var recovered: [PendingDecision] = []
        var automatic: [MobilePendingAction] = []

        for pending in snapshot.pending {
            let key = PendingActionKey(runID: snapshot.id, id: pending.id)
            guard seen.insert(key).inserted, !resolvedPendingActions.contains(key) else { continue }
            if pending.kind == "approval" {
                recovered.append(.init(id: pending.id, runID: snapshot.id, summary: pending.summary, kind: .approval(tool: pending.tool)))
            } else if pending.tool == "confirmAction" {
                recovered.append(.init(id: pending.id, runID: snapshot.id, summary: pending.summary, kind: .confirmation))
            } else {
                automatic.append(pending)
            }
        }

        decisionQueue = recovered
        if let shown = pendingDecision, !decisionQueue.contains(where: { pendingKey($0) == pendingKey(shown) }) {
            pendingDecision = nil
        }
        presentNextDecision()

        for pending in automatic {
            let key = PendingActionKey(runID: snapshot.id, id: pending.id)
            guard automaticActionTasks[key] == nil else { continue }
            automaticActionTasks[key] = Task { [weak self] in
                guard let self else { return }
                do {
                    try await self.executeFrontend(client: context.client, connectionGeneration: context.generation, runID: snapshot.id, identifier: pending.id, name: pending.tool, args: pending.args ?? [:])
                    guard self.isCurrentConnection(context) else { return }
                    self.resolvedPendingActions.insert(key)
                    self.automaticActionTasks.removeValue(forKey: key)
                    await self.reconcile(runID: snapshot.id, context: context)
                } catch is CancellationError {
                    guard self.isCurrentConnection(context) else { return }
                    self.automaticActionTasks.removeValue(forKey: key)
                } catch {
                    guard self.isCurrentConnection(context) else { return }
                    self.automaticActionTasks.removeValue(forKey: key)
                    self.fail(error)
                }
            }
        }
    }

    private func enqueueDecision(_ decision: PendingDecision) {
        let key = pendingKey(decision)
        guard !resolvedPendingActions.contains(key),
              !decisionQueue.contains(where: { pendingKey($0) == key }) else { return }
        decisionQueue.append(decision)
        presentNextDecision()
    }

    private func presentNextDecision() {
        guard decisionInFlight == nil else { pendingDecision = nil; return }
        pendingDecision = decisionQueue.first
    }

    private func pendingKey(_ decision: PendingDecision) -> PendingActionKey {
        PendingActionKey(runID: decision.runID, id: decision.id)
    }

    private func canonicalOrigin(from rawURL: String) -> URL? {
        try? ConnectionValidator.validate(url: rawURL, token: String(repeating: "x", count: 24)).baseURL
    }

    private func tokenAccount(for origin: URL) -> String {
        "gateway-token:\(origin.absoluteString)"
    }

    private var trackedRunID: String? {
        currentRunID ?? connectedURL.flatMap(storedActiveRunID)
    }

    private func currentConnectionContext() -> StoreConnectionContext? {
        guard let client, let origin = connectedURL else { return nil }
        return StoreConnectionContext(client: client, generation: connectionGeneration, origin: origin)
    }

    private func isCurrentConnection(_ context: StoreConnectionContext) -> Bool {
        connectionGeneration == context.generation && connectedURL == context.origin && client != nil && !Task.isCancelled
    }

    private func requireCurrentConnection(_ context: StoreConnectionContext) throws {
        guard isCurrentConnection(context) else { throw CancellationError() }
    }

    private func isCurrentConnection(_ generation: Int) -> Bool {
        connectionGeneration == generation && client != nil && !Task.isCancelled
    }

    private func requireCurrentConnection(_ generation: Int) throws {
        guard isCurrentConnection(generation) else { throw CancellationError() }
    }

    private func isCurrentRun(_ generation: Int, context: StoreConnectionContext) -> Bool {
        runTaskGeneration == generation && isCurrentConnection(context)
    }

    private func activeRunKey(for origin: URL) -> String {
        Self.activeRunPrefix + origin.absoluteString
    }

    private func storedActiveRunID(for origin: URL) -> String? {
        defaults.string(forKey: activeRunKey(for: origin))
    }

    private func persistActiveRun(_ runID: String, origin: URL? = nil) {
        guard let origin = origin ?? connectedURL else { return }
        defaults.set(runID, forKey: activeRunKey(for: origin))
    }

    private func clearPersistedActiveRun(for origin: URL? = nil) {
        guard let origin = origin ?? connectedURL else { return }
        defaults.removeObject(forKey: activeRunKey(for: origin))
    }

    private func migrateLegacyActiveRun(from origin: URL?) {
        guard let origin, let runID = defaults.string(forKey: Self.legacyActiveRunKey) else { return }
        let scopedKey = activeRunKey(for: origin)
        if defaults.string(forKey: scopedKey) == nil { defaults.set(runID, forKey: scopedKey) }
        defaults.removeObject(forKey: Self.legacyActiveRunKey)
    }

    private func clearPendingActions(for runID: String?) {
        guard let runID else {
            pendingDecision = nil
            decisionQueue.removeAll()
            decisionInFlight = nil
            automaticActionTasks.values.forEach { $0.cancel() }
            automaticActionTasks.removeAll()
            resolvedPendingActions.removeAll()
            return
        }
        pendingDecision = pendingDecision?.runID == runID ? nil : pendingDecision
        decisionQueue.removeAll { $0.runID == runID }
        if decisionInFlight?.runID == runID { decisionInFlight = nil }
        for (key, task) in automaticActionTasks where key.runID == runID { task.cancel() }
        automaticActionTasks = automaticActionTasks.filter { $0.key.runID != runID }
        resolvedPendingActions = resolvedPendingActions.filter { $0.runID != runID }
    }

    private func reconcileAfterFailedCancel(runID: String, context: StoreConnectionContext) async {
        guard isCurrentConnection(context) else { return }
        do {
            let snapshot = try await context.client.runStatus(runID: runID)
            try requireCurrentConnection(context)
            clearPendingRunRequest(runID: runID, for: context.origin)
            if pendingRunRecovery?.runID == runID { pendingRunRecovery = nil }
            if snapshot.isTerminal {
                if let bot = state.bots.first(where: { $0.sessionId == snapshot.threadId }) {
                    await finishRun(botID: bot.id, context: context, terminalStatus: snapshot.status, terminalError: snapshot.error)
                } else {
                    clearPersistedActiveRun(for: context.origin)
                    currentRunID = nil
                    isRunning = false
                    eventCursor.clear(runID: runID)
                    clearPendingActions(for: runID)
                    presentTerminalStatus(snapshot.status, error: snapshot.error)
                }
            } else {
                currentRunID = runID
                persistActiveRun(runID, origin: context.origin)
                isRunning = true
                adoptPending(from: snapshot, context: context)
            }
        } catch GatewayClientError.http(404, _) {
            guard isCurrentConnection(context) else { return }
            clearPersistedActiveRun(for: context.origin)
            currentRunID = nil
            isRunning = false
            eventCursor.clear(runID: runID)
            clearPendingActions(for: runID)
            pendingRunRecovery = nil
            notice = "The host no longer has this run."
        } catch {
            guard isCurrentConnection(context) else { return }
            currentRunID = runID
            persistActiveRun(runID, origin: context.origin)
            isRunning = true
        }
    }

    private func fail(_ error: Error) {
        let value = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        errorMessage = String(value.prefix(1_000)); sounds.play(.error)
        if GatewayFallbackPolicy.isUnavailable(error) {
            gatewayUnavailable = true
            if cloud.hasAutomaticFallback, connectedURL != nil { openDirectChat() }
        }
    }
}
