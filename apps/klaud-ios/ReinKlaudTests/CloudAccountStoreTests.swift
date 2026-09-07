import XCTest
@testable import ReinKlaud

final class CloudAccountStoreTests: XCTestCase {
    func testProviderPresetsAndEndpointNormalization() throws {
        XCTAssertEqual(CloudProvider.openai.defaultBaseURL?.absoluteString, "https://api.openai.com/v1")
        XCTAssertEqual(CloudProvider.anthropic.defaultBaseURL?.absoluteString, "https://api.anthropic.com/v1")
        XCTAssertEqual(CloudProvider.gemini.defaultBaseURL?.absoluteString, "https://generativelanguage.googleapis.com/v1beta/openai")
        XCTAssertEqual(CloudProvider.xai.defaultBaseURL?.absoluteString, "https://api.x.ai/v1")
        XCTAssertEqual(CloudProvider.openrouter.defaultBaseURL?.absoluteString, "https://openrouter.ai/api/v1")
        XCTAssertNil(CloudProvider.custom.defaultBaseURL)

        XCTAssertEqual(
            try CloudAccount.normalizedEndpoint("https://MODEL.EXAMPLE/custom/v1/chat/completions/", provider: .custom).absoluteString,
            "https://model.example/custom/v1"
        )
        XCTAssertEqual(
            try CloudAccount.normalizedEndpoint("http://192.168.50.12:1234/v1/chat/completions", provider: .custom).absoluteString,
            "http://192.168.50.12:1234/v1"
        )
        XCTAssertEqual(
            try CloudAccount.normalizedEndpoint("https://api.openai.com", provider: .openai).absoluteString,
            "https://api.openai.com/v1"
        )
        XCTAssertEqual(
            try CloudAccount.normalizedEndpoint("https://openrouter.ai/api", provider: .openrouter).absoluteString,
            "https://openrouter.ai/api/v1"
        )
        XCTAssertEqual(
            try CloudAccount.normalizedEndpoint("https://generativelanguage.googleapis.com/v1beta", provider: .gemini).absoluteString,
            "https://generativelanguage.googleapis.com/v1beta/openai"
        )
        XCTAssertEqual(
            try CloudAccount.normalizedEndpoint("https://gateway.example/provider/v1/models", provider: .openai).absoluteString,
            "https://gateway.example/provider/v1"
        )
        XCTAssertThrowsError(try CloudAccount.normalizedEndpoint("http://api.example.com/v1", provider: .custom))
        XCTAssertThrowsError(try CloudAccount.normalizedEndpoint("https://user:secret@example.com/v1", provider: .custom))
        XCTAssertThrowsError(try CloudAccount.normalizedEndpoint("https://example.com/v1?key=secret", provider: .custom))
        XCTAssertThrowsError(try CloudAccount.normalizedEndpoint("https://example.com/v1#fragment", provider: .custom))
        XCTAssertThrowsError(try CloudAccount.normalizedEndpoint("https://example.com/\u{0007}v1", provider: .custom))
    }

    @MainActor
    func testMetadataSelectionFallbackAndKeyPersistSeparately() throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let secrets = CloudTestSecretStore()
        let account = try CloudAccount(name: "Primary", provider: .openai, model: "gpt-example")
        let apiKey = "sk-test-private-key-1234567890"
        let store = CloudAccountStore(defaults: defaults, secrets: secrets)

        XCTAssertFalse(store.allowAutomaticFallback)
        XCTAssertEqual(defaults.object(forKey: "rein-klaud:cloud-automatic-fallback:v1") as? Bool, false)
        try store.save(account, apiKey: apiKey)
        store.select(account.id)
        store.setAutomaticFallback(true)

        XCTAssertEqual(store.selectedAccount, account)
        XCTAssertEqual(try store.apiKey(for: account), apiKey)
        assertDefaults(defaults, doNotContain: apiKey)

