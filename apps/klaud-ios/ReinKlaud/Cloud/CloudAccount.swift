import Foundation

enum CloudAccountValidationError: LocalizedError, Equatable {
    case invalidName
    case invalidModel
    case invalidEndpoint
    case insecureEndpoint
    case invalidLimits
    case invalidAPIKey

    var errorDescription: String? {
        switch self {
        case .invalidName:
            "Use an account name from 1 to 64 characters without control characters."
        case .invalidModel:
            "Enter the exact provider model ID, up to 256 characters."
        case .invalidEndpoint:
            "Use an API base URL without credentials, query text, or a fragment."
        case .insecureEndpoint:
            "Public API endpoints require HTTPS. HTTP is allowed only for a private LAN or mesh address."
        case .invalidLimits:
            "Choose context and output limits supported by the selected model."
        case .invalidAPIKey:
            "Use an API key without spaces or control characters."
        }
    }
}

enum CloudProvider: String, Codable, CaseIterable, Identifiable, Sendable {
    case custom
    case openai
    case anthropic
    case gemini
    case xai
    case openrouter

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .custom: "Custom / self-hosted"
        case .openai: "OpenAI"
        case .anthropic: "Anthropic"
        case .gemini: "Google Gemini"
        case .xai: "xAI"
        case .openrouter: "OpenRouter"
        }
    }

    var defaultBaseURL: URL? {
        switch self {
        case .custom: nil
        case .openai: URL(string: "https://api.openai.com/v1")!
        case .anthropic: URL(string: "https://api.anthropic.com/v1")!
        case .gemini: URL(string: "https://generativelanguage.googleapis.com/v1beta/openai")!
        case .xai: URL(string: "https://api.x.ai/v1")!
        case .openrouter: URL(string: "https://openrouter.ai/api/v1")!
        }
    }

    var apiKeyURL: URL? {
        switch self {
        case .custom: nil
        case .openai: URL(string: "https://platform.openai.com/api-keys")!
        case .anthropic: URL(string: "https://console.anthropic.com/settings/keys")!
        case .gemini: URL(string: "https://aistudio.google.com/app/apikey")!
        case .xai: URL(string: "https://console.x.ai/")!
        case .openrouter: URL(string: "https://openrouter.ai/settings/keys")!
        }
    }

    var usesAnthropicMessages: Bool { self == .anthropic }
    var requiresAPIKey: Bool { self != .custom }
}

struct CloudAccount: Codable, Identifiable, Equatable, Sendable {
    static let defaultContextTokenLimit = 32_768
    static let defaultMaxOutputTokens = 2_048
    static let maximumContextTokenLimit = 2_000_000
    static let maximumOutputTokens = 262_144

    let id: UUID
    var name: String
    var provider: CloudProvider
    var baseURL: URL
    var model: String
    var contextTokenLimit: Int
    var maxOutputTokens: Int

    init(
        id: UUID = UUID(),
        name: String,
        provider: CloudProvider,
        baseURL: URL? = nil,
        model: String,
        contextTokenLimit: Int = CloudAccount.defaultContextTokenLimit,
        maxOutputTokens: Int = CloudAccount.defaultMaxOutputTokens
    ) throws {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isPlainText(cleanName, maximum: 64) else { throw CloudAccountValidationError.invalidName }
        guard Self.isPlainText(cleanModel, maximum: 256) else { throw CloudAccountValidationError.invalidModel }
        guard contextTokenLimit >= 256,
              contextTokenLimit <= Self.maximumContextTokenLimit,
              maxOutputTokens >= 1,
              maxOutputTokens <= Self.maximumOutputTokens,
              maxOutputTokens < contextTokenLimit else {
            throw CloudAccountValidationError.invalidLimits
        }
        guard let candidate = baseURL ?? provider.defaultBaseURL else { throw CloudAccountValidationError.invalidEndpoint }

        self.id = id
        self.name = cleanName
        self.provider = provider
        self.baseURL = try Self.normalizedEndpoint(candidate.absoluteString, provider: provider)
        self.model = cleanModel
        self.contextTokenLimit = contextTokenLimit
        self.maxOutputTokens = maxOutputTokens
    }

    static func normalizedEndpoint(_ raw: String, provider: CloudProvider) throws -> URL {
        guard raw.utf8.count <= 2_048,
              !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw CloudAccountValidationError.invalidEndpoint
        }
        let input = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty,
              var components = URLComponents(string: input),
              let schemeValue = components.scheme?.lowercased(),
              let hostValue = components.host?.lowercased(),
              !hostValue.isEmpty,
              components.url != nil else {
            throw CloudAccountValidationError.invalidEndpoint
        }
        guard schemeValue == "https" || schemeValue == "http" else { throw CloudAccountValidationError.invalidEndpoint }
        guard components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else {
            throw CloudAccountValidationError.invalidEndpoint
        }
        if schemeValue == "http", !ConnectionValidator.isPrivate(host: hostValue) {
            throw CloudAccountValidationError.insecureEndpoint
        }

        components.scheme = schemeValue
        // URLComponents safely re-escapes scoped IPv6 hosts and IDNA names.
        components.host = hostValue
        if (schemeValue == "https" && components.port == 443) || (schemeValue == "http" && components.port == 80) {
            components.port = nil
        }

        var path = components.percentEncodedPath
        while path.count > 1, path.hasSuffix("/") { path.removeLast() }
        let terminalSuffixes = provider.usesAnthropicMessages
            ? ["/messages", "/models"]
            : ["/chat/completions", "/models"]
        if let terminalSuffix = terminalSuffixes.first(where: { path.lowercased().hasSuffix($0) }) {
            path.removeLast(terminalSuffix.count)
            while path.count > 1, path.hasSuffix("/") { path.removeLast() }
        }

        // People commonly paste only an official provider origin (or a partial
        // preset path). Complete that path while preserving prefixes on custom
        // gateways and self-hosted servers.
        if let preset = provider.defaultBaseURL,
           let presetComponents = URLComponents(url: preset, resolvingAgainstBaseURL: false),
           presetComponents.scheme?.lowercased() == schemeValue,
           presetComponents.host?.lowercased() == hostValue,
           presetComponents.port == components.port {
            let presetPath = presetComponents.percentEncodedPath
            let currentPath = path == "/" ? "" : path
            if currentPath.isEmpty || presetPath == currentPath || presetPath.hasPrefix(currentPath + "/") {
                path = presetPath
            }
        }
        if path == "/" { path = "" }
        components.percentEncodedPath = path

        guard let normalized = components.url, normalized.host != nil else { throw CloudAccountValidationError.invalidEndpoint }
        return normalized
    }

    func validated() throws -> CloudAccount {
        try CloudAccount(
            id: id,
            name: name,
            provider: provider,
            baseURL: baseURL,
            model: model,
            contextTokenLimit: contextTokenLimit,
            maxOutputTokens: maxOutputTokens
        )
    }

    private static func isPlainText(_ value: String, maximum: Int) -> Bool {
        !value.isEmpty && value.count <= maximum &&
            !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }
}
