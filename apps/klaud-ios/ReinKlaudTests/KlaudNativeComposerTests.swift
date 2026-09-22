import XCTest
import UIKit
@testable import ReinKlaud

@MainActor
final class KlaudNativeComposerTests: XCTestCase {
    func testInsertTextReplacesTheSelectedRange() {
        let editor = KlaudComposerTextView()
        editor.isEditable = true
        editor.text = "ask old now"
        editor.selectedRange = NSRange(location: 4, length: 3)

        editor.insertText("new")

        XCTAssertEqual(editor.text, "ask new now")
        XCTAssertEqual(editor.selectedRange, NSRange(location: 7, length: 0))
    }

    func testDeleteBackwardDeletesSelectionBeforeSingleGlyph() {
        let editor = KlaudComposerTextView()
        editor.isEditable = true
        editor.text = "send this draft"
        editor.selectedRange = NSRange(location: 5, length: 5)

        editor.deleteBackward()
        XCTAssertEqual(editor.text, "send draft")
        XCTAssertEqual(editor.selectedRange, NSRange(location: 5, length: 0))

        editor.deleteBackward()
        XCTAssertEqual(editor.text, "senddraft")
        XCTAssertEqual(editor.selectedRange, NSRange(location: 4, length: 0))
    }

    func testNativeComposerUsesSingleRowAndVintageCaretMetrics() {
        XCTAssertEqual(KlaudNativeComposerStyle.editorHeight, 44)
        XCTAssertEqual(KlaudNativeComposerStyle.caretWidth, 7)

        let editor = KlaudComposerTextView(frame: CGRect(x: 0, y: 0, width: 240, height: 44))
        editor.isEditable = true
        editor.text = "field note"
        editor.selectedRange = NSRange(location: (editor.text as NSString).length, length: 0)
        editor.layoutIfNeeded()

        XCTAssertEqual(editor.caretRect(for: editor.endOfDocument).width, 7)
    }

    func testCRTKeyboardOmitsTheSystemKeyboardSwitcher() {
        let keyboard = KlaudKeyboardInputView { _ in }
        let labels = buttons(in: keyboard).compactMap { $0.accessibilityLabel }

        XCTAssertFalse(labels.contains("System Keyboard"))
        XCTAssertFalse(labels.contains("🌐"))
    }

    func testBridgeRequiresTrustedHTTPSMainFrame() {
        XCTAssertTrue(KlaudComposerContract.trusts(
            scheme: "https", host: "openbot.zermo.org", port: 443, isMainFrame: true
        ))
        XCTAssertFalse(KlaudComposerContract.trusts(
            scheme: "https", host: "auth.zermo.org", port: 443, isMainFrame: true
        ))
        XCTAssertFalse(KlaudComposerContract.trusts(
            scheme: "https", host: "openbot.zermo.org", port: 443, isMainFrame: false
        ))
        XCTAssertFalse(KlaudComposerContract.trusts(
            scheme: "http", host: "openbot.zermo.org", port: 80, isMainFrame: true
        ))
    }

    func testDocumentNonceRejectsLateMessagesFromPreviousNavigation() {
        var gate = KlaudDocumentBridgeGate()
        gate.beginNavigation()
        let currentEpoch = gate.epoch
        let old = ["documentNonce": "old-document", "draft": "stale"]
        let current = ["documentNonce": "current-document", "draft": "fresh"]

        XCTAssertNil(gate.receiveComposer(old, capturedEpoch: currentEpoch))
        XCTAssertNil(gate.receiveComposer(current, capturedEpoch: currentEpoch))
        let committed = gate.commit(nonce: "current-document", capturedEpoch: currentEpoch)

        XCTAssertTrue(committed) // No precommit command is replayed; the document must send again.
        XCTAssertNil(gate.receiveComposer(old, capturedEpoch: currentEpoch))
        XCTAssertEqual(
            gate.receiveComposer(current, capturedEpoch: currentEpoch)?["draft"] as? String,
            "fresh"
        )
    }

    func testDocumentNonceRejectsMessagesCapturedBeforeNewNavigation() {
        var gate = KlaudDocumentBridgeGate()
        gate.beginNavigation()
        let oldEpoch = gate.epoch
        gate.beginNavigation()

        XCTAssertNil(gate.receiveComposer(
            ["documentNonce": "old-document"],
            capturedEpoch: oldEpoch
        ))
    }

