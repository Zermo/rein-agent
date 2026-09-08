import XCTest
@testable import ReinKlaud

final class ReinAppStoreTests: XCTestCase {
    private let gatewayOrigin = "http://127.0.0.1:4318"
    private let gatewayURLKey = "rein-klaud:gateway-url:v1"
    private let legacyActiveRunKey = "rein-klaud:active-run:v1"
    private let token = "rein-ios-test-token-1234567890"

    private var activeRunKey: String { activeRunKey(for: gatewayOrigin) }

    @MainActor
    func testCancelFailureKeepsRunCursorAndAllowsRetry() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "11111111-1111-4111-8111-111111111111"
        defaults.set(gatewayOrigin, forKey: gatewayURLKey)
        defaults.set(runID, forKey: legacyActiveRunKey)
        let cursor = RunEventCursor(defaults: defaults)
        cursor.markHandled(runID: runID, sequence: 7)
        let client = StoreMockClient(snapshot: snapshot(runID: runID))
        client.cancelError = StoreMockError.cancelFailed
        let store = makeStore(defaults: defaults, cursor: cursor, client: client)

        await store.connect(rawURL: "http://127.0.0.1:4318", token: token)
        XCTAssertEqual(store.currentRunID, runID)
        XCTAssertTrue(store.isRunning)
        XCTAssertNil(defaults.string(forKey: legacyActiveRunKey))
        XCTAssertEqual(defaults.string(forKey: activeRunKey), runID)

        await store.stop()

        XCTAssertEqual(store.currentRunID, runID)
        XCTAssertTrue(store.isRunning)
        XCTAssertEqual(defaults.string(forKey: activeRunKey), runID)
        XCTAssertEqual(cursor.lastHandled(runID: runID), 7)
        XCTAssertEqual(store.notice, "The stop request did not reach the host. The run is still tracked; try Stop again.")
        XCTAssertFalse(store.notice?.localizedCaseInsensitiveContains("stopped") ?? false)
        XCTAssertEqual(client.cancelledRunIDs, [runID])

        client.cancelError = nil
        await store.stop()

