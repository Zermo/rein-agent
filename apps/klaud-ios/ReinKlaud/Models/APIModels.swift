import Foundation

struct ReinShell: Codable, Equatable, Sendable {
    struct Theme: Codable, Equatable, Sendable {
        var accent: String
        var density: String
        var dark: Bool
    }
    struct Chrome: Codable, Equatable, Sendable {
        var sidebar: Bool
        var tray: String
        var showActivity: Bool
    }
    var version: Int
    var theme: Theme
    var chrome: Chrome
}

struct ReinPreferences: Codable, Equatable, Sendable {
    var lastBotId: String?
}

struct ReinBot: Codable, Identifiable, Equatable, Hashable, Sendable {
    let id: String
    let name: String
    let sessionId: String
    var avatar: String? = nil
}

struct ReinApproval: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let tool: String
    let summary: String
}

struct ReinState: Codable, Equatable, Sendable {
    var shell: ReinShell
    var prefs: ReinPreferences
    var bots: [ReinBot]
    var approvals: [ReinApproval]
}

struct ToolFunction: Codable, Equatable, Sendable {
    let name: String
    let arguments: String
}

struct ToolCall: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let function: ToolFunction
}

struct ReinMessage: Codable, Identifiable, Equatable, Sendable {
    enum Role: String, Codable, Sendable { case user, assistant, tool }
    let id: String
    let role: Role
    var content: String
    var toolCalls: [ToolCall]?
    var completion: ReplyCompletion? = nil
}

struct ReplyCompletion: Codable, Equatable, Sendable {
    let stopReason: String?
    let reasoningTokens: Int?

    var statusLabel: String? {
        switch stopReason {
        case "stop": "COMPLETE · Reply ended"
        case "length": "LIMIT · Output limit reached"
        case "toolUse": "HANDOFF · Tool calls requested"
        case "error": "ERROR · Model error"
        case "aborted": "CANCELED · Reply canceled"
        case "budget": "PAUSED · Turn budget reached"
        default: nil
        }
    }

    var reasoningLabel: String? {
        guard let reasoningTokens, reasoningTokens > 0 else { return nil }
        return "\(reasoningTokens) reasoning tokens (provider reported). Effort: not reported."
    }
}

struct MessagePage: Codable, Equatable, Sendable {
    let messages: [ReinMessage]
    let before: Int?
}

struct ShellPatch: Codable, Equatable, Sendable {
    let op: String
    let path: String
    let value: JSONValue?
}

struct FrontendToolDeclaration: Codable, Equatable, Sendable {
    let name: String
    let description: String
    let parameters: JSONValue
}

struct RunRequest: Codable, Equatable, Sendable {
    let runId: String
    let threadId: String
    let botId: String
    let message: String
    let tools: [FrontendToolDeclaration]
}

struct ToolResultRequest: Codable, Sendable {
    let result: String
    let isError: Bool?
}

struct ApprovalRequest: Codable, Sendable { let allow: Bool }

struct MobileRunReceipt: Codable, Equatable, Sendable {
    let runId: String
    let status: String
    let eventsUrl: String
    let statusUrl: String
}

struct MobilePendingAction: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let kind: String
    let tool: String
    let summary: String
    let args: [String: JSONValue]?
}

struct MobileRunSnapshot: Codable, Equatable, Sendable {
    let id: String
    let threadId: String
    let status: String
    let createdAt: String
    let updatedAt: String
    let completedAt: String?
    let error: String?
    let oldestSequence: Int
    let lastSequence: Int
    let pending: [MobilePendingAction]

    var isTerminal: Bool { ["completed", "failed", "cancelled"].contains(status) }
}

struct GatewayEvent: Decodable, Equatable, Sendable {
    let type: String
    let runId: String?
    let threadId: String?
    let messageId: String?
    let role: String?
    let delta: JSONValue?
    let toolCallId: String?
    let toolCallName: String?
    let content: JSONValue?
    let name: String?
    let value: JSONValue?
    let message: String?
    let snapshot: ReinState?
    let outcome: GatewayRunOutcome?

    var textDelta: String? { delta?.stringValue }
    var textContent: String? { content?.stringValue }
}

struct GatewayRunOutcome: Decodable, Equatable, Sendable {
    let type: String
    let stopReason: String?
    let reasoningTokens: Int?
}

struct MobileEventEnvelope: Decodable, Equatable, Sendable {
    let sequence: Int
    let event: GatewayEvent
}

struct RunStreamEvent: Equatable, Sendable {
    let runID: String
    let sequence: Int
    let event: GatewayEvent
}

struct MobileRunDone: Decodable, Equatable, Sendable {
    let lastSequence: Int
    let status: String
}

extension ReinState {
    static let empty = ReinState(
        shell: ReinShell(version: 1, theme: .init(accent: "rain", density: "regular", dark: false), chrome: .init(sidebar: true, tray: "normal", showActivity: true)),
        prefs: ReinPreferences(lastBotId: nil), bots: [], approvals: []
    )
}
