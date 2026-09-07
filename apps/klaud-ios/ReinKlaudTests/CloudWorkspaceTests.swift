import XCTest
@testable import ReinKlaud

final class CloudWorkspaceTests: XCTestCase {
    func testGatewayFallbackClassifiesAvailabilityWithoutTreatingAuthOrCancellationAsOutage() {
        XCTAssertTrue(GatewayFallbackPolicy.isUnavailable(URLError(.cannotConnectToHost)))
        XCTAssertTrue(GatewayFallbackPolicy.isUnavailable(GatewayClientError.http(503, "unavailable")))
        XCTAssertFalse(GatewayFallbackPolicy.isUnavailable(GatewayClientError.http(401, "unauthorized")))
        XCTAssertFalse(GatewayFallbackPolicy.isUnavailable(GatewayClientError.http(404, "not found")))
        XCTAssertFalse(GatewayFallbackPolicy.isUnavailable(URLError(.serverCertificateUntrusted)))
        XCTAssertFalse(GatewayFallbackPolicy.isUnavailable(CancellationError()))
    }

    @MainActor
    func testContextSharingDefaultsOffAndNeverIncludesToolsOrPendingInputs() throws {
        let fixture = try WorkspaceFixture(); defer { fixture.clean() }
        let workspace = fixture.workspace
        let recent: [ReinMessage] = [
            .init(id: "operator", role: .user, content: "Plan the next step"),
            .init(id: "reply", role: .assistant, content: "A short plan"),
            .init(id: "empty-reply", role: .assistant, content: " \n "),
            .init(id: "tool", role: .tool, content: "private file contents"),
            .init(id: "pending-user-x", role: .user, content: "unconfirmed task"),
            .init(id: "call", role: .assistant, content: "Running", toolCalls: [.init(id: "call", function: .init(name: "read", arguments: "{}"))])
        ]
        let origin = URL(string: "http://192.168.10.20:4318")!
        workspace.prepareContext(origin: origin, botID: "unit", recent: recent)
        XCTAssertTrue(workspace.messages.isEmpty)
        workspace.includeRecentMessages = true
        workspace.prepareContext(origin: origin, botID: "unit", recent: recent)
        XCTAssertEqual(workspace.messages.map(\.content), ["Plan the next step", "A short plan"])
        workspace.prepareContext(origin: URL(string: "http://192.168.10.21:4318")!, botID: "unit", recent: [])
        XCTAssertTrue(workspace.messages.isEmpty)
    }

    @MainActor
    func testEligibleServiceFailureUsesNextSavedAccountAndPersistsReplyWithoutKeys() async throws {
        let model = WorkspaceModelStub(errors: [.serviceUnavailable])
        let fixture = try WorkspaceFixture(client: model); defer { fixture.clean() }
        let accounts = try fixture.addAccounts()
        fixture.workspace.accounts.setAutomaticFallback(true)
        XCTAssertTrue(fixture.workspace.send("Help me plan dinner"))
        await settle(fixture.workspace)
        let attempts = await model.attempts
        XCTAssertEqual(attempts, accounts.map(\.id))
        XCTAssertEqual(fixture.workspace.messages.map(\.role), [.user, .assistant])
        XCTAssertEqual(fixture.workspace.routes.values.first, "Reserve / sample-model")
        let files = try FileManager.default.contentsOfDirectory(at: fixture.directory, includingPropertiesForKeys: nil)
        let persisted = try String(contentsOf: XCTUnwrap(files.first), encoding: .utf8)
        XCTAssertTrue(persisted.contains("Useful reply"))
        XCTAssertFalse(persisted.contains("fixture-key"))
        let restored = CloudWorkspace(defaults: fixture.defaults, secrets: fixture.secrets, modelClient: model, transcriptDirectory: fixture.directory)
        XCTAssertEqual(restored.messages, fixture.workspace.messages)
    }