    func testDelayedSendAcknowledgementDoesNotEraseNewerTyping() throws {
        let bridge = makeReadyBridge(draft: "first")
        var commands: [[String: Any]] = []
        bridge.commandSink = { commands.append($0) }

        bridge.setComposerDraft("first revision")
        bridge.submitComposer()
        let send = try XCTUnwrap(commands.last { $0["action"] as? String == "send" })
        let requestID = try XCTUnwrap(send["requestId"] as? String)
        let revision = try XCTUnwrap(send["revision"] as? Int)

        bridge.setComposerDraft("first revision plus newer typing")
        bridge.receiveComposerMessage([
            "kind": "composer",
            "protocolVersion": KlaudComposerContract.version,
            "documentNonce": "fixture-document",
            "action": "sendAck",
            "botId": "klaud-bot-1234abcd",
            "sessionId": "session-1",
            "requestId": requestID,
            "revision": revision,
            "accepted": true,
        ])

        XCTAssertEqual(bridge.composerText, "first revision plus newer typing")
    }

    func testAcknowledgedCurrentRevisionClearsComposer() throws {
        let bridge = makeReadyBridge(draft: "first")
        var commands: [[String: Any]] = []
        bridge.commandSink = { commands.append($0) }

        bridge.setComposerDraft("send exactly this")
        bridge.submitComposer()
        let send = try XCTUnwrap(commands.last { $0["action"] as? String == "send" })

        bridge.receiveComposerMessage([
            "kind": "composer",
            "protocolVersion": KlaudComposerContract.version,
            "documentNonce": "fixture-document",
            "action": "sendAck",
            "botId": "klaud-bot-1234abcd",
            "sessionId": "session-1",
            "requestId": try XCTUnwrap(send["requestId"] as? String),
            "revision": try XCTUnwrap(send["revision"] as? Int),
            "accepted": true,
        ])

        XCTAssertEqual(bridge.composerText, "")
        XCTAssertEqual(commands.last?["action"] as? String, "draft")
        XCTAssertEqual(commands.last?["text"] as? String, "")
    }

    func testDuplicateSubmitIsLatchedUntilAcknowledgement() {
        let bridge = makeReadyBridge(draft: "send once")
        var commands: [[String: Any]] = []
        bridge.commandSink = { commands.append($0) }

        bridge.submitComposer()
        bridge.submitComposer()

        XCTAssertTrue(bridge.composerSubmitting)
        XCTAssertEqual(commands.filter { $0["action"] as? String == "send" }.count, 1)
    }

    func testRejectedAcknowledgementReleasesSubmitLatch() throws {
        let bridge = makeReadyBridge(draft: "retry me")
        var commands: [[String: Any]] = []
        bridge.commandSink = { commands.append($0) }
        bridge.submitComposer()
        let send = try XCTUnwrap(commands.last)

        bridge.receiveComposerMessage([
            "kind": "composer",
            "protocolVersion": KlaudComposerContract.version,
            "documentNonce": "fixture-document",
            "action": "sendAck",
            "botId": "klaud-bot-1234abcd",
            "sessionId": "session-1",
            "requestId": try XCTUnwrap(send["requestId"] as? String),
            "revision": try XCTUnwrap(send["revision"] as? Int),
            "accepted": false,
        ])

        XCTAssertFalse(bridge.composerSubmitting)
        bridge.submitComposer()
        XCTAssertEqual(commands.filter { $0["action"] as? String == "send" }.count, 2)
    }

    func testMismatchedAcknowledgementCannotDiscardPendingDelivery() throws {
        let bridge = makeReadyBridge(draft: "deliver once")
        var commands: [[String: Any]] = []
        bridge.commandSink = { commands.append($0) }
        bridge.submitComposer()
        let send = try XCTUnwrap(commands.last)
        let requestID = try XCTUnwrap(send["requestId"] as? String)
        let revision = try XCTUnwrap(send["revision"] as? Int)

        bridge.receiveComposerMessage([
            "kind": "composer",
            "protocolVersion": KlaudComposerContract.version,
            "documentNonce": "fixture-document",
            "action": "sendAck",
            "botId": "klaud-bot-1234abcd",
            "sessionId": "wrong-session",
            "requestId": requestID,
            "revision": revision,
            "accepted": false,
        ])
        XCTAssertTrue(bridge.composerSubmitting)

        bridge.receiveComposerMessage([
            "kind": "composer",
            "protocolVersion": KlaudComposerContract.version,
            "documentNonce": "fixture-document",
            "action": "sendAck",
            "botId": "klaud-bot-1234abcd",
            "sessionId": "session-1",
            "requestId": requestID,
            "revision": revision,
            "accepted": false,
        ])
        XCTAssertFalse(bridge.composerSubmitting)
    }