        XCTAssertNil(store.currentRunID)
        XCTAssertFalse(store.isRunning)
        XCTAssertNil(defaults.string(forKey: activeRunKey))
        XCTAssertEqual(cursor.lastHandled(runID: runID), 0)
        XCTAssertEqual(client.cancelledRunIDs, [runID, runID])
    }

    @MainActor
    func testRecoveredDecisionQueueDeduplicatesAndAdvancesOneAtATime() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "22222222-2222-4222-8222-222222222222"
        let first = MobilePendingAction(id: "approval-1", kind: "approval", tool: "writeFile", summary: "Write the field guide.", args: nil)
        let duplicate = MobilePendingAction(id: "approval-1", kind: "approval", tool: "writeFile", summary: "Duplicate event.", args: nil)
        let second = MobilePendingAction(id: "approval-2", kind: "approval", tool: "shell", summary: "Run the checks.", args: nil)
        let confirmation = MobilePendingAction(id: "confirm-1", kind: "tool", tool: "confirmAction", summary: "Publish the result.", args: ["action": .string("Publish the result.")])
        defaults.set(runID, forKey: activeRunKey)
        let client = StoreMockClient(snapshot: snapshot(runID: runID, pending: [first, duplicate, second, confirmation]))
        let store = makeStore(defaults: defaults, client: client)

        await store.connect(rawURL: "http://127.0.0.1:4318", token: token)
        XCTAssertEqual(store.pendingDecision?.id, first.id)

        let firstDecision = try XCTUnwrap(store.pendingDecision)
        await store.decide(firstDecision, allow: true)
        XCTAssertEqual(store.pendingDecision?.id, second.id)
        XCTAssertEqual(client.approvalAnswers.map(\.id), [first.id])

        store.disconnect()
        XCTAssertNil(store.pendingDecision)
        XCTAssertEqual(defaults.string(forKey: activeRunKey), runID)

        let recovered = makeStore(defaults: defaults, client: client)
        await recovered.connect(rawURL: "http://127.0.0.1:4318", token: token)
        XCTAssertEqual(recovered.pendingDecision?.id, second.id)

        let secondDecision = try XCTUnwrap(recovered.pendingDecision)
        await recovered.decide(secondDecision, allow: false)
        XCTAssertEqual(recovered.pendingDecision?.id, confirmation.id)

        let confirmDecision = try XCTUnwrap(recovered.pendingDecision)
        await recovered.decide(confirmDecision, allow: true)
        XCTAssertNil(recovered.pendingDecision)
        XCTAssertEqual(client.approvalAnswers.map(\.id), [first.id, second.id])
        XCTAssertEqual(client.approvalAnswers.map(\.allow), [true, false])
        XCTAssertEqual(client.toolAnswers.map(\.id), [confirmation.id])
        recovered.disconnect()
    }

    @MainActor
    func testClientRunIDPersistsBeforePostResultAndReattachesAfterAmbiguousCancellation() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "33333333-3333-4333-8333-333333333333"
        let gate = StartRunGate()
        let client = StoreMockClient(snapshot: snapshot(runID: runID), startGate: gate)
        let pendingStore = TestPendingRunRequestStore()
        let store = makeStore(defaults: defaults, client: client, pendingRunRequests: pendingStore, makeRunID: { runID })

        await store.connect(rawURL: "http://127.0.0.1:4318", token: token)
        store.send("Keep working after this console closes.")
        XCTAssertEqual(defaults.string(forKey: activeRunKey), runID)
        XCTAssertEqual(pendingStore.request(for: gatewayOrigin)?.message, "Keep working after this console closes.")
        await gate.waitUntilStarted()

        store.disconnect()
        await gate.release()

        XCTAssertEqual(defaults.string(forKey: activeRunKey), runID)
        XCTAssertEqual(client.startedRunIDs, [runID])
        XCTAssertTrue(client.resumeCalls.isEmpty)

        let recovered = makeStore(defaults: defaults, client: client, pendingRunRequests: pendingStore)
        await recovered.connect(rawURL: "http://127.0.0.1:4318", token: token)
        await waitUntil { !client.resumeCalls.isEmpty }

        XCTAssertEqual(recovered.currentRunID, runID)
        XCTAssertTrue(recovered.isRunning)
        XCTAssertEqual(client.resumeCalls.map(\.runID), [runID])
        XCTAssertNil(pendingStore.request(for: gatewayOrigin))
        recovered.disconnect()
    }

    @MainActor
    func testUnknownRecoveredRequestWaitsForExplicitRetryWithSameBodyAndID() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "33333333-aaaa-4333-8333-333333333333"
        let request = RunRequest(
            runId: runID,
            threadId: "thread-1",
            botId: "bot-1",
            message: "Recover this exact operator request.",
            tools: ReinGatewayClient.frontendTools
        )
        let pendingStore = TestPendingRunRequestStore()
        try pendingStore.save(request, for: try XCTUnwrap(URL(string: gatewayOrigin)), now: Date())
        defaults.set(runID, forKey: activeRunKey)
        let client = StoreMockClient(snapshot: snapshot(runID: runID))
        client.statusError = GatewayClientError.http(404, "missing")
        let store = makeStore(defaults: defaults, client: client, pendingRunRequests: pendingStore)

        await store.connect(rawURL: gatewayOrigin, token: token)

        let recovery = try XCTUnwrap(store.pendingRunRecovery)
        XCTAssertEqual(recovery.runID, runID)
        XCTAssertTrue(client.startedRequests.isEmpty)
        XCTAssertTrue(store.notice?.contains("choose Retry or Discard") ?? false)
        XCTAssertNotNil(pendingStore.request(for: gatewayOrigin))

        client.statusError = nil
        await store.retryPendingRun(recovery)
        await waitUntil { client.resumeCalls.count == 1 }

        XCTAssertEqual(client.startedRequests, [request])
        XCTAssertNil(pendingStore.request(for: gatewayOrigin))
        XCTAssertNil(store.pendingRunRecovery)
        XCTAssertEqual(store.currentRunID, runID)
        store.disconnect()
    }

    @MainActor
    func testDiscardRemovesOnlySavedRetryAndReattachesAcceptedHostRun() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "33333333-aaab-4333-8333-333333333333"
        let request = RunRequest(
            runId: runID,
            threadId: "thread-1",
            botId: "bot-1",
            message: "This request may already be running.",
            tools: ReinGatewayClient.frontendTools
        )
        let pendingStore = TestPendingRunRequestStore()
        try pendingStore.save(request, for: try XCTUnwrap(URL(string: gatewayOrigin)), now: Date())
        defaults.set(runID, forKey: activeRunKey)
        let client = StoreMockClient(snapshot: snapshot(runID: runID))
        client.statusError = GatewayClientError.http(404, "missing")
        let store = makeStore(defaults: defaults, client: client, pendingRunRequests: pendingStore)

        await store.connect(rawURL: gatewayOrigin, token: token)
        let recovery = try XCTUnwrap(store.pendingRunRecovery)

        client.statusError = nil
        await store.discardPendingRun(recovery)
        await waitUntil { client.resumeCalls.count == 1 }

        XCTAssertNil(pendingStore.request(for: gatewayOrigin))
        XCTAssertNil(store.pendingRunRecovery)
        XCTAssertEqual(store.currentRunID, runID)
        XCTAssertTrue(store.isRunning)
        XCTAssertEqual(defaults.string(forKey: activeRunKey), runID)
        XCTAssertTrue(client.startedRequests.isEmpty)
        store.disconnect()
    }

    @MainActor
    func testPendingRequestNeverCrossesGatewayOrigins() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "33333333-bbbb-4333-8333-333333333333"
        let otherOrigin = "http://rein-nearby.local:4318"
        let pendingStore = TestPendingRunRequestStore()
        let request = RunRequest(runId: runID, threadId: "thread-1", botId: "bot-1", message: "Host A only.", tools: ReinGatewayClient.frontendTools)
        try pendingStore.save(request, for: try XCTUnwrap(URL(string: gatewayOrigin)), now: Date())
        defaults.set(runID, forKey: activeRunKey)
        let clientA = StoreMockClient(snapshot: snapshot(runID: runID))
        let clientB = StoreMockClient(snapshot: snapshot(runID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))
        let store = makeMultiHostStore(defaults: defaults, clientA: clientA, clientB: clientB, pendingRunRequests: pendingStore)

        await store.connect(rawURL: otherOrigin, token: token)

        XCTAssertNil(store.pendingRunRecovery)
        XCTAssertNil(store.currentRunID)
        XCTAssertTrue(clientA.startedRequests.isEmpty)
        XCTAssertTrue(clientB.startedRequests.isEmpty)
        XCTAssertEqual(pendingStore.request(for: gatewayOrigin), request)
    }

    @MainActor
    func testMissingTrackedRunPromotesDifferentSavedRequestWithoutDeletingOrReplayingIt() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let staleRunID = "33333333-bbba-4333-8333-333333333333"
        let savedRunID = "33333333-bbbb-4333-8333-333333333333"
        let pendingStore = TestPendingRunRequestStore()
        let request = RunRequest(runId: savedRunID, threadId: "thread-1", botId: "bot-1", message: "Preserve this separate request.", tools: ReinGatewayClient.frontendTools)
        try pendingStore.save(request, for: try XCTUnwrap(URL(string: gatewayOrigin)), now: Date())
        defaults.set(staleRunID, forKey: activeRunKey)
        let client = StoreMockClient(snapshot: snapshot(runID: savedRunID))
        client.statusError = GatewayClientError.http(404, "missing")
        let store = makeStore(defaults: defaults, client: client, pendingRunRequests: pendingStore)

        await store.connect(rawURL: gatewayOrigin, token: token)

        XCTAssertEqual(client.statusRunIDs, [staleRunID, savedRunID])
        XCTAssertEqual(store.pendingRunRecovery?.runID, savedRunID)
        XCTAssertEqual(store.currentRunID, savedRunID)
        XCTAssertEqual(defaults.string(forKey: activeRunKey), savedRunID)
        XCTAssertEqual(pendingStore.request(for: gatewayOrigin), request)
        XCTAssertTrue(client.startedRequests.isEmpty)
    }

    @MainActor
    func testRequestTimeoutKeepsProtectedRequestForExplicitRecovery() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "33333333-bbbc-4333-8333-333333333333"
        let pendingStore = TestPendingRunRequestStore()
        let client = StoreMockClient(snapshot: snapshot(runID: runID))
        client.startError = GatewayClientError.http(408, "timed out")
        let store = makeStore(defaults: defaults, client: client, pendingRunRequests: pendingStore, makeRunID: { runID })

        await store.connect(rawURL: gatewayOrigin, token: token)
        store.send("Keep this after an ambiguous timeout.")
        await waitUntil { store.pendingRunRecovery != nil }

        XCTAssertEqual(store.pendingRunRecovery?.runID, runID)
        XCTAssertEqual(pendingStore.request(for: gatewayOrigin)?.message, "Keep this after an ambiguous timeout.")
        XCTAssertEqual(defaults.string(forKey: activeRunKey), runID)
        XCTAssertTrue(store.isRunning)
    }

    @MainActor
    func testProtectedQueueFailurePreventsNetworkSend() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let pendingStore = TestPendingRunRequestStore()
        pendingStore.saveError = StoreMockError.storageFailed
        let client = StoreMockClient(snapshot: snapshot(runID: "33333333-cccc-4333-8333-333333333333"))
        let store = makeStore(defaults: defaults, client: client, pendingRunRequests: pendingStore)

        await store.connect(rawURL: gatewayOrigin, token: token)
        XCTAssertFalse(store.send("Do not send without a protected retry copy."))

        XCTAssertTrue(client.startedRequests.isEmpty)
        XCTAssertNil(store.currentRunID)
        XCTAssertFalse(store.isRunning)
        XCTAssertNil(defaults.string(forKey: activeRunKey))
        XCTAssertTrue(store.selectedMessages.isEmpty)
    }

    @MainActor
    func testForegroundReplacesAStaleSubscriptionWithCursorSafeResume() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "44444444-4444-4444-8444-444444444444"
        defaults.set(runID, forKey: activeRunKey)
        let cursor = RunEventCursor(defaults: defaults)
        cursor.markHandled(runID: runID, sequence: 12)
        let client = StoreMockClient(snapshot: snapshot(runID: runID, lastSequence: 12))
        let store = makeStore(defaults: defaults, cursor: cursor, client: client)

        await store.connect(rawURL: "http://127.0.0.1:4318", token: token)
        await waitUntil { client.resumeCalls.count == 1 }
        await store.didBecomeActive()
        await waitUntil { client.resumeCalls.count == 2 }

        XCTAssertEqual(client.resumeCalls.map(\.runID), [runID, runID])
        XCTAssertEqual(client.resumeCalls.map(\.after), [12, 12])
        XCTAssertEqual(store.currentRunID, runID)
        XCTAssertTrue(store.isRunning)
        store.disconnect()
    }

    @MainActor
    func testForgetDuringAmbiguousPostDoesNotRestoreRunTracking() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "66666666-6666-4666-8666-666666666666"
        let gate = StartRunGate(receipt: .init(runId: runID, status: "starting", eventsUrl: "/events", statusUrl: "/status"))
        let client = StoreMockClient(snapshot: snapshot(runID: runID), startGate: gate)
        let store = makeStore(defaults: defaults, client: client, makeRunID: { runID })

        await store.connect(rawURL: "http://127.0.0.1:4318", token: token)
        store.send("Forget this host even if the POST result is ambiguous.")
        await gate.waitUntilStarted()
        XCTAssertEqual(defaults.string(forKey: activeRunKey), runID)

        store.disconnect(forget: true)
        await gate.release()
        try? await Task.sleep(for: .milliseconds(20))

        XCTAssertNil(defaults.string(forKey: activeRunKey))
        XCTAssertNil(store.currentRunID)
        XCTAssertEqual(store.savedURL, "")
        XCTAssertTrue(client.resumeCalls.isEmpty)
    }

    @MainActor
    func testGatewayTokensAreScopedToCanonicalOrigin() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let secrets = TestSecretStore()
        let client = StoreMockClient(snapshot: snapshot(runID: "55555555-5555-4555-8555-555555555555"))
        let firstToken = "first-host-token-1234567890"
        let secondToken = "second-host-token-123456789"
        let store = makeStore(defaults: defaults, client: client, secrets: secrets)

        await store.connect(rawURL: "http://127.0.0.1:4318/", token: firstToken)
        store.disconnect()

        XCTAssertEqual(store.savedToken(for: "http://127.0.0.1:4318"), firstToken)
        XCTAssertEqual(store.savedToken(for: "http://rein-nearby.local:4318"), "")

        await store.connect(rawURL: "http://rein-nearby.local:4318", token: secondToken)
        store.disconnect()

        XCTAssertEqual(store.savedToken(for: "http://rein-nearby.local:4318/"), secondToken)
        XCTAssertEqual(store.savedToken(for: "http://127.0.0.1:4318"), firstToken)
        XCTAssertNotEqual(store.savedToken(for: "http://rein-nearby.local:4318"), firstToken)
    }

    @MainActor
    func testStreamFailureKeepsTrackedRunBlockingAnotherSend() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "77777777-7777-4777-8777-777777777777"
        let client = StoreMockClient(snapshot: snapshot(runID: runID))
        client.resumeError = StoreMockError.streamFailed
        let store = makeStore(defaults: defaults, client: client, makeRunID: { runID })

        await store.connect(rawURL: gatewayOrigin, token: token)
        store.send("Start the long host task.")
        await waitUntil { store.errorMessage != nil }

        XCTAssertTrue(store.isRunning)
        XCTAssertEqual(store.currentRunID, runID)
        XCTAssertEqual(defaults.string(forKey: activeRunKey), runID)
        XCTAssertEqual(client.startedRunIDs, [runID])

        store.send("This must not replace the tracked run.")

        XCTAssertEqual(client.startedRunIDs, [runID])
        XCTAssertEqual(store.currentRunID, runID)
        XCTAssertEqual(defaults.string(forKey: activeRunKey), runID)
        store.disconnect()
    }

    @MainActor
    func testActiveRunBelongsOnlyToItsCanonicalGatewayOrigin() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "88888888-8888-4888-8888-888888888888"
        let otherOrigin = "http://rein-nearby.local:4318"
        defaults.set(runID, forKey: activeRunKey(for: gatewayOrigin))
        let client = StoreMockClient(snapshot: snapshot(runID: runID))
        let store = makeStore(defaults: defaults, client: client)

        await store.connect(rawURL: otherOrigin, token: token)

        XCTAssertNil(store.currentRunID)
        XCTAssertFalse(store.isRunning)
        XCTAssertTrue(client.statusRunIDs.isEmpty)
        XCTAssertEqual(defaults.string(forKey: activeRunKey(for: gatewayOrigin)), runID)

        store.disconnect()
        await store.connect(rawURL: gatewayOrigin, token: token)
        await waitUntil { !client.resumeCalls.isEmpty }

        XCTAssertEqual(store.currentRunID, runID)
        XCTAssertTrue(store.isRunning)
        XCTAssertEqual(client.statusRunIDs, [runID])
        XCTAssertEqual(defaults.string(forKey: activeRunKey(for: gatewayOrigin)), runID)
        store.disconnect()
    }

    @MainActor
    func testForegroundReattachClearsRunThatFinishesBetweenStatusChecks() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "99999999-9999-4999-8999-999999999999"
        defaults.set(runID, forKey: activeRunKey)
        let client = StoreMockClient(snapshot: snapshot(runID: runID))
        let store = makeStore(defaults: defaults, client: client)

        await store.connect(rawURL: gatewayOrigin, token: token)
        await waitUntil { client.resumeCalls.count == 1 }
        client.queueStatusSnapshots([
            snapshot(runID: runID),
            snapshot(runID: runID, status: "completed"),
        ])

        await store.didBecomeActive()

        XCTAssertNil(store.currentRunID)
        XCTAssertFalse(store.isRunning)
        XCTAssertNil(defaults.string(forKey: activeRunKey))
    }

    @MainActor
    func testSlowAutomaticActionFromOldGatewayCannotMutateNewGateway() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        let otherOrigin = "http://rein-nearby.local:4318"
        let action = MobilePendingAction(
            id: "patch-from-a",
            kind: "tool",
            tool: "patchShell",
            summary: "Apply host A shell state.",
            args: ["patch": .array([.object([
                "op": .string("replace"),
                "path": .string("/theme/accent"),
                "value": .string("host-a"),
            ])])]
        )
        defaults.set(runID, forKey: activeRunKey)
        let patchGate = PatchGate()
        let clientA = StoreMockClient(snapshot: snapshot(runID: runID, pending: [action]), state: appState(accent: "host-a"), patchGate: patchGate)
        let clientB = StoreMockClient(snapshot: snapshot(runID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), state: appState(accent: "host-b"))
        let store = ReinAppStore(
            secrets: TestSecretStore(),
            defaults: defaults,
            sounds: ReinSoundEngine(preference: TestSoundPreferenceStore()),
            pendingRunRequests: TestPendingRunRequestStore(),
            makeClient: { connection in connection.baseURL.host == "127.0.0.1" ? clientA : clientB }
        )

        await store.connect(rawURL: gatewayOrigin, token: token)
        await patchGate.waitUntilStarted()
        store.disconnect()
        await store.connect(rawURL: otherOrigin, token: token)
        XCTAssertEqual(store.state.shell.theme.accent, "host-b")

        await patchGate.release()
        try? await Task.sleep(for: .milliseconds(30))

        XCTAssertEqual(store.connectedURL?.absoluteString, otherOrigin)
        XCTAssertEqual(store.state.shell.theme.accent, "host-b")
        XCTAssertNil(store.currentRunID)
        XCTAssertFalse(store.isRunning)
        XCTAssertTrue(clientA.toolAnswers.isEmpty)
        XCTAssertTrue(clientB.statusRunIDs.isEmpty)
    }

    @MainActor
    func testLateRefreshFromOldGatewayCannotOverwriteNewGatewayState() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let otherOrigin = "http://rein-nearby.local:4318"
        let clientA = StoreMockClient(snapshot: snapshot(runID: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"), state: appState(accent: "host-a"))
        let clientB = StoreMockClient(snapshot: snapshot(runID: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb"), state: appState(accent: "host-b"))
        let store = makeMultiHostStore(defaults: defaults, clientA: clientA, clientB: clientB)

        await store.connect(rawURL: gatewayOrigin, token: token)
        let stateGate = StateGate(value: appState(accent: "late-host-a"))
        clientA.gateNextState(stateGate)
        let refresh = Task { await store.refresh() }
        await stateGate.waitUntilStarted()

        store.disconnect()
        await store.connect(rawURL: otherOrigin, token: token)
        await stateGate.release()
        await refresh.value

        XCTAssertEqual(store.connectedURL?.absoluteString, otherOrigin)
        XCTAssertEqual(store.state.shell.theme.accent, "host-b")
        XCTAssertNil(store.errorMessage)
    }

    @MainActor
    func testLateTerminalReconcileFromOldGatewayCannotClearNewGatewayRun() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runA = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa"
        let runB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
        let otherOrigin = "http://rein-nearby.local:4318"
        defaults.set(runA, forKey: activeRunKey(for: gatewayOrigin))
        let clientA = StoreMockClient(snapshot: snapshot(runID: runA), state: appState(accent: "host-a"))
        let clientB = StoreMockClient(snapshot: snapshot(runID: runB), state: appState(accent: "host-b"))
        let store = makeMultiHostStore(defaults: defaults, clientA: clientA, clientB: clientB)

        await store.connect(rawURL: gatewayOrigin, token: token)
        await waitUntil { clientA.resumeCalls.count == 1 }
        let statusGate = StatusGate(value: snapshot(runID: runA, status: "completed"))
        clientA.gateNextStatus(statusGate)
        let reconcile = Task { await store.didBecomeActive() }
        await statusGate.waitUntilStarted()

        store.disconnect()
        defaults.set(runB, forKey: activeRunKey(for: otherOrigin))
        await store.connect(rawURL: otherOrigin, token: token)
        await waitUntil { clientB.resumeCalls.count == 1 }
        await statusGate.release()
        await reconcile.value

        XCTAssertEqual(store.connectedURL?.absoluteString, otherOrigin)
        XCTAssertEqual(store.currentRunID, runB)
        XCTAssertTrue(store.isRunning)
        XCTAssertEqual(defaults.string(forKey: activeRunKey(for: otherOrigin)), runB)
        XCTAssertEqual(defaults.string(forKey: activeRunKey(for: gatewayOrigin)), runA)
        XCTAssertEqual(clientB.statusRunIDs, [runB])
        store.disconnect()
    }

    @MainActor
    func testLateSettingsPatchFromOldGatewayCannotOverwriteNewGatewayState() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let otherOrigin = "http://rein-nearby.local:4318"
        let patchGate = PatchGate()
        let clientA = StoreMockClient(snapshot: snapshot(runID: "aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa"), state: appState(accent: "late-host-a"), patchGate: patchGate)
        let clientB = StoreMockClient(snapshot: snapshot(runID: "bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb"), state: appState(accent: "host-b"))
        let store = makeMultiHostStore(defaults: defaults, clientA: clientA, clientB: clientB)

        await store.connect(rawURL: gatewayOrigin, token: token)
        let patch = Task { await store.setAccent("operator-choice") }
        await patchGate.waitUntilStarted()

        store.disconnect()
        await store.connect(rawURL: otherOrigin, token: token)
        await patchGate.release()
        await patch.value

        XCTAssertEqual(store.connectedURL?.absoluteString, otherOrigin)
        XCTAssertEqual(store.state.shell.theme.accent, "host-b")
        XCTAssertNil(store.errorMessage)
    }

    @MainActor
    func testDelayedBackupCannotContinueAfterManualHostSelection() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let primary = StoreMockClient(snapshot: snapshot(runID: "aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa"))
        primary.probeError = URLError(.cannotConnectToHost)
        let first = StoreMockClient(snapshot: snapshot(runID: "bbbbbbbb-4444-4444-8444-bbbbbbbbbbbb"))
        let second = StoreMockClient(snapshot: snapshot(runID: "cccccccc-4444-4444-8444-cccccccccccc"))
        let manual = StoreMockClient(snapshot: snapshot(runID: "dddddddd-4444-4444-8444-dddddddddddd"), state: appState(accent: "manual-host"))
        let gate = StateGate(value: appState(accent: "stale-backup"))
        first.gateNextState(gate)
        let store = ReinAppStore(secrets: TestSecretStore(), defaults: defaults,
            sounds: ReinSoundEngine(preference: TestSoundPreferenceStore()), pendingRunRequests: TestPendingRunRequestStore(),
            makeClient: { connection in
                switch connection.baseURL.host {
                case "backup-one.local": first
                case "backup-two.local": second
                case "operator-choice.local": manual
                default: primary
                }
            })
        try store.cloud.saveBackup(name: "First", rawURL: "http://backup-one.local:4318", token: token)
        try store.cloud.saveBackup(name: "Second", rawURL: "http://backup-two.local:4318", token: token)
        store.cloud.accounts.setAutomaticFallback(true)
        await store.connect(rawURL: gatewayOrigin, token: token)

        let send = Task { await store.sendWithFallback("Preserve this draft.") }
        await gate.waitUntilStarted()
        await store.connect(rawURL: "http://operator-choice.local:4318", token: token)
        await gate.release()
        let sent = await send.value

        XCTAssertFalse(sent)
        XCTAssertEqual(store.connectedURL?.host, "operator-choice.local")
        XCTAssertEqual(store.state.shell.theme.accent, "manual-host")
        XCTAssertEqual(second.stateCalls, 0)
        XCTAssertTrue(primary.startedRequests.isEmpty)
        XCTAssertTrue(first.startedRequests.isEmpty)
        XCTAssertTrue(manual.startedRequests.isEmpty)
        XCTAssertFalse(store.showCloudWorkspace)
        store.disconnect()
    }

    @MainActor
    func testUnknownDeliveryNeverFallsBackOrMovesItsPendingRequestToBackup() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa"
        let primary = StoreMockClient(snapshot: snapshot(runID: runID))
        primary.startError = URLError(.networkConnectionLost)
        let backup = StoreMockClient(snapshot: snapshot(runID: "bbbbbbbb-5555-4555-8555-bbbbbbbbbbbb"))
        let pending = TestPendingRunRequestStore()
        let store = makeMultiHostStore(defaults: defaults, clientA: primary, clientB: backup, pendingRunRequests: pending)
        try store.cloud.saveBackup(name: "Reserve", rawURL: "http://reserve.local:4318", token: token)
        store.cloud.accounts.setAutomaticFallback(true)
        await store.connect(rawURL: gatewayOrigin, token: token)

        let sent = await store.sendWithFallback("Run this exactly once on the original host.")
        XCTAssertTrue(sent)
        await waitUntil { store.pendingRunRecovery != nil }
        let tracked = try XCTUnwrap(store.pendingRunRecovery?.runID)
        XCTAssertEqual(primary.startedRequests.count, 1)
        XCTAssertEqual(backup.stateCalls, 0)
        XCTAssertEqual(pending.request(for: gatewayOrigin)?.runId, tracked)

        await store.useBackup(try XCTUnwrap(store.cloud.backups.first))

        XCTAssertEqual(store.savedURL, gatewayOrigin)
        XCTAssertEqual(store.connectedURL?.host, "reserve.local")
        XCTAssertEqual(pending.request(for: gatewayOrigin)?.runId, tracked)
        XCTAssertNil(pending.request(for: "http://reserve.local:4318"))
        XCTAssertEqual(defaults.string(forKey: activeRunKey), tracked)
        XCTAssertTrue(backup.startedRequests.isEmpty)
        XCTAssertTrue(backup.statusRunIDs.isEmpty)
        store.disconnect()
    }

    @MainActor
    func testGatewayAuthenticationFailureDoesNotStartFallback() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let primary = StoreMockClient(snapshot: snapshot(runID: "aaaaaaaa-6666-4666-8666-aaaaaaaaaaaa"))
        primary.probeError = GatewayClientError.http(401, "Fixture rejected token.")
        let backup = StoreMockClient(snapshot: snapshot(runID: "bbbbbbbb-6666-4666-8666-bbbbbbbbbbbb"))
        let store = makeMultiHostStore(defaults: defaults, clientA: primary, clientB: backup)
        try store.cloud.saveBackup(name: "Reserve", rawURL: "http://reserve.local:4318", token: token)
        store.cloud.accounts.setAutomaticFallback(true)
        await store.connect(rawURL: gatewayOrigin, token: token)

        let sent = await store.sendWithFallback("Do not silently change routes on auth rejection.")

        XCTAssertFalse(sent)
        XCTAssertEqual(store.connectedURL?.absoluteString, gatewayOrigin)
        XCTAssertEqual(backup.stateCalls, 0)
        XCTAssertTrue(primary.startedRequests.isEmpty)
        XCTAssertFalse(store.showCloudWorkspace)
        store.disconnect()
    }

    @MainActor
    func testSuccessfulBackupKeepsComposerDraftThroughViewReplacement() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let primary = StoreMockClient(snapshot: snapshot(runID: "aaaaaaaa-8888-4888-8888-aaaaaaaaaaaa"))
        primary.probeError = URLError(.cannotConnectToHost)
        let backup = StoreMockClient(snapshot: snapshot(runID: "bbbbbbbb-8888-4888-8888-bbbbbbbbbbbb"))
        let gate = StateGate(value: appState(accent: "backup"))
        backup.gateNextState(gate)
        let store = makeMultiHostStore(defaults: defaults, clientA: primary, clientB: backup)
        try store.cloud.saveBackup(name: "Reserve", rawURL: "http://reserve.local:4318", token: token)
        store.cloud.accounts.setAutomaticFallback(true)
        await store.connect(rawURL: gatewayOrigin, token: token)
        store.chatDraft = "Keep this unsent draft."

        let send = Task { await store.sendWithFallback(store.chatDraft) }
        await gate.waitUntilStarted()
        XCTAssertNil(store.connectedURL) // RootView replaces ChatView at this point.
        XCTAssertEqual(store.chatDraft, "Keep this unsent draft.")
        await gate.release()
        let sent = await send.value

        XCTAssertFalse(sent)
        XCTAssertEqual(store.connectedURL?.host, "reserve.local")
        XCTAssertEqual(store.chatDraft, "Keep this unsent draft.")
        XCTAssertTrue(backup.startedRequests.isEmpty)
        store.disconnect()
    }

    @MainActor
    func testFieldUnitChangeDuringSuccessfulProbeDoesNotSendDraft() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        var state = appState(accent: "primary")
        state.bots.append(.init(id: "different-field-unit", name: "Another unit", sessionId: "thread-2"))
        let primary = StoreMockClient(snapshot: snapshot(runID: "aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa"), state: state)
        let gate = PatchGate()
        primary.probeGate = gate
        let store = makeStore(defaults: defaults, client: primary)
        try store.cloud.saveBackup(name: "Reserve", rawURL: "http://reserve.local:4318", token: token)
        store.cloud.accounts.setAutomaticFallback(true)
        await store.connect(rawURL: gatewayOrigin, token: token)
        store.chatDraft = "Only for the original field unit."

        let send = Task { await store.sendWithFallback(store.chatDraft) }
        await gate.waitUntilStarted()
        store.selectedBotID = "different-field-unit"
        XCTAssertNotNil(store.selectedBot)
        await gate.release()
        let sent = await send.value

        XCTAssertFalse(sent)
        XCTAssertTrue(primary.startedRequests.isEmpty)
        XCTAssertEqual(store.chatDraft, "Only for the original field unit.")
        XCTAssertTrue(store.notice?.contains("selected field unit changed") ?? false)
        store.disconnect()
    }

    @MainActor
    func testDisablingFallbackDuringProbePreventsBackupConnection() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let primary = StoreMockClient(snapshot: snapshot(runID: "aaaaaaaa-abab-4bab-8bab-aaaaaaaaaaaa"))
        primary.probeError = URLError(.cannotConnectToHost)
        let gate = PatchGate()
        primary.probeGate = gate
        let backup = StoreMockClient(snapshot: snapshot(runID: "bbbbbbbb-abab-4bab-8bab-bbbbbbbbbbbb"))
        let store = makeMultiHostStore(defaults: defaults, clientA: primary, clientB: backup)
        try store.cloud.saveBackup(name: "Reserve", rawURL: "http://reserve.local:4318", token: token)
        store.cloud.accounts.setAutomaticFallback(true)
        await store.connect(rawURL: gatewayOrigin, token: token)

        let send = Task { await store.sendWithFallback("Keep this on my current route.") }
        await gate.waitUntilStarted()
        store.cloud.accounts.setAutomaticFallback(false)
        await gate.release()
        let sent = await send.value

        XCTAssertFalse(sent)
        XCTAssertEqual(backup.stateCalls, 0)
        XCTAssertTrue(primary.startedRequests.isEmpty)
        XCTAssertFalse(store.showCloudWorkspace)
        store.disconnect()
    }

    @MainActor
    func testDirectFallbackUsesSourceTranscriptCapturedBeforeProbeAwait() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let directory = FileManager.default.temporaryDirectory.appending(path: "ReinSourceSnapshot-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let secrets = TestSecretStore(), direct = StoreDirectMockClient()
        let workspace = CloudWorkspace(defaults: defaults, secrets: secrets, modelClient: direct, transcriptDirectory: directory)
        workspace.includeRecentMessages = true
        let account = try CloudAccount(name: "Fixture API", provider: .openai, model: "fixture-model")
        try workspace.accounts.save(account, apiKey: "fixture-api-key")
        workspace.accounts.setAutomaticFallback(true)
        let primary = StoreMockClient(snapshot: snapshot(runID: "aaaaaaaa-7777-4777-8777-aaaaaaaaaaaa"))
        primary.messagePage = .init(messages: [.init(id: "source-reply", role: .assistant, content: "Original field unit context.")], before: nil)
        primary.probeError = URLError(.cannotConnectToHost)
        let gate = PatchGate()
        primary.probeGate = gate
        let store = ReinAppStore(secrets: secrets, defaults: defaults,
            sounds: ReinSoundEngine(preference: TestSoundPreferenceStore()), pendingRunRequests: TestPendingRunRequestStore(),
            cloudWorkspace: workspace, makeClient: { _ in primary })
        await store.connect(rawURL: gatewayOrigin, token: token)

        let send = Task { await store.sendWithFallback("Continue this source conversation.") }
        await gate.waitUntilStarted()
        store.selectedBotID = "different-field-unit"
        await gate.release()
        let sent = await send.value
        XCTAssertTrue(sent)
        await waitUntil { !workspace.isRunning }

        XCTAssertEqual(Array(direct.receivedMessages.map(\.content).dropFirst()), ["Original field unit context.", "Continue this source conversation."])
        XCTAssertTrue(primary.startedRequests.isEmpty)
        store.disconnect()
    }

    @MainActor
    func testAssistedSetupIsCompletedPerHostAndPreservesSavedConnection() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let client = StoreMockClient(snapshot: snapshot(runID: "run"))
        let store = makeStore(defaults: defaults, client: client)
        await store.connect(rawURL: gatewayOrigin, token: token, assistedSetup: true)
        XCTAssertTrue(store.showBotSetup)
        XCTAssertEqual(store.selectedBot?.id, "bot-1")
        store.completeBotSetup()
        XCTAssertFalse(store.showBotSetup)
        XCTAssertEqual(store.section, .chat)
        store.disconnect()
        XCTAssertEqual(store.savedURL, gatewayOrigin)
        await store.connect(rawURL: gatewayOrigin, token: token, assistedSetup: true)
        XCTAssertFalse(store.showBotSetup)
        store.disconnect()
        await store.connect(rawURL: "http://127.0.0.2:4318", token: token, assistedSetup: true)
        XCTAssertTrue(store.showBotSetup)
        store.disconnect()
    }

    @MainActor
    func testEmptyHostRequiresBotBeforeSetupCanFinishAndSavesChosenAvatar() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let client = StoreMockClient(snapshot: snapshot(runID: "run"), state: .empty)
        let store = makeStore(defaults: defaults, client: client)
        await store.connect(rawURL: gatewayOrigin, token: token, assistedSetup: true)
        store.completeBotSetup()
        XCTAssertTrue(store.showBotSetup)
        let created = await store.createBot(name: "Day planner", avatar: "explorer")
        XCTAssertTrue(created)
        XCTAssertEqual(store.selectedBot?.name, "Day planner")
        XCTAssertEqual(store.selectedBot?.avatar, "explorer")
        store.completeBotSetup()
        XCTAssertFalse(store.showBotSetup)
        store.disconnect()
    }

    @MainActor
    func testChangingAvatarPreservesBotSessionAndConversation() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let client = StoreMockClient(snapshot: snapshot(runID: "run"))
        client.messagePage = .init(messages: [.init(id: "greeting", role: .user, content: "Plan my day")], before: nil)
        let store = makeStore(defaults: defaults, client: client)
        await store.connect(rawURL: gatewayOrigin, token: token)
        let original = try XCTUnwrap(store.selectedBot)
        let updated = await store.updateBotAvatar(original, avatar: .builder)
        XCTAssertTrue(updated)
        XCTAssertEqual(store.selectedBot?.avatar, "builder")
        XCTAssertEqual(store.selectedBot?.sessionId, original.sessionId)
        XCTAssertEqual(store.selectedMessages.first?.content, "Plan my day")
        store.disconnect()
    }

    @MainActor
    func testAvatarActivityStaysWithRunningBotWhenSelectionChanges() async throws {
        let (defaults, suite) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let runID = "22222222-2222-4222-8222-222222222222"
        var state = appState(accent: "rain")
        state.bots.append(.init(id: "bot-2", name: "Second bot", sessionId: "thread-2"))
        let client = StoreMockClient(snapshot: snapshot(runID: runID), state: state)
        let store = makeStore(defaults: defaults, client: client, makeRunID: { runID })
        await store.connect(rawURL: gatewayOrigin, token: token)
        XCTAssertEqual(store.avatarPhase(for: state.bots[0]), .ready)
        XCTAssertTrue(store.send("Check this synthetic task"))
        await waitUntil { !client.resumeCalls.isEmpty }
        await store.chooseBot("bot-2")
        XCTAssertEqual(store.selectedBotID, "bot-2")
        XCTAssertEqual(store.avatarPhase(for: state.bots[0]), .working)
        XCTAssertEqual(store.avatarPhase(for: state.bots[1]), .ready)
        store.disconnect()
        XCTAssertEqual(store.avatarPhase(for: state.bots[0]), .ready)
    }

    @MainActor
    private func makeStore(
        defaults: UserDefaults,
        cursor: RunEventCursor? = nil,
        client: StoreMockClient,
        secrets: TestSecretStore = TestSecretStore(),
        pendingRunRequests: TestPendingRunRequestStore? = nil,
        makeRunID: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) -> ReinAppStore {
        let preference = TestSoundPreferenceStore()
        return ReinAppStore(
            secrets: secrets,
            defaults: defaults,
            sounds: ReinSoundEngine(preference: preference),
            eventCursor: cursor,
            pendingRunRequests: pendingRunRequests ?? TestPendingRunRequestStore(),
            makeClient: { _ in client },
            makeRunID: makeRunID
        )
    }

    @MainActor
    private func makeMultiHostStore(defaults: UserDefaults, clientA: StoreMockClient, clientB: StoreMockClient, pendingRunRequests: TestPendingRunRequestStore? = nil) -> ReinAppStore {
        ReinAppStore(
            secrets: TestSecretStore(),
            defaults: defaults,
            sounds: ReinSoundEngine(preference: TestSoundPreferenceStore()),
            pendingRunRequests: pendingRunRequests ?? TestPendingRunRequestStore(),
            makeClient: { connection in connection.baseURL.host == "127.0.0.1" ? clientA : clientB }
        )
    }

    private func makeDefaults() -> (UserDefaults, String) {
        let suite = "ReinAppStoreTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return (defaults, suite)
    }

    private func activeRunKey(for origin: String) -> String {
        "rein-klaud:active-run:v2:\(origin)"
    }

    private func snapshot(runID: String, pending: [MobilePendingAction] = [], lastSequence: Int = 0, status: String = "waiting") -> MobileRunSnapshot {
        .init(
            id: runID,
            threadId: "thread-1",
            status: status,
            createdAt: "2026-09-06T12:00:00.000Z",
            updatedAt: "2026-09-06T12:00:01.000Z",
            completedAt: nil,
            error: nil,
            oldestSequence: 1,
            lastSequence: lastSequence,
            pending: pending
        )
    }

    private func appState(accent: String) -> ReinState {
        .init(
            shell: .init(version: 1, theme: .init(accent: accent, density: "regular", dark: false), chrome: .init(sidebar: true, tray: "normal", showActivity: true)),
            prefs: .init(lastBotId: "bot-1"),
            bots: [.init(id: "bot-1", name: "Field Guide", sessionId: "thread-1")],
            approvals: []
        )
    }

    @MainActor
    private func waitUntil(_ condition: @escaping @MainActor () -> Bool) async {
        for _ in 0..<200 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("Timed out waiting for the store state to change.")
    }
}

