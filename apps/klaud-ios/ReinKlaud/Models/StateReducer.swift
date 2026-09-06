import Foundation

enum StateReducerError: Error, Equatable { case invalidPatch }

enum StateReducer {
    static func apply(event: GatewayEvent, state: inout ReinState, messages: inout [ReinMessage]) throws {
        switch event.type {
        case "STATE_SNAPSHOT": if let snapshot = event.snapshot { state = snapshot }
        case "STATE_DELTA":
            guard let values = event.delta?.arrayValue else { throw StateReducerError.invalidPatch }
            for value in values { try applyPatch(value, state: &state) }
        case "TEXT_MESSAGE_START":
            if let id = event.messageId, !messages.contains(where: { $0.id == id }) { messages.append(.init(id: id, role: .assistant, content: "")) }
        case "TEXT_MESSAGE_CONTENT":
            guard let id = event.messageId, let delta = event.textDelta else { throw StateReducerError.invalidPatch }
            if let index = messages.firstIndex(where: { $0.id == id }) { messages[index].content += delta }
            else { messages.append(.init(id: id, role: .assistant, content: delta)) }
        case "TOOL_CALL_START":
            guard let callID = event.toolCallId else { throw StateReducerError.invalidPatch }
            let message = ReinMessage(id: "tool-\(callID)", role: .tool, content: "Calling \(event.toolCallName ?? "tool")…")
            upsert(message, into: &messages)
        case "TOOL_CALL_RESULT":
            guard let callID = event.toolCallId else { throw StateReducerError.invalidPatch }
            let message = ReinMessage(id: "tool-\(callID)", role: .tool, content: event.textContent ?? "")
            upsert(message, into: &messages)
        case "RUN_FINISHED":
            guard event.outcome?.type == "success", let index = messages.lastIndex(where: { $0.role == .assistant }) else { break }
            let reasoning = event.outcome?.reasoningTokens.flatMap { $0 > 0 ? $0 : nil }
            messages[index].completion = .init(stopReason: event.outcome?.stopReason, reasoningTokens: reasoning)
        default: break
        }
    }

    private static func upsert(_ message: ReinMessage, into messages: inout [ReinMessage]) {
        if let index = messages.firstIndex(where: { $0.id == message.id }) { messages[index] = message }
        else { messages.append(message) }
    }

    private static func applyPatch(_ raw: JSONValue, state: inout ReinState) throws {
        guard let object = raw.objectValue, let op = object["op"]?.stringValue, let path = object["path"]?.stringValue,
              ["add", "replace", "test"].contains(op), let value = object["value"] else { throw StateReducerError.invalidPatch }
        func check<T: Equatable>(_ current: T, _ proposed: T) throws { if op == "test" && current != proposed { throw StateReducerError.invalidPatch } }
        switch path {
        case "/shell/theme/accent": guard let next = value.stringValue, ["rain", "slate", "storm"].contains(next) else { throw StateReducerError.invalidPatch }; try check(state.shell.theme.accent, next); if op != "test" { state.shell.theme.accent = next }
        case "/shell/theme/density": guard let next = value.stringValue, ["compact", "regular", "roomy"].contains(next) else { throw StateReducerError.invalidPatch }; try check(state.shell.theme.density, next); if op != "test" { state.shell.theme.density = next }
        case "/shell/theme/dark": guard let next = value.boolValue else { throw StateReducerError.invalidPatch }; try check(state.shell.theme.dark, next); if op != "test" { state.shell.theme.dark = next }
        case "/shell/chrome/sidebar": guard let next = value.boolValue else { throw StateReducerError.invalidPatch }; try check(state.shell.chrome.sidebar, next); if op != "test" { state.shell.chrome.sidebar = next }
        case "/shell/chrome/tray": guard let next = value.stringValue, ["hidden", "quiet", "normal"].contains(next) else { throw StateReducerError.invalidPatch }; try check(state.shell.chrome.tray, next); if op != "test" { state.shell.chrome.tray = next }
        case "/shell/chrome/showActivity": guard let next = value.boolValue else { throw StateReducerError.invalidPatch }; try check(state.shell.chrome.showActivity, next); if op != "test" { state.shell.chrome.showActivity = next }
        default: throw StateReducerError.invalidPatch
        }
    }
}
