import Foundation
import Darwin

enum ConnectionValidationError: LocalizedError, Equatable {
    case missingURL, unsupportedScheme, credentialsInURL, unsupportedComponents, insecurePublicHost, invalidToken

    var errorDescription: String? {
        switch self {
        case .missingURL: "Enter the Rein gateway URL."
        case .unsupportedScheme: "Use HTTPS, or HTTP for a private network address."
        case .credentialsInURL: "Put the bearer token in its own field."
        case .unsupportedComponents: "Use a gateway origin without a path, query, or fragment."
        case .insecurePublicHost: "Plain HTTP is allowed only on loopback or a private LAN/mesh address."
        case .invalidToken: "Enter a bearer token without spaces or control characters."
        }
    }
}

struct GatewayConnection: Codable, Equatable, Sendable {
    let baseURL: URL
    let token: String
}

enum ConnectionValidator {
    static func validate(url rawURL: String, token: String) throws -> GatewayConnection {
        guard let components = URLComponents(string: rawURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(),
              components.url != nil else { throw ConnectionValidationError.missingURL }
        guard scheme == "https" || scheme == "http" else { throw ConnectionValidationError.unsupportedScheme }
        guard components.user == nil && components.password == nil else { throw ConnectionValidationError.credentialsInURL }
        guard (components.path.isEmpty || components.path == "/"), components.query == nil, components.fragment == nil else {
            throw ConnectionValidationError.unsupportedComponents
        }
        if containsIPv6Scope(host), !isPrivate(host: host) { throw ConnectionValidationError.insecurePublicHost }
        if scheme == "http" && !isPrivate(host: host) { throw ConnectionValidationError.insecurePublicHost }
        guard token.utf8.count >= 24, token.utf8.count <= 512,
              token.unicodeScalars.allSatisfy({ $0.value >= 0x21 && $0.value <= 0x7e }) else {
            throw ConnectionValidationError.invalidToken
        }
        var clean = components
        clean.path = ""; clean.query = nil; clean.fragment = nil
        if (scheme == "https" && clean.port == 443) || (scheme == "http" && clean.port == 80) { clean.port = nil }
        guard let origin = clean.url else { throw ConnectionValidationError.missingURL }
        return GatewayConnection(baseURL: origin, token: token)
    }

    static func isPrivate(host: String) -> Bool {
        let normalized = host.lowercased()
        if normalized == "localhost" || normalized.hasSuffix(".local") { return true }

        guard let bare = unbracketed(normalized) else { return false }
        if let bytes = parseIPv4(bare) { return isPrivateIPv4(bytes) }
        guard let scoped = splitIPv6Scope(bare), let bytes = parseIPv6(scoped.address) else { return false }
        if scoped.zone != nil { return isLinkLocalIPv6(bytes) }
        return isPrivateIPv6(bytes)
    }

    private static func unbracketed(_ host: String) -> String? {
        let hasOpeningBracket = host.hasPrefix("[")
        let hasClosingBracket = host.hasSuffix("]")
        guard hasOpeningBracket == hasClosingBracket else { return nil }
        return hasOpeningBracket ? String(host.dropFirst().dropLast()) : host
    }

    private static func containsIPv6Scope(_ host: String) -> Bool {
        unbracketed(host)?.contains("%") == true
    }

    private static func splitIPv6Scope(_ host: String) -> (address: String, zone: String?)? {
        let pieces = host.split(separator: "%", omittingEmptySubsequences: false)
        guard pieces.count <= 2 else { return nil }
        guard pieces.count == 2 else { return (host, nil) }
        let zone = String(pieces[1])
        guard !zone.isEmpty, zone.utf8.count <= 64,
              zone.utf8.allSatisfy({ byte in
                  (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) ||
                      byte == 45 || byte == 46 || byte == 95
              }) else { return nil }
        return (String(pieces[0]), zone)
    }

    private static func parseIPv4(_ host: String) -> [UInt8]? {
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count == 4 else { return nil }
        var bytes: [UInt8] = []
        bytes.reserveCapacity(4)
        for label in labels {
            guard !label.isEmpty, label.count <= 3,
                  label.utf8.allSatisfy({ (48...57).contains($0) }),
                  label.count == 1 || label.first != "0",
                  let value = UInt8(label) else { return nil }
            bytes.append(value)
        }
        return bytes
    }

    private static func parseIPv6(_ host: String) -> [UInt8]? {
        var address = in6_addr()
        guard host.withCString({ inet_pton(AF_INET6, $0, &address) }) == 1 else { return nil }
        return withUnsafeBytes(of: &address) { Array($0) }
    }

    private static func isPrivateIPv4(_ bytes: [UInt8]) -> Bool {
        guard bytes.count == 4 else { return false }
        return bytes[0] == 10 || bytes[0] == 127 || bytes[0] == 192 && bytes[1] == 168 ||
            bytes[0] == 172 && (16...31).contains(bytes[1]) || bytes[0] == 169 && bytes[1] == 254 ||
            bytes[0] == 100 && (64...127).contains(bytes[1])
    }

    private static func isPrivateIPv6(_ bytes: [UInt8]) -> Bool {
        guard bytes.count == 16 else { return false }
        let isLoopback = bytes.dropLast().allSatisfy { $0 == 0 } && bytes[15] == 1
        let isUniqueLocal = bytes[0] & 0xfe == 0xfc
        let isIPv4Mapped = bytes.prefix(10).allSatisfy { $0 == 0 } && bytes[10] == 0xff && bytes[11] == 0xff
        return isLoopback || isUniqueLocal || isLinkLocalIPv6(bytes) ||
            isIPv4Mapped && isPrivateIPv4(Array(bytes.suffix(4)))
    }

    private static func isLinkLocalIPv6(_ bytes: [UInt8]) -> Bool {
        bytes.count == 16 && bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80
    }
}