private enum StoreMockError: LocalizedError {
    case cancelFailed, streamFailed, storageFailed
    var errorDescription: String? {
        switch self {
        case .cancelFailed: "The test gateway did not accept cancellation."
        case .streamFailed: "The test event stream disconnected."
        case .storageFailed: "The test protected queue could not save the request."
        }
    }
}

private actor StartRunGate {
    private let receipt: MobileRunReceipt?
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(receipt: MobileRunReceipt? = nil) {
        self.receipt = receipt
    }

    func waitForResult() async throws -> MobileRunReceipt {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseContinuation = $0 }
        if let receipt { return receipt }
        throw CancellationError()
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor PatchGate {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    func waitForRelease() async {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseContinuation = $0 }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor StateGate {
    private let value: ReinState
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(value: ReinState) { self.value = value }

    func waitForValue() async -> ReinState {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseContinuation = $0 }
        return value
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private actor StatusGate {
    private let value: MobileRunSnapshot
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    init(value: MobileRunSnapshot) { self.value = value }

    func waitForValue() async -> MobileRunSnapshot {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { releaseContinuation = $0 }
        return value
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

private final class StoreMockClient: ReinGatewayClientProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var stateValue = ReinState(
        shell: .init(version: 1, theme: .init(accent: "rain", density: "regular", dark: false), chrome: .init(sidebar: true, tray: "normal", showActivity: true)),
        prefs: .init(lastBotId: "bot-1"),
        bots: [.init(id: "bot-1", name: "Field Guide", sessionId: "thread-1")],
        approvals: []
    )
    private var snapshotValue: MobileRunSnapshot
    private var queuedStatusValues: [MobileRunSnapshot] = []
    private let startGate: StartRunGate?
    private let patchGate: PatchGate?
    private var nextStateGate: StateGate?
    private var nextStatusGate: StatusGate?
    private var resumeContinuations: [AsyncThrowingStream<RunStreamEvent, Error>.Continuation] = []
    private var cancelledRunIDsValue: [String] = []
    private var approvalAnswersValue: [(id: String, allow: Bool)] = []
    private var toolAnswersValue: [(id: String, isError: Bool)] = []
    private var resumeCallsValue: [(runID: String, after: Int)] = []
    private var startedRunIDsValue: [String] = []
    private var startedRequestsValue: [RunRequest] = []
    private var statusRunIDsValue: [String] = []
    var cancelError: Error?
    var resumeError: Error?
    var statusError: Error?
    var startError: Error?
    var probeError: Error?
    var probeGate: PatchGate?
    var messagePage = MessagePage(messages: [], before: nil)
    private var stateCallsValue = 0

    init(snapshot: MobileRunSnapshot, startGate: StartRunGate? = nil, state: ReinState? = nil, patchGate: PatchGate? = nil) {
        self.snapshotValue = snapshot
        self.startGate = startGate
        self.patchGate = patchGate
        if let state { self.stateValue = state }
    }

    var stateCalls: Int { lock.withLock { stateCallsValue } }
    var cancelledRunIDs: [String] { lock.withLock { cancelledRunIDsValue } }
    var approvalAnswers: [(id: String, allow: Bool)] { lock.withLock { approvalAnswersValue } }
    var toolAnswers: [(id: String, isError: Bool)] { lock.withLock { toolAnswersValue } }
    var resumeCalls: [(runID: String, after: Int)] { lock.withLock { resumeCallsValue } }
    var startedRunIDs: [String] { lock.withLock { startedRunIDsValue } }
    var startedRequests: [RunRequest] { lock.withLock { startedRequestsValue } }
    var statusRunIDs: [String] { lock.withLock { statusRunIDsValue } }

    func queueStatusSnapshots(_ snapshots: [MobileRunSnapshot]) {
        lock.withLock { queuedStatusValues.append(contentsOf: snapshots) }
    }

    func gateNextState(_ gate: StateGate) {
        lock.withLock { nextStateGate = gate }
    }

    func gateNextStatus(_ gate: StatusGate) {
        lock.withLock { nextStatusGate = gate }
    }

    func probe() async throws {
        if let probeGate { await probeGate.waitForRelease() }
        if let probeError { throw probeError }
    }

    func state() async throws -> ReinState {
        lock.withLock { stateCallsValue += 1 }
        let gate = lock.withLock { () -> StateGate? in
            defer { nextStateGate = nil }
            return nextStateGate
        }
        if let gate { return await gate.waitForValue() }
        return lock.withLock { stateValue }
    }
    func bots() async throws -> [ReinBot] { lock.withLock { stateValue.bots } }
    func messages(botID: String, before: Int?) async throws -> MessagePage { messagePage }
    func createBot(name: String, avatar: String?) async throws -> ReinBot {
        let bot = ReinBot(id: "new-bot", name: name, sessionId: "new-thread", avatar: avatar)
        lock.withLock { stateValue.bots.append(bot) }
        return bot
    }
    func updateBotAvatar(botID: String, avatar: String) async throws -> ReinBot {
        try lock.withLock {
            guard let index = stateValue.bots.firstIndex(where: { $0.id == botID }) else { throw GatewayClientError.invalidResponse }
            stateValue.bots[index].avatar = avatar
            return stateValue.bots[index]
        }
    }
    func patchShell(_ patch: [ShellPatch]) async throws -> ReinState {
        if let patchGate { await patchGate.waitForRelease() }
        return lock.withLock { stateValue }
    }
    func setPreference(lastBotID: String) async throws -> ReinState { lock.withLock { stateValue } }

    func startRun(_ request: RunRequest) async throws -> MobileRunReceipt {
        lock.withLock {
            startedRunIDsValue.append(request.runId)
            startedRequestsValue.append(request)
        }
        if let startGate { return try await startGate.waitForResult() }
        if let startError { throw startError }
        return .init(runId: snapshotValue.id, status: snapshotValue.status, eventsUrl: "/events", statusUrl: "/status")
    }

    func resume(runID: String, after: Int) -> AsyncThrowingStream<RunStreamEvent, Error> {
        let error = lock.withLock { () -> Error? in
            resumeCallsValue.append((runID, after))
            return resumeError
        }
        return AsyncThrowingStream { continuation in
            if let error { continuation.finish(throwing: error); return }
            self.lock.withLock { self.resumeContinuations.append(continuation) }
        }
    }

    func cancel(runID: String) async throws {
        let error = lock.withLock { () -> Error? in
            cancelledRunIDsValue.append(runID)
            return cancelError
        }
        if let error { throw error }
    }

    func answerTool(runID: String, callID: String, result: String, isError: Bool) async throws {
        lock.withLock {
            toolAnswersValue.append((callID, isError))
            snapshotValue = replacingPending(snapshotValue.pending.filter { $0.id != callID })
        }
    }

    func answerApproval(runID: String, approvalID: String, allow: Bool) async throws {
        lock.withLock {
            approvalAnswersValue.append((approvalID, allow))
            snapshotValue = replacingPending(snapshotValue.pending.filter { $0.id != approvalID })
        }
    }

    func runStatus(runID: String) async throws -> MobileRunSnapshot {
        let result = lock.withLock { () -> (StatusGate?, MobileRunSnapshot, Error?) in
            statusRunIDsValue.append(runID)
            let gate = nextStatusGate
            nextStatusGate = nil
            let snapshot = queuedStatusValues.isEmpty ? snapshotValue : queuedStatusValues.removeFirst()
            return (gate, snapshot, statusError)
        }
        if let gate = result.0 { return await gate.waitForValue() }
        if let error = result.2 { throw error }
        return result.1
    }

    private func replacingPending(_ pending: [MobilePendingAction]) -> MobileRunSnapshot {
        .init(
            id: snapshotValue.id,
            threadId: snapshotValue.threadId,
            status: pending.isEmpty ? "running" : "waiting",
            createdAt: snapshotValue.createdAt,
            updatedAt: snapshotValue.updatedAt,
            completedAt: snapshotValue.completedAt,
            error: snapshotValue.error,
            oldestSequence: snapshotValue.oldestSequence,
            lastSequence: snapshotValue.lastSequence,
            pending: pending
        )
    }
}

private final class TestSecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func read(account: String) throws -> String? { lock.withLock { values[account] } }
    func write(_ value: String, account: String) throws { lock.withLock { values[account] = value } }
    func delete(account: String) throws { _ = lock.withLock { values.removeValue(forKey: account) } }
}

private final class TestSoundPreferenceStore: SoundPreferenceStore, @unchecked Sendable {
    func enabled() -> Bool { false }
    func setEnabled(_ enabled: Bool) {}
}

@MainActor
private final class TestPendingRunRequestStore: PendingRunRequestStorage {
    private var records: [String: (request: RunRequest, createdAt: Date)] = [:]
    var saveError: Error?

    func load(for origin: URL, now: Date) throws -> PendingRunRequestLoadResult {
        guard let record = records[origin.absoluteString] else { return .none }
        if now.timeIntervalSince(record.createdAt) > 24 * 60 * 60 {
            records.removeValue(forKey: origin.absoluteString)
            return .expired(runID: record.request.runId)
        }
        return .pending(record.request)
    }

    func save(_ request: RunRequest, for origin: URL, now: Date) throws {
        if let saveError { throw saveError }
        records[origin.absoluteString] = (request, now)
    }

    func remove(runID: String, for origin: URL) throws {
        guard records[origin.absoluteString]?.request.runId == runID else { return }
        records.removeValue(forKey: origin.absoluteString)
    }

    func removeAll(for origin: URL) throws {
        records.removeValue(forKey: origin.absoluteString)
    }

    func request(for origin: String) -> RunRequest? {
        records[origin]?.request
    }
}

private final class StoreDirectMockClient: DirectModelClientProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var received: [DirectChatMessage] = []
    var receivedMessages: [DirectChatMessage] { lock.withLock { received } }
    func complete(account: CloudAccount, apiKey: String?, messages: [DirectChatMessage]) async throws -> DirectChatResult {
        lock.withLock { received = messages }
        return .init(text: "Fixture direct reply.", finishReason: "stop")
    }
}
