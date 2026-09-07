import CryptoKit
import Foundation

struct BackupGateway: Codable, Identifiable, Equatable {
    let id: UUID
    let name: String
    let origin: URL
}

enum GatewayFallbackPolicy {
    static func isUnavailable(_ error: Error) -> Bool {
        if error is CancellationError { return false }
        if let error = error as? URLError {
            return [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost, .dnsLookupFailed, .notConnectedToInternet].contains(error.code)
        }
        if case GatewayClientError.http(let status, _) = error { return [502, 503, 504].contains(status) }
        return false
    }
}

@MainActor
final class CloudWorkspace: ObservableObject {
    enum Page: String, CaseIterable { case chat = "Chat", accounts = "Accounts" }
    let accounts: CloudAccountStore
    @Published var page: Page = .accounts
    @Published var draft = ""
    @Published private(set) var messages: [ReinMessage] = []
    @Published private(set) var routes: [String: String] = [:]
    @Published private(set) var isRunning = false
    @Published var errorMessage: String?
    @Published var status = "Direct chat is ready. Host tools remain on the host."
    @Published private(set) var backups: [BackupGateway] = []
    @Published var includeRecentMessages: Bool { didSet { defaults.set(includeRecentMessages, forKey: "rein.cloud.include-context") } }
    private let defaults: UserDefaults
    private let secrets: SecretStore
    private let modelClient: DirectModelClientProtocol
    private let transcriptDirectory: URL
    private var contextKey = "direct"
    private var sourceKey = "direct"
    private var preparedContextKey: String?
    private var transcriptBlocked = false
    private var task: Task<Void, Never>?
    private var generation = 0
    private static let directThreadKey = "rein.cloud.direct-thread"
    private static let scopedThreadPrefix = "rein.cloud.direct-thread:v2:"