    func testScopeRoundTripKeepsPendingSendLatched() {
        let bridge = makeReadyBridge(draft: "send once")
        var commands: [[String: Any]] = []
        bridge.commandSink = { commands.append($0) }
        bridge.submitComposer()

        bridge.receiveComposerMessage(state(bot: "klaud-bot-5678abcd", session: "session-2", draft: "two"))
        bridge.receiveComposerMessage(state(bot: "klaud-bot-1234abcd", session: "session-1", draft: ""))
        bridge.submitComposer()

        XCTAssertTrue(bridge.composerSubmitting)
        XCTAssertEqual(bridge.composerText, "send once")
        XCTAssertEqual(commands.filter { $0["action"] as? String == "send" }.count, 1)
    }

    func testAcknowledgementClearsPendingDraftWhileAnotherScopeIsVisible() throws {
        let bridge = makeReadyBridge(draft: "deliver once")
        var commands: [[String: Any]] = []
        bridge.commandSink = { commands.append($0) }
        bridge.submitComposer()
        let send = try XCTUnwrap(commands.last)
        bridge.receiveComposerMessage(state(bot: "klaud-bot-5678abcd", session: "session-2", draft: "two"))

        bridge.receiveComposerMessage([
            "kind": "composer",
            "protocolVersion": KlaudComposerContract.version,
            "documentNonce": "fixture-document",
            "action": "sendAck",
            "botId": "klaud-bot-1234abcd",
            "sessionId": "session-1",
            "requestId": try XCTUnwrap(send["requestId"] as? String),
            "revision": try XCTUnwrap(send["revision"] as? Int),
            "accepted": true,
        ])
        bridge.receiveComposerMessage(state(bot: "klaud-bot-1234abcd", session: "session-1", draft: ""))

        XCTAssertFalse(bridge.composerSubmitting)
        XCTAssertEqual(bridge.composerText, "")
    }

    func testNavigationResetKeepsUnknownDeliveryLatched() {
        let bridge = makeReadyBridge(draft: "maybe delivered")
        var commands: [[String: Any]] = []
        bridge.commandSink = { commands.append($0) }
        bridge.submitComposer()

        bridge.resetComposerTransport()
        negotiate(bridge)
        bridge.receiveComposerMessage(state(bot: "klaud-bot-1234abcd", session: "session-1", draft: ""))
        bridge.submitComposer()

        XCTAssertTrue(bridge.composerSubmitting)
        XCTAssertTrue(bridge.composerDeliveryUncertain)
        XCTAssertEqual(commands.filter { $0["action"] as? String == "send" }.count, 1)
    }

    func testUnknownDeliveryRequiresExplicitRetryDecision() {
        let bridge = makeReadyBridge(draft: "retry only if asked")
        var commands: [[String: Any]] = []
        bridge.commandSink = { commands.append($0) }
        bridge.submitComposer()
        bridge.resetComposerTransport()
        negotiate(bridge)
        bridge.receiveComposerMessage(state(bot: "klaud-bot-1234abcd", session: "session-1", draft: ""))

        bridge.allowRetryAfterUnknownDelivery()
        bridge.submitComposer()

        XCTAssertFalse(bridge.composerDeliveryUncertain)
        XCTAssertTrue(bridge.composerSubmitting)
        XCTAssertEqual(commands.filter { $0["action"] as? String == "send" }.count, 2)
    }

    func testBusyStateCannotAcknowledgeUnknownDeliveryAfterNavigation() {
        let bridge = makeReadyBridge(draft: "accepted remotely")
        bridge.commandSink = { _ in }
        bridge.submitComposer()
        bridge.resetComposerTransport()
        negotiate(bridge)
        var acceptedState = state(bot: "klaud-bot-1234abcd", session: "session-1", draft: "")
        acceptedState["busy"] = true
        acceptedState["enabled"] = false

        bridge.receiveComposerMessage(acceptedState)

        XCTAssertTrue(bridge.composerSubmitting)
        XCTAssertTrue(bridge.composerDeliveryUncertain)
        XCTAssertEqual(bridge.composerText, "accepted remotely")
    }

