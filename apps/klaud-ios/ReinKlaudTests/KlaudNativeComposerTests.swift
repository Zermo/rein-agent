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

    func testBotSwitchRestoresEachScopedDraft() {
        let bridge = makeReadyBridge(draft: "one")
        bridge.commandSink = { _ in }
        bridge.setComposerDraft("bot one draft")
        bridge.receiveComposerMessage(state(bot: "bot-2", session: "session-2", draft: "two"))
        bridge.setComposerDraft("bot two draft")
        bridge.receiveComposerMessage(state(bot: "bot-1", session: "session-1", draft: ""))

        XCTAssertEqual(bridge.composerText, "bot one draft")
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
