import Foundation
import CoreFoundation
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
    private(set) var epoch = 0
    private(set) var navigationInProgress = true
    private(set) var committedNonce: String?

    mutating func beginNavigation() {
        epoch &+= 1
        navigationInProgress = true
        committedNonce = nil
    }

    mutating func failNavigation() {
        navigationInProgress = false
        committedNonce = nil
    }

    func accepts(_ body: [String: Any], capturedEpoch: Int) -> Bool {
        guard capturedEpoch == epoch, !navigationInProgress,
              let nonce = body["documentNonce"] as? String else { return false }
        return !nonce.isEmpty && nonce == committedNonce
    }

    func receiveComposer(_ body: [String: Any], capturedEpoch: Int) -> [String: Any]? {
        accepts(body, capturedEpoch: capturedEpoch) ? body : nil
    }

    @discardableResult
    mutating func commit(nonce: String, capturedEpoch: Int) -> Bool {
        guard capturedEpoch == epoch, navigationInProgress,
              KlaudComposerContract.identifier(nonce) != nil else { return false }
        committedNonce = nonce
        navigationInProgress = false
        return true
    }
}

enum KlaudComposerContract {
    static let version = 2
    static let capability = "composer.v2"
    static let eventName = "klaud-native-composer-command"
    static let allowedHosts: Set<String> = ["openbot.zermo.org", "reinklaud.zermo.org"]
    static let maximumUTF8Count = 128 * 1024

    static func trusts(scheme: String, host: String, port: Int, isMainFrame: Bool) -> Bool {
        isMainFrame && scheme.lowercased() == "https" &&
            allowedHosts.contains(host.lowercased()) && (port == 0 || port == 443)
    }

    static func trusts(_ message: WKScriptMessage) -> Bool {
        let origin = message.frameInfo.securityOrigin
        return trusts(scheme: origin.protocol, host: origin.host, port: origin.port,
                      isMainFrame: message.frameInfo.isMainFrame)
    }

    static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              let integer = Int(exactly: number.doubleValue),
              (0...9_007_199_254_740_991).contains(integer) else { return nil }
        return integer
    }

    static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    static func identifier(_ value: Any?) -> String? {
        guard let value = value as? String, value.utf8.count <= 160,
              value.range(of: #"\A[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}\z"#, options: .regularExpression) != nil else { return nil }
        return value
    }

    static func scope(from body: [String: Any]) -> KlaudComposerScope? {
        guard let botID = body["botId"] as? String,
              botID.range(of: #"\Aklaud-bot-[0-9a-f]{8}\z"#, options: .regularExpression) != nil,
              let sessionID = identifier(body["sessionId"]) else { return nil }
        return KlaudComposerScope(botID: botID, sessionID: sessionID)
    }
}