    func testBotSwitchRestoresEachScopedDraft() {
        let bridge = makeReadyBridge(draft: "one")
        bridge.commandSink = { _ in }
        bridge.setComposerDraft("bot one draft")
        bridge.receiveComposerMessage(state(bot: "klaud-bot-5678abcd", session: "session-2", draft: "two"))
        bridge.setComposerDraft("bot two draft")
        bridge.receiveComposerMessage(state(bot: "klaud-bot-1234abcd", session: "session-1", draft: ""))

        XCTAssertEqual(bridge.composerText, "bot one draft")
    }

    func testHelloAcknowledgesWithoutAdoptingScopeOrDraft() {
        let bridge = KlaudBridge()
        var commands: [[String: Any]] = []
        bridge.commandSink = { commands.append($0) }
        negotiate(bridge)
        XCTAssertEqual(commands.last?["action"] as? String, "ready")
        XCTAssertEqual(commands.last?["documentNonce"] as? String, "fixture-document")
        XCTAssertFalse(bridge.composerVisible)
        XCTAssertEqual(bridge.composerText, "")
    }

    func testComposerScopeChangeStopsActiveDictationTracking() {
        let bridge = makeReadyBridge(draft: "bot one")
        let editor = KlaudComposerTextView()
        editor.text = bridge.composerText
        editor.selectedRange = NSRange(location: 7, length: 0)
        bridge.beginDictationTracking(in: editor)
        XCTAssertTrue(bridge.dictationActive)

        bridge.receiveComposerMessage(state(bot: "klaud-bot-5678abcd", session: "session-2", draft: "bot two"))

        XCTAssertFalse(bridge.dictationActive)
        XCTAssertEqual(bridge.composerText, "bot two")
    }

    func testBusyStateStopsActiveDictationTracking() {
        let bridge = makeReadyBridge(draft: "draft")
        let editor = KlaudComposerTextView()
        editor.text = bridge.composerText
        bridge.beginDictationTracking(in: editor)
        var busyState = state(bot: "klaud-bot-1234abcd", session: "session-1", draft: "draft")
        busyState["busy"] = true
        busyState["enabled"] = false

        bridge.receiveComposerMessage(busyState)

        XCTAssertFalse(bridge.dictationActive)
    }

    @MainActor
    func testSelectedTextIsReplacedAtNativeSelection() {
        let editor = KlaudComposerTextView()
        editor.text = "hello world"
        editor.selectedRange = NSRange(location: 6, length: 5)

        let inserted = editor.replaceText(in: editor.selectedRange, with: "there")

        XCTAssertEqual(editor.text, "hello there")
        XCTAssertEqual(inserted, NSRange(location: 6, length: 5))
        XCTAssertEqual(editor.selectedRange, NSRange(location: 11, length: 0))
    }

    @MainActor
    func testDictationPartialReplacementUsesUTF16Ranges() {
        let editor = KlaudComposerTextView()
        editor.text = "a🙂z"
        editor.selectedRange = NSRange(location: 1, length: 2)

        let inserted = editor.replaceText(in: editor.selectedRange, with: "word")

        XCTAssertEqual(editor.text, "awordz")
        XCTAssertEqual(inserted, NSRange(location: 1, length: 4))
        XCTAssertEqual(editor.selectedRange, NSRange(location: 5, length: 0))
    }

    private func makeReadyBridge(draft: String) -> KlaudBridge {
        let bridge = KlaudBridge()
        negotiate(bridge)
        bridge.receiveComposerMessage(state(bot: "klaud-bot-1234abcd", session: "session-1", draft: draft))
        return bridge
    }

    private func negotiate(_ bridge: KlaudBridge) {
        bridge.receiveComposerMessage([
            "protocolVersion": KlaudComposerContract.version,
            "documentNonce": "fixture-document",
            "action": "hello", "requestId": "hello-1",
            "botId": "klaud-bot-1234abcd", "sessionId": "session-1",
        ])
    }

    private func state(bot: String, session: String, draft: String) -> [String: Any] {
        [
            "kind": "composer",
            "protocolVersion": KlaudComposerContract.version,
            "documentNonce": "fixture-document",
            "action": "state",
            "visible": true,
            "botId": bot,
            "sessionId": session,
            "enabled": true,
            "busy": false,
            "draft": draft,
            "webRevision": 1,
        ]
    }

    private func buttons(in view: UIView) -> [UIButton] {
        let own = view as? UIButton
        return (own.map { [$0] } ?? []) + view.subviews.flatMap { buttons(in: $0) }
    }

}
