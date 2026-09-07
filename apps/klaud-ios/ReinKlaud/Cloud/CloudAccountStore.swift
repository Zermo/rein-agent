import Combine
import Foundation

@MainActor
final class CloudAccountStore: ObservableObject {
    @Published private(set) var accounts: [CloudAccount]
    @Published private(set) var selectedID: UUID?
    @Published private(set) var allowAutomaticFallback: Bool

    private let defaults: UserDefaults
    private let secrets: SecretStore
    private static let accountsKey = "rein-klaud:cloud-accounts:v1"
    private static let selectedKey = "rein-klaud:cloud-selected:v1"
    private static let automaticFallbackKey = "rein-klaud:cloud-automatic-fallback:v1"

    init(defaults: UserDefaults = .standard, secrets: SecretStore = KeychainStore()) {
        self.defaults = defaults
        self.secrets = secrets

        let decoded = defaults.data(forKey: Self.accountsKey)
            .flatMap { try? JSONDecoder().decode([CloudAccount].self, from: $0) } ?? []
        var seen: Set<UUID> = []
        let loadedAccounts: [CloudAccount] = decoded.compactMap { account -> CloudAccount? in
            guard seen.insert(account.id).inserted else { return nil }
            return try? account.validated()
        }
        let loadedSelectedID: UUID?
        if let raw = defaults.string(forKey: Self.selectedKey),
           let id = UUID(uuidString: raw), loadedAccounts.contains(where: { $0.id == id }) {
            loadedSelectedID = id
        } else {
            loadedSelectedID = nil
        }
        let loadedAutomaticFallback = defaults.object(forKey: Self.automaticFallbackKey) as? Bool ?? false
        self.accounts = loadedAccounts
        self.selectedID = loadedSelectedID
        self.allowAutomaticFallback = loadedAutomaticFallback
        if defaults.object(forKey: Self.automaticFallbackKey) == nil {
            defaults.set(false, forKey: Self.automaticFallbackKey)
        }
    }

    var selectedAccount: CloudAccount? {
        guard let selectedID else { return nil }
        return accounts.first { $0.id == selectedID }
    }

    /// A nil key preserves the existing key only while provider and canonical endpoint stay unchanged.
    /// An empty key deletes it. Changing endpoint or provider never copies the previous secret.
    func save(_ account: CloudAccount, apiKey: String?) throws {
        let clean = try account.validated()
        let previous = accounts.first { $0.id == clean.id }
        let scopeChanged = previous.map { $0.baseURL != clean.baseURL || $0.provider != clean.provider } ?? false
        let previousSecretAccount = previous.map(secretAccount)
        let nextSecretAccount = secretAccount(clean)

        let suppliedKey: String?
        if let apiKey {
            if apiKey.isEmpty { suppliedKey = "" }
            else {
                guard apiKey.utf8.count <= 4_096,
                      apiKey.unicodeScalars.allSatisfy({ $0.value >= 0x21 && $0.value <= 0x7e }) else {
                    throw CloudAccountValidationError.invalidAPIKey
                }
                suppliedKey = apiKey
            }
        } else {
            suppliedKey = nil
        }

        if let suppliedKey, !suppliedKey.isEmpty {
            try secrets.write(suppliedKey, account: nextSecretAccount)
        } else if suppliedKey == "" || scopeChanged || previous == nil {
            try secrets.delete(account: nextSecretAccount)
        }
        if scopeChanged, let previousSecretAccount, previousSecretAccount != nextSecretAccount {
            try secrets.delete(account: previousSecretAccount)
        }

        if let index = accounts.firstIndex(where: { $0.id == clean.id }) { accounts[index] = clean }
        else { accounts.append(clean) }
        persistAccounts()
        if selectedID == nil { select(clean.id) }
    }

    func remove(id: UUID) throws {
        guard let account = accounts.first(where: { $0.id == id }) else { return }
        try secrets.delete(account: secretAccount(account))
        accounts.removeAll { $0.id == id }
        persistAccounts()
        if selectedID == id { select(accounts.first?.id) }
    }

    func select(_ id: UUID?) {
        selectedID = id.flatMap { candidate in accounts.contains(where: { $0.id == candidate }) ? candidate : nil }
        if let selectedID { defaults.set(selectedID.uuidString.lowercased(), forKey: Self.selectedKey) }
        else { defaults.removeObject(forKey: Self.selectedKey) }
    }

    func setAutomaticFallback(_ enabled: Bool) {
        allowAutomaticFallback = enabled
        defaults.set(enabled, forKey: Self.automaticFallbackKey)
    }

    func apiKey(for account: CloudAccount) throws -> String? {
        let clean = try account.validated()
        guard accounts.contains(where: { $0.id == clean.id && $0.baseURL == clean.baseURL && $0.provider == clean.provider }) else { return nil }
        return try secrets.read(account: secretAccount(clean))
    }

    private func secretAccount(_ account: CloudAccount) -> String {
        "cloud-api-key:\(account.id.uuidString.lowercased()):\(account.baseURL.absoluteString)"
    }

    private func persistAccounts() {
        if let data = try? JSONEncoder().encode(accounts) { defaults.set(data, forKey: Self.accountsKey) }
    }
}
