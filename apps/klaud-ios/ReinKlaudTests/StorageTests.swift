import XCTest
@testable import ReinKlaud

final class StorageTests: XCTestCase {
    func testSecretStoreAbstractionRoundTrip() throws {
        let store = MemorySecretStore()
        XCTAssertNil(try store.read(account: "gateway"))
        try store.write("secret", account: "gateway")
        XCTAssertEqual(try store.read(account: "gateway"), "secret")
        try store.delete(account: "gateway")
        XCTAssertNil(try store.read(account: "gateway"))
    }

    func testSoundPreferenceDefaultsOnAndPersistsOff() {
        let suite = "ReinKlaudTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let preference = DefaultsSoundPreferenceStore(defaults: defaults)
        XCTAssertTrue(preference.enabled())
        preference.setEnabled(false)
        XCTAssertFalse(preference.enabled())
        preference.setEnabled(true)
        XCTAssertTrue(preference.enabled())
    }

    @MainActor
    func testRunCursorSkipsHandledTextAndFrontendToolOnReattach() throws {
        let suite = "ReinKlaudCursorTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let cursor = RunEventCursor(defaults: defaults)
        let runID = "77777777-7777-4777-8777-777777777777"
        let text = try JSONDecoder().decode(GatewayEvent.self, from: Data(#"{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"already rendered"}"#.utf8))
        let tool = try JSONDecoder().decode(GatewayEvent.self, from: Data(#"{"type":"CUSTOM","name":"klaud.frontend_tool","value":{"runId":"77777777-7777-4777-8777-777777777777","toolCallId":"c1","toolName":"navigateTo","args":{"dest":"chat"}}}"#.utf8))

        cursor.markHandled(runID: runID, sequence: 2)
        for item in [RunStreamEvent(runID: runID, sequence: 1, event: text), RunStreamEvent(runID: runID, sequence: 2, event: tool)] {
            XCTAssertFalse(cursor.shouldHandle(runID: item.runID, sequence: item.sequence))
        }
        XCTAssertTrue(cursor.shouldHandle(runID: runID, sequence: 3))
        cursor.markHandled(runID: runID, sequence: 1)
        XCTAssertEqual(cursor.lastHandled(runID: runID), 2)
        cursor.clear(runID: runID)
        XCTAssertEqual(cursor.lastHandled(runID: runID), 0)
    }

    @MainActor
    func testProtectedPendingRequestStoreScopesExpiresAndConditionallyDeletes() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ReinPendingStore-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ProtectedPendingRunRequestStore(directory: directory)
        let originA = try XCTUnwrap(URL(string: "http://192.168.50.12:4318"))
        let originB = try XCTUnwrap(URL(string: "https://rein-host.example"))
        let runID = "12345678-1234-4234-8234-123456789abc"
        let request = RunRequest(runId: runID, threadId: "thread-1", botId: "bot-1", message: "Protected operator request", tools: ReinGatewayClient.frontendTools)
        let savedAt = Date(timeIntervalSince1970: 1_800_000_000)

        try store.save(request, for: originA, now: savedAt)

        guard case .pending(let loaded) = try store.load(for: originA, now: savedAt) else { return XCTFail("Expected the protected request.") }
        XCTAssertEqual(loaded, request)
        guard case .none = try store.load(for: originB, now: savedAt) else { return XCTFail("A request crossed gateway origins.") }
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isExcludedFromBackupKey]).first)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        let protection = (attributes[.protectionKey] as? FileProtectionType)?.rawValue
            ?? (attributes[.protectionKey] as? String)
        if let protection { XCTAssertEqual(protection, FileProtectionType.complete.rawValue) }
#if !targetEnvironment(simulator)
        XCTAssertNotNil(protection)
#endif
        XCTAssertEqual(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)

        try store.remove(runID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", for: originA)
        guard case .pending = try store.load(for: originA, now: savedAt) else { return XCTFail("A late response deleted a different run.") }
        guard case .expired(let expiredID) = try store.load(for: originA, now: savedAt.addingTimeInterval(24 * 60 * 60 + 1)) else { return XCTFail("Expected an expired request.") }
        XCTAssertEqual(expiredID, runID)
        guard case .none = try store.load(for: originA, now: savedAt.addingTimeInterval(24 * 60 * 60 + 1)) else { return XCTFail("Expired request was retained.") }
    }

    @MainActor
    func testCapacityCleanupPreservesRecordWhenProtectedFileCannotBeRead() throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory.appendingPathComponent("ReinPendingUnreadable-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: directory) }
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let inaccessible = directory.appendingPathComponent("temporarily-inaccessible.json")
        let missingTarget = directory.appendingPathComponent("locked-until-first-unlock")
        try fileManager.createSymbolicLink(at: inaccessible, withDestinationURL: missingTarget)
        let store = ProtectedPendingRunRequestStore(directory: directory)
        let origin = try XCTUnwrap(URL(string: "https://rein-host.example"))
        let request = RunRequest(runId: "12345678-1234-4234-8234-123456789abc", threadId: "thread-1", botId: "bot-1", message: "Do not erase another protected record.", tools: [])

        XCTAssertThrowsError(try store.save(request, for: origin, now: Date()))
        XCTAssertEqual(try fileManager.destinationOfSymbolicLink(atPath: inaccessible.path), missingTarget.path)
    }
}

private final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private var values: [String: String] = [:]
    func read(account: String) throws -> String? { values[account] }
    func write(_ value: String, account: String) throws { values[account] = value }
    func delete(account: String) throws { values.removeValue(forKey: account) }
}