    init(defaults: UserDefaults = .standard, secrets: SecretStore = KeychainStore(), modelClient: DirectModelClientProtocol = DirectModelClient(), transcriptDirectory: URL? = nil) {
        self.defaults = defaults; self.secrets = secrets; self.modelClient = modelClient
        accounts = CloudAccountStore(defaults: defaults, secrets: secrets)
        includeRecentMessages = defaults.bool(forKey: "rein.cloud.include-context")
        self.transcriptDirectory = transcriptDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "DirectConversations")
        sourceKey = defaults.string(forKey: Self.directThreadKey) ?? "direct"
        if let data = defaults.data(forKey: "rein.cloud.backup-gateways"), let saved = try? JSONDecoder().decode([BackupGateway].self, from: data) {
            backups = Array(saved.prefix(8)).filter { (try? ConnectionValidator.validate(url: $0.origin.absoluteString, token: String(repeating: "x", count: 24))) != nil }
        }
        preparedContextKey = contextKey
        restoreCurrentTranscript()
    }

    var hasAutomaticFallback: Bool { accounts.allowAutomaticFallback && (!accounts.accounts.isEmpty || !backups.isEmpty) }

    func saveBackup(name: String, rawURL: String, token: String) throws {
        let connection = try ConnectionValidator.validate(url: rawURL, token: token)
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, backups.count < 8 || backups.contains(where: { $0.origin == connection.baseURL }) else { throw DirectModelError.invalidAccount }
        try secrets.write(connection.token, account: "backup-gateway:\(connection.baseURL.absoluteString)")
        if let index = backups.firstIndex(where: { $0.origin == connection.baseURL }) {
            backups[index] = .init(id: backups[index].id, name: String(name.prefix(64)), origin: connection.baseURL)
        } else { backups.append(.init(id: UUID(), name: String(name.prefix(64)), origin: connection.baseURL)) }
        defaults.set(try JSONEncoder().encode(backups), forKey: "rein.cloud.backup-gateways")
    }

    func removeBackup(_ backup: BackupGateway) throws {
        try secrets.delete(account: "backup-gateway:\(backup.origin.absoluteString)")
        backups.removeAll { $0.id == backup.id }
        defaults.set(try JSONEncoder().encode(backups), forKey: "rein.cloud.backup-gateways")
    }

    func connection(for backup: BackupGateway) throws -> GatewayConnection {
        try ConnectionValidator.validate(url: backup.origin.absoluteString, token: secrets.read(account: "backup-gateway:\(backup.origin.absoluteString)") ?? "")
    }

    func prepareContext(origin: URL?, botID: String?, recent: [ReinMessage]) {
        guard !isRunning else { return }
        let nextContextKey = origin.map { $0.absoluteString + ":" + (botID ?? "") } ?? "direct"
        let nextSourceKey = activeSourceKey(for: nextContextKey)
        if nextContextKey != preparedContextKey || nextSourceKey != sourceKey {
            contextKey = nextContextKey
            sourceKey = nextSourceKey
            preparedContextKey = nextContextKey
            restoreCurrentTranscript()
        }
        guard !transcriptBlocked else { return }
        if messages.isEmpty, sourceKey == contextKey, includeRecentMessages {
            messages = recent.filter {
                $0.role != .tool && ($0.toolCalls ?? []).isEmpty && !$0.id.hasPrefix("pending-user-") &&
                    !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
                .suffix(20).map { .init(id: UUID().uuidString, role: $0.role, content: String($0.content.prefix(8_000))) }
        }
    }

    func newConversation() {
        stop(); sourceKey = "direct-\(UUID().uuidString)"; preparedContextKey = contextKey; saveActiveSourceKey(); transcriptBlocked = false; messages = []; routes = [:]; draft = ""; errorMessage = nil
        status = "New direct conversation. No host transcript is included."
    }

    @discardableResult
    func send(_ text: String, sounds: ReinSoundEngine? = nil) -> Bool {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcriptBlocked, !isRunning, !clean.isEmpty, let selected = accounts.selectedAccount else { return false }
        let candidates = [selected] + (accounts.allowAutomaticFallback ? accounts.accounts.filter { $0.id != selected.id } : [])
        let user = ReinMessage(id: UUID().uuidString, role: .user, content: clean)
        let oldMessages = messages
        messages.append(user)
        do { try persist() } catch { messages = oldMessages; errorMessage = "The private conversation could not be saved. Your message was not sent."; return false }
        let context = [DirectChatMessage(role: .system, content: "You are Rein in direct conversation mode. You have no host tools, filesystem access, command execution, or background autonomy in this connection. Do not claim to execute actions. Give useful text assistance and clearly identify actions the user must run themselves.")] + messages.map {
            DirectChatMessage(role: $0.role == .user ? .user : .assistant, content: $0.content)
        }
        isRunning = true; errorMessage = nil; generation &+= 1
        let current = generation
        sounds?.play(.send)
        task = Task { [weak self] in
            guard let self else { return }
            for (index, account) in candidates.enumerated() {
                guard !Task.isCancelled, self.generation == current else { return }
                guard self.accounts.accounts.contains(account), index == 0 || self.accounts.allowAutomaticFallback else {
                    self.isRunning = false; self.task = nil
                    self.status = "Account settings changed. No request was sent to the next account."
                    return
                }
                self.status = "Using \(account.name) · \(account.model)"
                do {
                    let key = try self.accounts.apiKey(for: account)
                    let result = try await self.modelClient.complete(account: account, apiKey: key, messages: context)
                    try Task.checkCancellation()
                    guard self.generation == current else { return }
                    let reason = result.finishReason == "end_turn" ? "stop" : result.finishReason == "max_tokens" ? "length" : result.finishReason
                    let reply = ReinMessage(id: UUID().uuidString, role: .assistant, content: result.text, completion: .init(stopReason: reason, reasoningTokens: nil))
                    self.messages.append(reply); self.routes[reply.id] = "\(account.name) / \(account.model)"
                    self.isRunning = false; self.status = "Reply from \(account.name). Host tasks are tracked separately."
                    do { try self.persist() } catch { self.errorMessage = "The reply is visible but could not be saved. Keep this conversation open to copy it." }
                    sounds?.play(.reply); self.task = nil; return
                } catch is CancellationError {
                    if self.generation == current { self.isRunning = false; self.task = nil; self.status = "Direct request cancelled. No fallback account was contacted." }
                    return
                }
                catch {
                    guard self.generation == current else { return }
                    if let error = error as? DirectModelError, error.isEligibleForAutomaticFallback, index + 1 < candidates.count { continue }
                    self.errorMessage = error.localizedDescription; self.isRunning = false; self.task = nil
                    self.status = "No reply received. The message was saved; no host task was replayed."
                    sounds?.play(.error); return
                }
            }
        }
        return true
    }

    func stop() { generation &+= 1; task?.cancel(); task = nil; isRunning = false; status = "Direct request cancelled. Any host task is still tracked separately." }

    private struct Transcript: Codable { let messages: [ReinMessage]; let routes: [String: String] }
    private func activeSourceKey(for contextKey: String) -> String {
        if contextKey == "direct" { return defaults.string(forKey: Self.directThreadKey) ?? "direct" }
        return defaults.string(forKey: scopedThreadPreferenceKey(for: contextKey)) ?? contextKey
    }
    private func saveActiveSourceKey() {
        let key = contextKey == "direct" ? Self.directThreadKey : scopedThreadPreferenceKey(for: contextKey)
        defaults.set(sourceKey, forKey: key)
    }
    private func scopedThreadPreferenceKey(for contextKey: String) -> String {
        Self.scopedThreadPrefix + Self.digest(contextKey)
    }
    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private var transcriptURL: URL {
        transcriptDirectory.appending(path: Self.digest(sourceKey) + ".json")
    }
    private func readTranscript() throws -> Transcript? {
        guard FileManager.default.fileExists(atPath: transcriptURL.path) else { return nil }
        let data = try Data(contentsOf: transcriptURL)
        guard data.count <= 2 * 1024 * 1024 else { throw DirectModelError.invalidRequest }
        return try JSONDecoder().decode(Transcript.self, from: data)
    }
    private func restoreCurrentTranscript() {
        messages = []
        routes = [:]
        transcriptBlocked = false
        errorMessage = nil
        do {
            if let saved = try readTranscript() {
                messages = saved.messages.filter { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                let messageIDs = Set(messages.map(\.id))
                routes = saved.routes.filter { messageIDs.contains($0.key) }
            }
        } catch {
            transcriptBlocked = true
            errorMessage = "The saved direct conversation could not be opened. Start a new conversation to continue."
        }
    }
    private func persist() throws {
        try FileManager.default.createDirectory(at: transcriptDirectory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var directory = transcriptDirectory
        var values = URLResourceValues(); values.isExcludedFromBackup = true; try directory.setResourceValues(values)
        let retained = Array(messages.suffix(100))
        let ids = Set(retained.map(\.id))
        let data = try JSONEncoder().encode(Transcript(messages: retained, routes: routes.filter { ids.contains($0.key) }))
        guard data.count <= 2 * 1024 * 1024 else { throw DirectModelError.invalidRequest }
        try data.write(to: transcriptURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
