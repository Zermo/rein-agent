import XCTest
@testable import ReinKlaud

final class StateReducerTests: XCTestCase {
    func testStreamsTextAndToolLedgerEntries() throws {
        var state = ReinState.empty, messages: [ReinMessage] = []
        try StateReducer.apply(event: event(#"{"type":"TEXT_MESSAGE_START","messageId":"m1"}"#), state: &state, messages: &messages)
        try StateReducer.apply(event: event(#"{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Fresh "}"#), state: &state, messages: &messages)
        try StateReducer.apply(event: event(#"{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"context"}"#), state: &state, messages: &messages)
        try StateReducer.apply(event: event(#"{"type":"TOOL_CALL_START","toolCallId":"t1","toolCallName":"bash"}"#), state: &state, messages: &messages)
        try StateReducer.apply(event: event(#"{"type":"TOOL_CALL_RESULT","toolCallId":"t1","content":"done"}"#), state: &state, messages: &messages)
        XCTAssertEqual(messages.map(\.role), [.assistant, .tool])
        XCTAssertEqual(messages[0].content, "Fresh context")
        XCTAssertEqual(messages[1].content, "done")
    }

    func testAppliesOnlyKnownValidatedShellDelta() throws {
        var state = ReinState.empty, messages: [ReinMessage] = []
        let backendPaths = ["/theme/dark", "/theme/accent", "/theme/density", "/chrome/sidebar", "/chrome/tray", "/chrome/showActivity"]
        XCTAssertEqual(backendPaths.map { "/shell" + $0 }, ["/shell/theme/dark", "/shell/theme/accent", "/shell/theme/density", "/shell/chrome/sidebar", "/shell/chrome/tray", "/shell/chrome/showActivity"])
        try StateReducer.apply(event: event(#"{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/shell/theme/dark","value":true},{"op":"replace","path":"/shell/theme/accent","value":"storm"},{"op":"replace","path":"/shell/theme/density","value":"roomy"},{"op":"replace","path":"/shell/chrome/sidebar","value":false},{"op":"replace","path":"/shell/chrome/tray","value":"quiet"},{"op":"replace","path":"/shell/chrome/showActivity","value":false}]}"#), state: &state, messages: &messages)
        XCTAssertTrue(state.shell.theme.dark)
        XCTAssertEqual(state.shell.theme.accent, "storm")
        XCTAssertEqual(state.shell.theme.density, "roomy")
        XCTAssertFalse(state.shell.chrome.sidebar)
        XCTAssertEqual(state.shell.chrome.tray, "quiet")
        XCTAssertFalse(state.shell.chrome.showActivity)
        XCTAssertThrowsError(try StateReducer.apply(event: event(#"{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/private/token","value":"bad"}]}"#), state: &state, messages: &messages))
    }

    func testRunFinishSurfacesOnlyReportedCompletionMetadata() throws {
        var state = ReinState.empty
        var messages = [ReinMessage(id: "m1", role: .assistant, content: "Done")]
        try StateReducer.apply(event: event(#"{"type":"RUN_FINISHED","outcome":{"type":"success","stopReason":"stop","reasoningTokens":347}}"#), state: &state, messages: &messages)
        XCTAssertEqual(messages[0].completion?.statusLabel, "COMPLETE · Reply ended")
        XCTAssertEqual(messages[0].completion?.reasoningLabel, "347 reasoning tokens (provider reported). Effort: not reported.")

        messages[0].completion = nil
        try StateReducer.apply(event: event(#"{"type":"RUN_FINISHED","outcome":{"type":"success","stopReason":"stop"}}"#), state: &state, messages: &messages)
        XCTAssertNil(messages[0].completion?.reasoningLabel)
    }

    private func event(_ json: String) throws -> GatewayEvent { try JSONDecoder().decode(GatewayEvent.self, from: Data(json.utf8)) }
}
