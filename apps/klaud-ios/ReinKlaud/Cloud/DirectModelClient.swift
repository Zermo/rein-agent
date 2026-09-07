import Foundation

struct DirectChatMessage: Codable, Equatable, Sendable {
    enum Role: String, Codable, Sendable { case system, user, assistant }
    let role: Role
    let content: String
}

struct DirectChatResult: Equatable, Sendable {
    let text: String
    let finishReason: String?
}

enum DirectModelError: LocalizedError, Equatable {
    case invalidAccount
    case missingAPIKey
    case invalidRequest
    case transport(String)
    case rateLimited
    case serviceUnavailable
    case authentication
    case rejected(Int)
    case malformedResponse
    case emptyResponse

    var isEligibleForAutomaticFallback: Bool {
        switch self {
        case .transport(let code):
            ["timed-out", "cannot-find-host", "cannot-connect", "connection-lost", "dns-failed", "offline"].contains(code)
        case .rateLimited, .serviceUnavailable: true
        default: false
        }
    }

    var errorDescription: String? {
        switch self {
        case .invalidAccount: "The selected API account is invalid."
        case .missingAPIKey: "This provider requires an API key. Add one in Accounts."
        case .invalidRequest: "The direct request exceeds the selected account limits."
        case .transport: "The provider could not be reached."
        case .rateLimited: "The provider rate limit was reached."
        case .serviceUnavailable: "The provider is temporarily unavailable."
        case .authentication: "The provider rejected this API key."
        case .rejected(let status): "The provider rejected the request (HTTP \(status))."
        case .malformedResponse: "The provider returned an unreadable response."
        case .emptyResponse: "The provider returned no text."
        }
    }
}

protocol DirectModelClientProtocol: Sendable {
    func complete(account: CloudAccount, apiKey: String?, messages: [DirectChatMessage]) async throws -> DirectChatResult
}

final class RedirectRefusingSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

final class DirectModelClient: DirectModelClientProtocol, @unchecked Sendable {
    private let session: URLSession
    private static let maximumRequestBytes = 4 * 1_024 * 1_024
    private static let maximumResponseBytes = 4 * 1_024 * 1_024

    init(session: URLSession = DirectModelClient.secureSession()) { self.session = session }

    static func secureSession(configuration: URLSessionConfiguration = .ephemeral) -> URLSession {
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpAdditionalHeaders = nil
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 180
        return URLSession(configuration: configuration, delegate: RedirectRefusingSessionDelegate(), delegateQueue: nil)
    }

