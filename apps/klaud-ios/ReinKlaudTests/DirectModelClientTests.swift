import XCTest
@testable import ReinKlaud

final class DirectModelClientTests: XCTestCase {
    override func tearDown() {
        DirectFixtureURLProtocol.reset()
        super.tearDown()
    }

    func testOpenAICompatibleRequestUsesCanonicalEndpointAndTextOnlyBody() async throws {
        let capture = DirectRequestCapture()
        let client = fixtureClient { request in
            try capture.set(request)
            return Self.response(request, status: 200, json: [
                "choices": [["message": ["content": [["type": "text", "text": "Hello"], ["type": "text", "text": " world"]]], "finish_reason": "stop"]]
            ])
        }
        let account = try CloudAccount(name: "OpenAI", provider: .openai, model: "gpt-example", maxOutputTokens: 1_024)

        let result = try await client.complete(
            account: account,
            apiKey: "sk-test-key-123456789012345",
            messages: [.init(role: .system, content: "Be concise."), .init(role: .user, content: "Hello")]
        )

        XCTAssertEqual(result, .init(text: "Hello world", finishReason: "stop"))
        let request = try XCTUnwrap(capture.request)
        XCTAssertEqual(request.url?.absoluteString, "https://api.openai.com/v1/chat/completions")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer sk-test-key-123456789012345")
        let body = try XCTUnwrap(request.httpBody).jsonObject
        XCTAssertEqual(body["model"] as? String, "gpt-example")
        XCTAssertEqual(body["max_completion_tokens"] as? Int, 1_024)
        XCTAssertNil(body["max_tokens"])
        XCTAssertEqual(body["stream"] as? Bool, false)
        XCTAssertNil(body["tools"])
    }

    func testCustomPrivateChatCompletionsAllowsNoAPIKey() async throws {
        let capture = DirectRequestCapture()
        let client = fixtureClient { request in
            try capture.set(request)
            return Self.response(request, status: 200, json: ["choices": [["message": ["content": "Local answer"], "finish_reason": "stop"]]])
        }
        let account = try CloudAccount(
            name: "Local",
            provider: .custom,
            baseURL: URL(string: "http://192.168.20.3:1234/prefix/v1/chat/completions")!,
            model: "local-model"
        )

        let result = try await client.complete(account: account, apiKey: nil, messages: [.init(role: .user, content: "Hi")])

        XCTAssertEqual(result.text, "Local answer")
        let request = try XCTUnwrap(capture.request)
        XCTAssertEqual(request.url?.absoluteString, "http://192.168.20.3:1234/prefix/v1/chat/completions")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    }

    func testAnthropicMessagesUsesProviderHeadersAndTopLevelSystem() async throws {
        let capture = DirectRequestCapture()
        let client = fixtureClient { request in
            try capture.set(request)
            return Self.response(request, status: 200, json: [
                "content": [["type": "text", "text": "First"], ["type": "thinking", "thinking": "private"], ["type": "text", "text": " second"]],
                "stop_reason": "end_turn"
            ])
        }
        let account = try CloudAccount(name: "Claude", provider: .anthropic, model: "claude-example", maxOutputTokens: 2_048)

        let result = try await client.complete(
            account: account,
            apiKey: "anthropic-test-key-123456789",
            messages: [.init(role: .system, content: "Rule one."), .init(role: .system, content: "Rule two."), .init(role: .user, content: "Begin")]
        )

        XCTAssertEqual(result, .init(text: "First second", finishReason: "end_turn"))
        let request = try XCTUnwrap(capture.request)
        XCTAssertEqual(request.url?.absoluteString, "https://api.anthropic.com/v1/messages")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-api-key"), "anthropic-test-key-123456789")
        XCTAssertEqual(request.value(forHTTPHeaderField: "anthropic-version"), "2023-06-01")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        let body = try XCTUnwrap(request.httpBody).jsonObject
        XCTAssertEqual(body["system"] as? String, "Rule one.\n\nRule two.")
        XCTAssertEqual((body["messages"] as? [[String: Any]])?.map { $0["role"] as? String }, ["user"])
        XCTAssertNil(body["tools"])
    }

    func testNamedTokenFieldRejectionRetriesOnceWithSameEndpointAndLimit() async throws {
        for provider in [CloudProvider.custom, .openai] {
            let count = DirectCallCount()
            let originalField = provider == .openai ? "max_completion_tokens" : "max_tokens"
            let replacement = provider == .openai ? "max_tokens" : "max_completion_tokens"
            let capture = DirectRequestCapture()
            let account = try CloudAccount(name: "Compatible fixture", provider: provider,
                baseURL: provider == .custom ? URL(string: "http://model-server.local:1234/v1") : nil,
                model: "fixture-model", maxOutputTokens: 1024)
            let client = fixtureClient { request in
                count.increment()
                try capture.set(request)
                let body = try XCTUnwrap(capture.request?.httpBody).jsonObject
                XCTAssertEqual(request.url, account.baseURL.appending(path: "chat/completions"))
                if count.value == 1 {
                    XCTAssertEqual(body[originalField] as? Int, 1024)
                    return Self.response(request, status: 400, json: ["error": ["param": originalField, "message": "Unsupported parameter '\(originalField)'. Use '\(replacement)' instead."]])
                }
                XCTAssertEqual(body[replacement] as? Int, 1024)
                XCTAssertNil(body[originalField])
                return Self.response(request, status: 200, json: ["choices": [["message": ["content": "Compatible answer"]]]])
            }
            let reply = try await client.complete(account: account, apiKey: "fixture-key", messages: [.init(role: .user, content: "Hello")])
            XCTAssertEqual(reply.text, "Compatible answer")
            XCTAssertEqual(count.value, 2)
        }
    }

