import Foundation

struct GatewayAccountConfiguration: Decodable {
    let provider: String?
    let model: String?
    let baseUrl: String?
    let auth: String
    let apiKeyConfigured: Bool
}

struct GatewaySubscription: Decodable, Identifiable {
    var id: String { provider }
    let provider: String
    let label: String
    let available: Bool
    let authenticated: Bool?
    let detail: String
}

struct GatewayAccountListing: Decodable {
    let configured: GatewayAccountConfiguration
    let environmentOverrides: [String]
    let subscriptions: [GatewaySubscription]
}

struct GatewayDeviceLogin: Decodable {
    let id: String
    let provider: String
    let status: String
    let verificationURL: String?
    let userCode: String?
    let message: String
    var isTerminal: Bool { ["succeeded", "failed", "cancelled", "expired"].contains(status) }
    var safeVerificationURL: URL? {
        guard let verificationURL, let parts = URLComponents(string: verificationURL),
              parts.scheme == "https", parts.user == nil, parts.password == nil,
              parts.port == nil || parts.port == 443, parts.fragment == nil else { return nil }
        let hosts = ["codex": "auth.openai.com", "copilot": "github.com", "grok": "auth.x.ai"]
        guard parts.host == hosts[provider] else { return nil }
        return parts.url
    }
}

/// Subscription credentials stay in the official CLI on the selected host.
struct GatewayAccountsClient: Sendable {
    let connection: GatewayConnection
    private let session = DirectModelClient.secureSession()

    func list() async throws -> GatewayAccountListing { try await request("GET", path: []) }
    func startLogin(provider: String) async throws -> GatewayDeviceLogin {
        try await request("POST", path: ["logins"], body: ["provider": .string(provider)])
    }
    func login(id: String) async throws -> GatewayDeviceLogin { try await request("GET", path: ["logins", id]) }
    func cancelLogin(id: String) async throws -> GatewayDeviceLogin { try await request("DELETE", path: ["logins", id]) }
    func select(provider: String, model: String) async throws {
        let _: GatewaySelectionResult = try await request("PUT", path: ["provider"], body: ["provider": .string(provider), "model": .string(model)])
    }
    func configure(account: CloudAccount, apiKey: String?) async throws {
        guard account.provider != .anthropic else { throw DirectModelError.invalidAccount }
        let _: GatewaySelectionResult = try await request("PUT", path: ["provider"], body: ["provider": .string(account.provider.rawValue), "model": .string(account.model), "baseUrl": .string(account.baseURL.absoluteString), "apiKey": apiKey.map(JSONValue.string) ?? .null])
    }

    private func request<T: Decodable>(_ method: String, path: [String], body: [String: JSONValue]? = nil) async throws -> T {
        var url = connection.baseURL
        for part in ["v1", "mobile", "accounts"] + path { url.append(path: part) }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.timeoutInterval = 35
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue(connection.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw GatewayClientError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let message = response.statusCode == 404 ? "Update the Rein host to use mobile account setup." : "Account setup was rejected. Check the host configuration and official CLI installation."
            throw GatewayClientError.http(response.statusCode, message)
        }
        guard data.count <= 128 * 1024 else { throw GatewayClientError.invalidResponse }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private struct GatewaySelectionResult: Decodable { let message: String }