    @MainActor
    func testRelaunchRestoresDirectTranscriptBeforeTheNextSend() async throws {
        let firstModel = WorkspaceModelStub()
        let fixture = try WorkspaceFixture(client: firstModel); defer { fixture.clean() }
        _ = try fixture.addAccounts()
        XCTAssertTrue(fixture.workspace.send("First question"))
        await settle(fixture.workspace)

        let secondModel = WorkspaceModelStub()
        let restored = CloudWorkspace(defaults: fixture.defaults, secrets: fixture.secrets, modelClient: secondModel, transcriptDirectory: fixture.directory)
        XCTAssertEqual(restored.messages.map(\.content), ["First question", "Useful reply"])

        XCTAssertTrue(restored.send("Follow-up question"))
        await settle(restored)

        XCTAssertEqual(restored.messages.map(\.content), ["First question", "Useful reply", "Follow-up question", "Useful reply"])
        let requests = await secondModel.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].filter { $0.role != .system }.map(\.content), ["First question", "Useful reply", "Follow-up question"])
    }

    @MainActor
    func testConnectedNewConversationSurvivesReopenRelaunchAndOtherBots() async throws {
        let model = WorkspaceModelStub()
        let fixture = try WorkspaceFixture(client: model); defer { fixture.clean() }
        _ = try fixture.addAccounts()
        let origin = URL(string: "http://192.168.10.60:4318")!
        fixture.workspace.includeRecentMessages = true
        fixture.workspace.prepareContext(origin: origin, botID: "bot-a", recent: [])
        XCTAssertTrue(fixture.workspace.send("Old thread"))
        await settle(fixture.workspace)

        fixture.workspace.newConversation()
        fixture.workspace.prepareContext(
            origin: origin,
            botID: "bot-a",
            recent: [.init(id: "old-host-row", role: .user, content: "Do not import this")]
        )
        XCTAssertTrue(fixture.workspace.messages.isEmpty)
        XCTAssertTrue(fixture.workspace.send("Fresh thread"))
        await settle(fixture.workspace)

        let restored = CloudWorkspace(defaults: fixture.defaults, secrets: fixture.secrets, modelClient: WorkspaceModelStub(), transcriptDirectory: fixture.directory)
        restored.prepareContext(origin: origin, botID: "bot-a", recent: [])
        XCTAssertEqual(restored.messages.map(\.content), ["Fresh thread", "Useful reply"])
        restored.prepareContext(origin: origin, botID: "bot-b", recent: [])
        XCTAssertTrue(restored.messages.isEmpty)
        restored.prepareContext(origin: origin, botID: "bot-a", recent: [])
        XCTAssertEqual(restored.messages.map(\.content), ["Fresh thread", "Useful reply"])
    }

    @MainActor
    func testAuthenticationFailureDoesNotBurnAnotherAccount() async throws {
        let model = WorkspaceModelStub(errors: [.authentication])
        let fixture = try WorkspaceFixture(client: model); defer { fixture.clean() }
        let accounts = try fixture.addAccounts()
        fixture.workspace.accounts.setAutomaticFallback(true)
        XCTAssertTrue(fixture.workspace.send("A question"))
        await settle(fixture.workspace)
        let attempts = await model.attempts
        XCTAssertEqual(attempts, [accounts[0].id])
        XCTAssertNotNil(fixture.workspace.errorMessage)
        XCTAssertEqual(fixture.workspace.messages.count, 1)
    }

    @MainActor
    func testRemovedFallbackIsNeverContactedAfterAnInFlightFailure() async throws {
        let model = WorkspaceModelStub(errors: [.serviceUnavailable], suspend: true)
        let fixture = try WorkspaceFixture(client: model); defer { fixture.clean() }
        let accounts = try fixture.addAccounts()
        fixture.workspace.accounts.setAutomaticFallback(true)
        XCTAssertTrue(fixture.workspace.send("A question"))
        await model.waitForStart()
        try fixture.workspace.accounts.remove(id: accounts[1].id)
        await model.release()
        await settle(fixture.workspace)
        let attempts = await model.attempts
        XCTAssertEqual(attempts, [accounts[0].id])
    }

    @MainActor
    func testDisablingFallbackDuringARequestStopsTheNextAttempt() async throws {
        let model = WorkspaceModelStub(errors: [.rateLimited], suspend: true)
        let fixture = try WorkspaceFixture(client: model); defer { fixture.clean() }
        let accounts = try fixture.addAccounts()
        fixture.workspace.accounts.setAutomaticFallback(true)
        XCTAssertTrue(fixture.workspace.send("A question"))
        await model.waitForStart()
        fixture.workspace.accounts.setAutomaticFallback(false)
        await model.release()
        await settle(fixture.workspace)
        let attempts = await model.attempts
        XCTAssertEqual(attempts, [accounts[0].id])
    }

    @MainActor
    func testStopDiscardsLateReplyWithoutTryingAnotherAccount() async throws {
        let model = WorkspaceModelStub(suspend: true)
        let fixture = try WorkspaceFixture(client: model); defer { fixture.clean() }
        let accounts = try fixture.addAccounts()
        fixture.workspace.accounts.setAutomaticFallback(true)
        XCTAssertTrue(fixture.workspace.send("A question"))
        await model.waitForStart()
        fixture.workspace.stop()
        await model.release()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(fixture.workspace.messages.count, 1)
        let attempts = await model.attempts
        XCTAssertEqual(attempts, [accounts[0].id])
        XCTAssertFalse(fixture.workspace.isRunning)
    }

    @MainActor
    func testSaveFailurePreservesDraftAndDoesNotSend() async throws {
        let model = WorkspaceModelStub()
        let fixture = try WorkspaceFixture(client: model); defer { fixture.clean() }
        _ = try fixture.addAccounts()
        try Data("file blocks directory".utf8).write(to: fixture.directory)
        fixture.workspace.draft = "Keep my draft"
        XCTAssertFalse(fixture.workspace.send(fixture.workspace.draft))
        XCTAssertEqual(fixture.workspace.draft, "Keep my draft")
        XCTAssertTrue(fixture.workspace.messages.isEmpty)
        let attempts = await model.attempts
        XCTAssertTrue(attempts.isEmpty)
    }

    @MainActor
    func testBackupTokensAreScopedAndNeverStoredInPreferences() throws {
        let fixture = try WorkspaceFixture(); defer { fixture.clean() }
        let workspace = fixture.workspace
        try workspace.saveBackup(name: "Reserve", rawURL: "http://192.168.10.30:4318", token: "fixture-backup-token-12345678")
        let saved = try XCTUnwrap(workspace.backups.first)
        XCTAssertEqual(try workspace.connection(for: saved).token, "fixture-backup-token-12345678")
        let data = try XCTUnwrap(fixture.defaults.data(forKey: "rein.cloud.backup-gateways"))
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("fixture-backup-token"))
        let forged = BackupGateway(id: saved.id, name: saved.name, origin: URL(string: "http://192.168.10.31:4318")!)
        XCTAssertThrowsError(try workspace.connection(for: forged))
    }

    @MainActor
    private func settle(_ workspace: CloudWorkspace) async {
        for _ in 0..<200 { if !workspace.isRunning { return }; try? await Task.sleep(for: .milliseconds(5)) }
        XCTFail("Direct request did not settle")
    }
}

