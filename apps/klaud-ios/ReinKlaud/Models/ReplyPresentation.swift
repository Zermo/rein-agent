import Foundation

enum ReplyPurpose: String, CaseIterable, Equatable, Sendable {
    case message = "MESSAGE"
    case result = "RESULT"
    case opinion = "OPINION"
    case choice = "CHOICE"
    case change = "CHANGE"
    case edit = "EDIT"
}

struct PresentedReply: Equatable, Sendable {
    let pending: Bool
    let purpose: ReplyPurpose
    let text: String
}

enum ReplyPresentation {
    private static let declared = ReplyPurpose.allCases.filter { $0 != .message }

    /// A purpose exists only when the model writes an exact standalone marker on line one.
    static func parse(_ text: String, final: Bool = true) -> PresentedReply {
        // Swift treats CRLF as one extended grapheme, so inspect its scalars.
        let newline = text.firstIndex { character in character.unicodeScalars.contains { $0.value == 0x0a } }
        let firstEnd = newline ?? text.endIndex
        let first = String(text[..<firstEnd]).trimmingSuffix("\r")
        if let purpose = declared.first(where: { first == "[\($0.rawValue)]" }), newline != nil || final {
            let body = newline.map { String(text[text.index(after: $0)...]) } ?? ""
            return .init(pending: false, purpose: purpose, text: body)
        }
        let pending = !final && newline == nil && declared.contains { "[\($0.rawValue)]".hasPrefix(text) || "[\($0.rawValue)]\r".hasPrefix(text) }
        return .init(pending: pending, purpose: .message, text: text)
    }
}

private extension String {
    func trimmingSuffix(_ suffix: Character) -> String {
        last == suffix ? String(dropLast()) : self
    }
}