    func complete(account: CloudAccount, apiKey: String?, messages: [DirectChatMessage]) async throws -> DirectChatResult {
        try Task.checkCancellation()
        let clean: CloudAccount
        do { clean = try account.validated() }
        catch { throw DirectModelError.invalidAccount }
        let key = try validatedKey(apiKey, required: clean.provider.requiresAPIKey)
        try validate(messages: messages, account: clean)

        let endpoint = endpoint(for: clean)
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if clean.provider.usesAnthropicMessages {
            if let key { request.setValue(key, forHTTPHeaderField: "x-api-key") }
            request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            request.httpBody = try anthropicBody(account: clean, messages: messages)
        } else {
            if let key { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
            if clean.provider == .gemini { request.setValue("rein-klaud-ios/0.1", forHTTPHeaderField: "x-goog-api-client") }
            request.httpBody = try openAICompatibleBody(account: clean, messages: messages)
        }
        guard let body = request.httpBody, body.count <= Self.maximumRequestBytes else { throw DirectModelError.invalidRequest }

        for attempt in 0..<2 {
            try Task.checkCancellation()
            let bytes: URLSession.AsyncBytes
            let response: URLResponse
            do {
                (bytes, response) = try await session.bytes(for: request)
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch let error as URLError {
                throw DirectModelError.transport(Self.transportCode(error.code))
            } catch {
                if Task.isCancelled { throw CancellationError() }
                throw DirectModelError.transport("network")
            }
            try Task.checkCancellation()
            guard let http = response as? HTTPURLResponse else { throw DirectModelError.malformedResponse }
            guard http.url == endpoint else { throw DirectModelError.rejected(http.statusCode) }
            let canInspectRejection = attempt == 0 && !clean.provider.usesAnthropicMessages && [400, 422].contains(http.statusCode)
            if !canInspectRejection {
                do { try validate(status: http.statusCode) }
                catch { bytes.task.cancel(); throw error }
            }
            let responseLimit = canInspectRejection ? 32_768 : Self.maximumResponseBytes
            if response.expectedContentLength > responseLimit {
                bytes.task.cancel()
                throw DirectModelError.malformedResponse
            }
            var data = Data()
            data.reserveCapacity(min(responseLimit, max(0, Int(response.expectedContentLength))))
            do {
                for try await byte in bytes {
                    try Task.checkCancellation()
                    guard data.count < responseLimit else {
                        bytes.task.cancel()
                        throw DirectModelError.malformedResponse
                    }
                    data.append(byte)
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as DirectModelError {
                throw error
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch let error as URLError {
                throw DirectModelError.transport(Self.transportCode(error.code))
            } catch {
                if Task.isCancelled { throw CancellationError() }
                throw DirectModelError.transport("network")
            }

            if canInspectRejection {
                guard let retryBody = tokenFieldRetryBody(request: request, errorData: data) else {
                    throw DirectModelError.rejected(http.statusCode)
                }
                request.httpBody = retryBody
                continue
            }

            return clean.provider.usesAnthropicMessages
                ? try decodeAnthropic(data)
                : try decodeOpenAICompatible(data)
        }
        throw DirectModelError.invalidRequest
    }

    /// Retry once, on the same endpoint, only when a rejection names both the
    /// unsupported token field and its replacement. Never retry accepted work.
    private func tokenFieldRetryBody(request: URLRequest, errorData: Data) -> Data? {
        guard let original = request.httpBody,
              var body = try? JSONSerialization.jsonObject(with: original) as? [String: Any],
              let response = try? JSONSerialization.jsonObject(with: errorData) as? [String: Any] else { return nil }
        let error = response["error"] as? [String: Any] ?? response
        let message = (error["message"] as? String ?? "").lowercased()
        let code = (error["code"] as? String ?? "").lowercased()
        let field = body["max_tokens"] != nil ? "max_tokens" : "max_completion_tokens"
        let replacement = field == "max_tokens" ? "max_completion_tokens" : "max_tokens"
        let unsupported = ["unsupported", "not supported", "does not support", "unknown parameter", "unknown field", "unrecognized", "unexpected argument"]
        let namesField = error["param"] as? String == field || message.contains("'\(field)'") || message.contains("\"\(field)\"")
        guard namesField, message.contains(replacement), unsupported.contains(where: { (code + " " + message).contains($0) }),
              let limit = body.removeValue(forKey: field), body[replacement] == nil else { return nil }
        body[replacement] = limit
        return try? JSONSerialization.data(withJSONObject: body)
    }

    private func endpoint(for account: CloudAccount) -> URL {
        account.baseURL.appending(path: account.provider.usesAnthropicMessages ? "messages" : "chat/completions")
    }

    private func validatedKey(_ value: String?, required: Bool) throws -> String? {
        guard let value, !value.isEmpty else {
            if required { throw DirectModelError.missingAPIKey }
            return nil
        }
        guard value.utf8.count <= 4_096,
              value.unicodeScalars.allSatisfy({ $0.value >= 0x21 && $0.value <= 0x7e }) else {
            throw DirectModelError.invalidAccount
        }
        return value
    }

    private func validate(messages: [DirectChatMessage], account: CloudAccount) throws {
        guard !messages.isEmpty, messages.count <= 256,
              messages.contains(where: { $0.role != .system }),
              messages.allSatisfy({ !$0.content.isEmpty && $0.content.utf8.count <= 1_048_576 }) else {
            throw DirectModelError.invalidRequest
        }
        let estimatedInputTokens = messages.reduce(0) { total, message in
            total + (message.content.utf8.count + 3) / 4 + 8
        }
        guard estimatedInputTokens + account.maxOutputTokens <= account.contextTokenLimit else {
            throw DirectModelError.invalidRequest
        }
    }

    private func openAICompatibleBody(account: CloudAccount, messages: [DirectChatMessage]) throws -> Data {
        struct Body: Encodable {
            let model: String
            let messages: [DirectChatMessage]
            let maxTokens: Int?
            let maxCompletionTokens: Int?
            let stream = false
            enum CodingKeys: String, CodingKey {
                case model, messages, maxTokens = "max_tokens", maxCompletionTokens = "max_completion_tokens", stream
            }
        }
        let usesCurrentOpenAIField = account.provider == .openai
        do {
            return try JSONEncoder().encode(Body(
                model: account.model,
                messages: messages,
                maxTokens: usesCurrentOpenAIField ? nil : account.maxOutputTokens,
                maxCompletionTokens: usesCurrentOpenAIField ? account.maxOutputTokens : nil
            ))
        }
        catch { throw DirectModelError.invalidRequest }
    }

    private func anthropicBody(account: CloudAccount, messages: [DirectChatMessage]) throws -> Data {
        struct AnthropicMessage: Encodable { let role: String; let content: String }
        struct Body: Encodable {
            let model: String
            let system: String?
            let messages: [AnthropicMessage]
            let maxTokens: Int
            let stream = false
            enum CodingKeys: String, CodingKey { case model, system, messages, maxTokens = "max_tokens", stream }
        }
        let system = messages.filter { $0.role == .system }.map(\.content).joined(separator: "\n\n")
        let conversation = messages.compactMap { message -> AnthropicMessage? in
            guard message.role != .system else { return nil }
            return AnthropicMessage(role: message.role.rawValue, content: message.content)
        }
        guard !conversation.isEmpty else { throw DirectModelError.invalidRequest }
        do {
            return try JSONEncoder().encode(Body(model: account.model, system: system.isEmpty ? nil : system, messages: conversation, maxTokens: account.maxOutputTokens))
        } catch { throw DirectModelError.invalidRequest }
    }

    private func decodeOpenAICompatible(_ data: Data) throws -> DirectChatResult {
        struct Response: Decodable {
            struct Choice: Decodable {
                struct Message: Decodable { let content: JSONValue }
                let message: Message
                let finishReason: String?
                enum CodingKeys: String, CodingKey { case message, finishReason = "finish_reason" }
            }
            let choices: [Choice]
        }
        let response: Response
        do { response = try JSONDecoder().decode(Response.self, from: data) }
        catch { throw DirectModelError.malformedResponse }
        guard let choice = response.choices.first else { throw DirectModelError.malformedResponse }
        let text = text(from: choice.message.content)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw DirectModelError.emptyResponse }
        return .init(text: text, finishReason: choice.finishReason)
    }

    private func decodeAnthropic(_ data: Data) throws -> DirectChatResult {
        struct Block: Decodable { let type: String; let text: String? }
        struct Response: Decodable {
            let content: [Block]
            let stopReason: String?
            enum CodingKeys: String, CodingKey { case content, stopReason = "stop_reason" }
        }
        let response: Response
        do { response = try JSONDecoder().decode(Response.self, from: data) }
        catch { throw DirectModelError.malformedResponse }
        let text = response.content.compactMap { $0.type == "text" ? $0.text : nil }.joined()
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw DirectModelError.emptyResponse }
        return .init(text: text, finishReason: response.stopReason)
    }

    private func text(from content: JSONValue) -> String {
        switch content {
        case .string(let value): value
        case .array(let values): values.compactMap { $0.objectValue?["text"]?.stringValue }.joined()
        default: ""
        }
    }

    private func validate(status: Int) throws {
        guard !(200..<300).contains(status) else { return }
        switch status {
        case 401, 403: throw DirectModelError.authentication
        case 429: throw DirectModelError.rateLimited
        case 502, 503, 504: throw DirectModelError.serviceUnavailable
        default: throw DirectModelError.rejected(status)
        }
    }

    private static func transportCode(_ code: URLError.Code) -> String {
        switch code {
        case .timedOut: "timed-out"
        case .cannotFindHost: "cannot-find-host"
        case .cannotConnectToHost: "cannot-connect"
        case .networkConnectionLost: "connection-lost"
        case .dnsLookupFailed: "dns-failed"
        case .notConnectedToInternet: "offline"
        default: "network"
        }
    }
}