    func testTokenFieldRetryIsBoundedAndOtherValidationErrorsAreNotRetried() async throws {
        let account = try CloudAccount(name: "Fixture", provider: .openai, model: "fixture-model")
        for explicitReplacement in [true, false] {
            let count = DirectCallCount()
            let client = fixtureClient { request in
                count.increment()
                return Self.response(request, status: 422, json: ["error": [
                    "param": "max_completion_tokens",
                    "message": explicitReplacement ? "Unsupported parameter 'max_completion_tokens'; use max_tokens instead." : "max_completion_tokens exceeds the model's context window."
                ]])
            }
            do {
                _ = try await client.complete(account: account, apiKey: "fixture-key", messages: [.init(role: .user, content: "Hello")])
                XCTFail("Expected validation rejection")
            } catch let error as DirectModelError { XCTAssertEqual(error, .rejected(422)) }
            XCTAssertEqual(count.value, explicitReplacement ? 2 : 1)
        }
    }

    func testGeminiUsesOpenAICompatiblePresetAndBearerHeader() async throws {
        let capture = DirectRequestCapture()
        let client = fixtureClient { request in
            try capture.set(request)
            return Self.response(request, status: 200, json: ["choices": [["message": ["content": "Gemini answer"], "finish_reason": "stop"]]])
        }
        let account = try CloudAccount(name: "Gemini", provider: .gemini, model: "gemini-example")

        _ = try await client.complete(account: account, apiKey: "gemini-key-1234567890123456", messages: [.init(role: .user, content: "Hi")])

        let request = try XCTUnwrap(capture.request)
        XCTAssertEqual(request.url?.absoluteString, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer gemini-key-1234567890123456")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-goog-api-client"), "rein-klaud-ios/0.1")
    }

    func testRedirectDelegateIsInstalledAndRedirectStatusIsNotFallbackEligible() async throws {
        let session = DirectModelClient.secureSession(configuration: fixtureConfiguration())
        XCTAssertTrue(session.delegate is RedirectRefusingSessionDelegate)
        let client = DirectModelClient(session: session)
        DirectFixtureURLProtocol.setHandler { request in Self.response(request, status: 302, json: [:], headers: ["Location": "https://attacker.example/collect"]) }
        let account = try CloudAccount(name: "OpenAI", provider: .openai, model: "gpt-example")

        do {
            _ = try await client.complete(account: account, apiKey: "redirect-secret-123456789012", messages: [.init(role: .user, content: "Hi")])
            XCTFail("Expected redirect rejection")
        } catch let error as DirectModelError {
            XCTAssertEqual(error, .rejected(302))
            XCTAssertFalse(error.isEligibleForAutomaticFallback)
        }
    }

    func testFallbackTaxonomyExcludesAuthMalformedAndCancellation() async throws {
        XCTAssertTrue(DirectModelError.transport("offline").isEligibleForAutomaticFallback)
        XCTAssertFalse(DirectModelError.transport("bad-server-certificate").isEligibleForAutomaticFallback)
        XCTAssertTrue(DirectModelError.rateLimited.isEligibleForAutomaticFallback)
        XCTAssertTrue(DirectModelError.serviceUnavailable.isEligibleForAutomaticFallback)
        XCTAssertFalse(DirectModelError.authentication.isEligibleForAutomaticFallback)
        XCTAssertFalse(DirectModelError.malformedResponse.isEligibleForAutomaticFallback)
        XCTAssertFalse(DirectModelError.invalidRequest.isEligibleForAutomaticFallback)

        let account = try CloudAccount(name: "OpenAI", provider: .openai, model: "gpt-example")
        let authClient = fixtureClient { request in Self.response(request, status: 401, json: ["error": ["message": "raw-provider-secret-detail"]]) }
        do {
            _ = try await authClient.complete(account: account, apiKey: "bad-test-key-1234567890123", messages: [.init(role: .user, content: "Hi")])
            XCTFail("Expected authentication error")
        } catch let error as DirectModelError {
            XCTAssertEqual(error, .authentication)
            XCTAssertFalse(error.localizedDescription.contains("raw-provider-secret-detail"))
        }

        let task = Task { try await authClient.complete(account: account, apiKey: "bad-test-key-1234567890123", messages: [.init(role: .user, content: "Hi")]) }
        task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") }
        catch { XCTAssertTrue(error is CancellationError) }
    }

    func testFallbackHTTPStatusesAreExplicitlyLimited() async throws {
        let account = try CloudAccount(name: "OpenAI", provider: .openai, model: "gpt-example")
        let cases: [(status: Int, expected: DirectModelError, eligible: Bool)] = [
            (429, .rateLimited, true),
            (502, .serviceUnavailable, true),
            (503, .serviceUnavailable, true),
            (504, .serviceUnavailable, true),
            (500, .rejected(500), false),
            (529, .rejected(529), false)
        ]

        for item in cases {
            let client = fixtureClient { request in
                Self.response(request, status: item.status, json: ["error": ["message": "must-not-surface"]])
            }
            do {
                _ = try await client.complete(account: account, apiKey: "status-test-key-123456789012", messages: [.init(role: .user, content: "Hi")])
                XCTFail("Expected HTTP \(item.status) rejection")
            } catch let error as DirectModelError {
                XCTAssertEqual(error, item.expected)
                XCTAssertEqual(error.isEligibleForAutomaticFallback, item.eligible)
                XCTAssertFalse(error.localizedDescription.contains("must-not-surface"))
            }
        }
    }

    func testTLSFailureIsNotFallbackEligible() async throws {
        let account = try CloudAccount(name: "OpenAI", provider: .openai, model: "gpt-example")
        let client = fixtureClient { _ in throw URLError(.serverCertificateUntrusted) }

        do {
            _ = try await client.complete(account: account, apiKey: "tls-test-key-123456789012345", messages: [.init(role: .user, content: "Hi")])
            XCTFail("Expected TLS transport failure")
        } catch let error as DirectModelError {
            XCTAssertEqual(error, .transport("network"))
            XCTAssertFalse(error.isEligibleForAutomaticFallback)
        }
    }

    func testDeclaredOversizedResponseIsRejectedBeforeDecoding() async throws {
        let account = try CloudAccount(name: "OpenAI", provider: .openai, model: "gpt-example")
        let client = fixtureClient { request in
            Self.response(
                request,
                status: 200,
                json: ["choices": [["message": ["content": "ignored"]]]],
                headers: ["Content-Length": String(4 * 1_024 * 1_024 + 1)]
            )
        }

        do {
            _ = try await client.complete(account: account, apiKey: "size-test-key-12345678901234", messages: [.init(role: .user, content: "Hi")])
            XCTFail("Expected response-size rejection")
        } catch let error as DirectModelError {
            XCTAssertEqual(error, .malformedResponse)
            XCTAssertFalse(error.isEligibleForAutomaticFallback)
        }
    }

    func testContextAndOutputBoundsRejectBeforeNetwork() async throws {
        let count = DirectCallCount()
        let client = fixtureClient { request in count.increment(); return Self.response(request, status: 200, json: [:]) }
        let account = try CloudAccount(name: "Tiny", provider: .custom, baseURL: URL(string: "http://127.0.0.1:8080/v1")!, model: "tiny", contextTokenLimit: 256, maxOutputTokens: 128)

        do {
            _ = try await client.complete(account: account, apiKey: nil, messages: [.init(role: .user, content: String(repeating: "x", count: 1_000))])
            XCTFail("Expected request bound")
        } catch let error as DirectModelError {
            XCTAssertEqual(error, .invalidRequest)
        }
        XCTAssertEqual(count.value, 0)
    }

    private func fixtureClient(handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) -> DirectModelClient {
        DirectFixtureURLProtocol.setHandler(handler)
        return DirectModelClient(session: DirectModelClient.secureSession(configuration: fixtureConfiguration()))
    }

    private func fixtureConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DirectFixtureURLProtocol.self]
        return configuration
    }

    private static func response(_ request: URLRequest, status: Int, json: Any, headers: [String: String] = [:]) -> (HTTPURLResponse, Data) {
        let data = try! JSONSerialization.data(withJSONObject: json)
        return (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!, data)
    }
}

private final class DirectFixtureURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    static func setHandler(_ next: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) { lock.withLock { handler = next } }
    static func reset() { lock.withLock { handler = nil } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let action = try Self.lock.withLock { try Self.handler?(request) }
            guard let (response, data) = action else { throw URLError(.resourceUnavailable) }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private final class DirectRequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: URLRequest?
    var request: URLRequest? { lock.withLock { stored } }
    func set(_ request: URLRequest) throws {
        var captured = request
        captured.httpBody = try request.loadedHTTPBody()
        lock.withLock { stored = captured }
    }
}

private final class DirectCallCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func increment() { lock.withLock { count += 1 } }
}

private extension Data {
    var jsonObject: [String: Any] { get throws { try JSONSerialization.jsonObject(with: self) as! [String: Any] } }
}

private extension URLRequest {
    func loadedHTTPBody() throws -> Data? {
        if let httpBody { return httpBody }
        guard let httpBodyStream else { return nil }

        httpBodyStream.open()
        defer { httpBodyStream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let count = httpBodyStream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw httpBodyStream.streamError ?? URLError(.cannotDecodeContentData) }
            if count == 0 { return data }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
}
