import Foundation
import WebKit

struct KlaudComposerScope: Hashable, Equatable {
    let botID: String
    let sessionID: String
}

struct KlaudPendingComposerSend: Equatable {
    let requestID: String
    let scope: KlaudComposerScope
    let revision: Int
    let text: String
}

struct KlaudDocumentBridgeGate {
    private static let maximumBufferedMessages = 64
    private(set) var epoch = 0
    private(set) var navigationInProgress = true
    private(set) var committedNonce: String?
    private var pendingComposerMessages: [String: [[String: Any]]] = [:]

    mutating func beginNavigation() {
        epoch &+= 1
        navigationInProgress = true
        committedNonce = nil
        pendingComposerMessages.removeAll()
    }

    mutating func failNavigation() {
        navigationInProgress = false
        committedNonce = nil
        pendingComposerMessages.removeAll()
    }

    func accepts(_ body: [String: Any], capturedEpoch: Int) -> Bool {
        guard capturedEpoch == epoch,
              !navigationInProgress,
              let nonce = body["documentNonce"] as? String else { return false }
        return !nonce.isEmpty && nonce == committedNonce
    }

    mutating func receiveComposer(
        _ body: [String: Any],
        capturedEpoch: Int
    ) -> [[String: Any]] {
        guard capturedEpoch == epoch,
              let nonce = body["documentNonce"] as? String,
              !nonce.isEmpty else { return [] }
        if navigationInProgress {
            var messages = pendingComposerMessages[nonce, default: []]
            if messages.count == Self.maximumBufferedMessages {
                messages.removeFirst()
            }
            messages.append(body)
            pendingComposerMessages[nonce] = messages
            return []
        }
        return nonce == committedNonce ? [body] : []
    }

    mutating func commit(
        nonce: String,
        capturedEpoch: Int
    ) -> [[String: Any]] {
        guard capturedEpoch == epoch,
              navigationInProgress,
              !nonce.isEmpty else { return [] }
        committedNonce = nonce
        navigationInProgress = false
        let pending = pendingComposerMessages[nonce] ?? []
        pendingComposerMessages.removeAll()
        return pending
    }
}

enum KlaudComposerContract {
    static let version = 1
    static let capability = "composer.v1"
    static let eventName = "klaud-native-composer-command"
    static let allowedHosts: Set<String> = ["openbot.zermo.org", "reinklaud.zermo.org"]
    static let maximumUTF8Count = 128 * 1024

    static func trusts(scheme: String, host: String, port: Int, isMainFrame: Bool) -> Bool {
        isMainFrame &&
            scheme.lowercased() == "https" &&
            allowedHosts.contains(host.lowercased()) &&
            (port == 0 || port == 443)
    }

    static func trusts(_ message: WKScriptMessage) -> Bool {
        let origin = message.frameInfo.securityOrigin
        return trusts(
            scheme: origin.protocol,
            host: origin.host,
            port: origin.port,
            isMainFrame: message.frameInfo.isMainFrame
        )
    }

    static func scope(from body: [String: Any]) -> KlaudComposerScope? {
        guard let botID = body["botId"] as? String, !botID.isEmpty,
              let sessionID = body["sessionId"] as? String, !sessionID.isEmpty else { return nil }
        return KlaudComposerScope(botID: botID, sessionID: sessionID)
    }
}