        let restored = CloudAccountStore(defaults: defaults, secrets: secrets)
        XCTAssertEqual(restored.accounts, [account])
        XCTAssertEqual(restored.selectedID, account.id)
        XCTAssertTrue(restored.allowAutomaticFallback)
        XCTAssertEqual(try restored.apiKey(for: account), apiKey)
    }

    @MainActor
    func testEndpointChangeNeverCarriesOldSecret() throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let secrets = CloudTestSecretStore()
        let id = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
        let original = try CloudAccount(id: id, name: "Local A", provider: .custom, baseURL: URL(string: "http://10.1.2.3:8080/v1")!, model: "model-a")
        let renamed = try CloudAccount(id: id, name: "Renamed", provider: .custom, baseURL: original.baseURL, model: "model-b")
        let changed = try CloudAccount(id: id, name: "Local B", provider: .custom, baseURL: URL(string: "http://10.1.2.4:8080/v1")!, model: "model-b")
        let store = CloudAccountStore(defaults: defaults, secrets: secrets)

        try store.save(original, apiKey: "local-key-123456789012345")
        try store.save(renamed, apiKey: nil)
        XCTAssertEqual(try store.apiKey(for: renamed), "local-key-123456789012345")

        try store.save(changed, apiKey: nil)
        XCTAssertNil(try store.apiKey(for: changed))
        XCTAssertTrue(secrets.values.isEmpty)

        try store.save(changed, apiKey: "replacement-key-1234567890")
        XCTAssertEqual(try store.apiKey(for: changed), "replacement-key-1234567890")
        try store.save(changed, apiKey: "")
        XCTAssertNil(try store.apiKey(for: changed))
    }

    @MainActor
    func testNewAccountWithoutKeyDoesNotAdoptOrphanedSecret() throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let secrets = CloudTestSecretStore()
        let id = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
        let account = try CloudAccount(id: id, name: "Local", provider: .custom, baseURL: URL(string: "http://127.0.0.1:8080/v1")!, model: "model")
        let scopedKey = "cloud-api-key:\(id.uuidString.lowercased()):\(account.baseURL.absoluteString)"
        try secrets.write("orphaned-private-key-123456789", account: scopedKey)
        let store = CloudAccountStore(defaults: defaults, secrets: secrets)

        try store.save(account, apiKey: nil)

        XCTAssertNil(try store.apiKey(for: account))
        XCTAssertTrue(secrets.values.isEmpty)
    }

    @MainActor
    func testRemoveDeletesOnlyThatAccountsScopedSecret() throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let secrets = CloudTestSecretStore()
        let first = try CloudAccount(name: "First", provider: .openai, model: "gpt-one")
        let second = try CloudAccount(name: "Second", provider: .openai, model: "gpt-two")
        let store = CloudAccountStore(defaults: defaults, secrets: secrets)
        try store.save(first, apiKey: "first-private-key-123456789")
        try store.save(second, apiKey: "second-private-key-12345678")
        store.select(first.id)

        try store.remove(id: first.id)

        XCTAssertEqual(store.accounts, [second])
        XCTAssertEqual(store.selectedID, second.id)
        XCTAssertNil(try store.apiKey(for: first))
        XCTAssertEqual(try store.apiKey(for: second), "second-private-key-12345678")
    }

    private func makeDefaults() -> (UserDefaults, String) {
        let suite = "CloudAccountStoreTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return (defaults, suite)
    }

    private func assertDefaults(_ defaults: UserDefaults, doNotContain secret: String, file: StaticString = #filePath, line: UInt = #line) {
        for value in defaults.dictionaryRepresentation().values {
            if let text = value as? String { XCTAssertFalse(text.contains(secret), file: file, line: line) }
            if let data = value as? Data, let text = String(data: data, encoding: .utf8) { XCTAssertFalse(text.contains(secret), file: file, line: line) }
        }
    }
}

private final class CloudTestSecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: String] = [:]
    var values: [String: String] { lock.withLock { storage } }
    func read(account: String) throws -> String? { lock.withLock { storage[account] } }
    func write(_ value: String, account: String) throws { lock.withLock { storage[account] = value } }
    func delete(account: String) throws { _ = lock.withLock { storage.removeValue(forKey: account) } }
}
