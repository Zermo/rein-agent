import XCTest
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
            "protocolVersion": 1,
            "action": "sendAck",
            "botId": "bot-1",
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
            "protocolVersion": 1,
            "action": "sendAck",
            "botId": "bot-1",
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
            "protocolVersion": 1,
            "action": "sendAck",
            "botId": "bot-1",
            "sessionId": "session-1",
            "requestId": try XCTUnwrap(send["requestId"] as? String),
            "revision": try XCTUnwrap(send["revision"] as? Int),
            "accepted": false,
        ])

        XCTAssertFalse(bridge.composerSubmitting)
        bridge.submitComposer()
        XCTAssertEqual(commands.filter { $0["action"] as? String == "send" }.count, 2)
    }

    func testBotSwitchRestoresEachScopedDraft() {
        let bridge = makeReadyBridge(draft: "one")
        bridge.commandSink = { _ in }
        bridge.setComposerDraft("bot one draft")
        bridge.receiveComposerMessage(state(bot: "bot-2", session: "session-2", draft: "two"))
        bridge.setComposerDraft("bot two draft")
        bridge.receiveComposerMessage(state(bot: "bot-1", session: "session-1", draft: ""))

        XCTAssertEqual(bridge.composerText, "bot one draft")
    }

    func testComposerScopeChangeStopsActiveDictationTracking() {
        let bridge = makeReadyBridge(draft: "bot one")
        let editor = KlaudComposerTextView()
        editor.text = bridge.composerText
        editor.selectedRange = NSRange(location: 7, length: 0)
        bridge.beginDictationTracking(in: editor)
        XCTAssertTrue(bridge.dictationActive)

        bridge.receiveComposerMessage(state(bot: "bot-2", session: "session-2", draft: "bot two"))

        XCTAssertFalse(bridge.dictationActive)
        XCTAssertEqual(bridge.composerText, "bot two")
    }

    func testBusyStateStopsActiveDictationTracking() {
        let bridge = makeReadyBridge(draft: "draft")
        let editor = KlaudComposerTextView()
        editor.text = bridge.composerText
        bridge.beginDictationTracking(in: editor)
        var busyState = state(bot: "bot-1", session: "session-1", draft: "draft")
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

    func testProgrammaticEditorUpdateDoesNotRemainLatched() {
        let editor = KlaudComposerTextView()

        editor.performProgrammaticUpdate {
            XCTAssertTrue(editor.isApplyingProgrammaticUpdate)
            editor.text = "updated"
        }

        XCTAssertFalse(editor.isApplyingProgrammaticUpdate)
        XCTAssertEqual(editor.text, "updated")
    }

    func testRefinedDraftIsRejectedAfterManualEdit() {
        let bridge = makeReadyBridge(draft: "original")
        let snapshot = bridge.currentDraftSnapshot()

        bridge.setComposerDraft("operator edit")
        bridge.applyRefinedDraft("model edit", from: snapshot)

        XCTAssertEqual(bridge.composerText, "operator edit")
        XCTAssertEqual(bridge.localInference.status, "Draft changed; refinement was not applied")
    }

    func testRefinedDraftIsRejectedAfterScopeChange() {
        let bridge = makeReadyBridge(draft: "one")
        let snapshot = bridge.currentDraftSnapshot()

        bridge.receiveComposerMessage(state(bot: "bot-2", session: "session-2", draft: "two"))
        bridge.applyRefinedDraft("stale", from: snapshot)

        XCTAssertEqual(bridge.composerText, "two")
        XCTAssertEqual(bridge.localInference.status, "Draft changed; refinement was not applied")
    }

    func testLocalInferenceRejectsEmptyAndOversizedDrafts() {
        XCTAssertThrowsError(try KlaudLocalInference.preparedDraft("  \n ")) { error in
            XCTAssertEqual(error as? KlaudLocalInference.LocalError, .emptyDraft)
        }
        let oversized = String(repeating: "x", count: KlaudLocalInference.maximumDraftBytes + 1)
        XCTAssertThrowsError(try KlaudLocalInference.preparedDraft(oversized)) { error in
            XCTAssertEqual(
                error as? KlaudLocalInference.LocalError,
                .draftTooLong(maximumBytes: KlaudLocalInference.maximumDraftBytes)
            )
        }
    }

    func testLocalInferenceTrimsPreparedDraft() throws {
        XCTAssertEqual(try KlaudLocalInference.preparedDraft("  keep this  \n"), "keep this")
    }

    private func makeReadyBridge(draft: String) -> KlaudBridge {
        let bridge = KlaudBridge()
        bridge.receiveComposerMessage(state(bot: "bot-1", session: "session-1", draft: draft))
        return bridge
    }

    private func state(bot: String, session: String, draft: String) -> [String: Any] {
        [
            "kind": "composer",
            "protocolVersion": 1,
            "action": "state",
            "visible": true,
            "botId": bot,
            "sessionId": session,
            "enabled": true,
            "busy": false,
            "draft": draft,
        ]
    }
}
