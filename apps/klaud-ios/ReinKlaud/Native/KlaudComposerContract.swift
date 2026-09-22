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