@MainActor
private final class WorkspaceFixture {
    let suite = "CloudWorkspaceTests-\(UUID().uuidString)"
    let defaults: UserDefaults
    let secrets = WorkspaceSecrets()
    let directory = FileManager.default.temporaryDirectory.appending(path: "rein-cloud-\(UUID().uuidString)")
    let workspace: CloudWorkspace
    init(client: DirectModelClientProtocol = WorkspaceModelStub()) throws {
        defaults = UserDefaults(suiteName: suite)!
        workspace = CloudWorkspace(defaults: defaults, secrets: secrets, modelClient: client, transcriptDirectory: directory)
    }
    func addAccounts() throws -> [CloudAccount] {
        let first = try CloudAccount(name: "Primary", provider: .openai, model: "sample-model")
        let second = try CloudAccount(name: "Reserve", provider: .custom, baseURL: URL(string: "http://192.168.10.50:1234/v1"), model: "sample-model")
        try workspace.accounts.save(first, apiKey: "fixture-key-primary")
        try workspace.accounts.save(second, apiKey: "fixture-key-reserve")
        workspace.accounts.select(first.id)
        return [first, second]
    }
    func clean() { workspace.stop(); defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
}

private final class WorkspaceSecrets: SecretStore, @unchecked Sendable {
    private var values: [String: String] = [:]
    func read(account: String) throws -> String? { values[account] }
    func write(_ value: String, account: String) throws { values[account] = value }
    func delete(account: String) throws { values.removeValue(forKey: account) }
}

private actor WorkspaceModelStub: DirectModelClientProtocol {
    private var errors: [DirectModelError]
    private var suspend: Bool
    private var waiter: CheckedContinuation<Void, Never>?
    private var started: [CheckedContinuation<Void, Never>] = []
    private(set) var attempts: [UUID] = []
    private(set) var requests: [[DirectChatMessage]] = []
    init(errors: [DirectModelError] = [], suspend: Bool = false) { self.errors = errors; self.suspend = suspend }
    func complete(account: CloudAccount, apiKey: String?, messages: [DirectChatMessage]) async throws -> DirectChatResult {
        attempts.append(account.id)
        requests.append(messages)
        started.forEach { $0.resume() }; started = []
        if suspend { await withCheckedContinuation { waiter = $0 }; suspend = false }
        if !errors.isEmpty { throw errors.removeFirst() }
        return .init(text: "Useful reply", finishReason: "stop")
    }
    func waitForStart() async { if !attempts.isEmpty { return }; await withCheckedContinuation { started.append($0) } }
    func release() { waiter?.resume(); waiter = nil }
}
