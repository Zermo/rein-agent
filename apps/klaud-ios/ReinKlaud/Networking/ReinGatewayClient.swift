import Foundation

protocol ReinGatewayClientProtocol: Sendable {
    func probe() async throws
    func state() async throws -> ReinState
    func bots() async throws -> [ReinBot]
    func messages(botID: String, before: Int?) async throws -> MessagePage
    func createBot(name: String, avatar: String?) async throws -> ReinBot
    func updateBotAvatar(botID: String, avatar: String) async throws -> ReinBot
    func patchShell(_ patch: [ShellPatch]) async throws -> ReinState
    func setPreference(lastBotID: String) async throws -> ReinState
    func startRun(_ request: RunRequest) async throws -> MobileRunReceipt
    func resume(runID: String, after: Int) -> AsyncThrowingStream<RunStreamEvent, Error>
    func cancel(runID: String) async throws
    func answerTool(runID: String, callID: String, result: String, isError: Bool) async throws
    func answerApproval(runID: String, approvalID: String, allow: Bool) async throws
    func runStatus(runID: String) async throws -> MobileRunSnapshot
}

extension ReinGatewayClientProtocol {
    func probe() async throws { _ = try await state() }
}

enum GatewayClientError: LocalizedError {
    case invalidResponse, http(Int, String), unexpectedContentType, streamEnded
    var errorDescription: String? {
        switch self {
        case .invalidResponse: "The Rein gateway returned an invalid response."
        case .http(let code, let message): "Gateway HTTP \(code): \(message)"
        case .unexpectedContentType: "The gateway did not return an AG-UI event stream."
        case .streamEnded: "The gateway event stream ended before the run completed."
        }
    }
}

final class ReinGatewayClient: ReinGatewayClientProtocol, @unchecked Sendable {
    private let connection: GatewayConnection
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(connection: GatewayConnection, session: URLSession = .shared) {
        self.connection = connection
        self.session = session
    }

    private let root = ["v1", "mobile"]

    func probe() async throws {
        var request = try makeRequest(method: "GET", path: root + ["state"], body: Optional<EmptyBody>.none)
        request.timeoutInterval = 8
        let (_, response) = try await session.data(for: request)
        try validate(response: response)
    }

    func state() async throws -> ReinState { try await json(method: "GET", path: root + ["state"], as: ReinState.self) }
    func bots() async throws -> [ReinBot] { try await json(method: "GET", path: root + ["bots"], as: [ReinBot].self) }
    func messages(botID: String, before: Int?) async throws -> MessagePage {
        var query: [URLQueryItem] = []
        if let before { query = [URLQueryItem(name: "before", value: String(before))] }
        return try await json(method: "GET", path: root + ["bots", botID, "messages"], query: query, as: MessagePage.self)
    }
    func createBot(name: String, avatar: String?) async throws -> ReinBot {
        var body = ["name": name]
        if let avatar { body["avatar"] = avatar }
        return try await json(method: "POST", path: root + ["bots"], body: body, as: ReinBot.self)
    }
    func updateBotAvatar(botID: String, avatar: String) async throws -> ReinBot {
        try await json(method: "PATCH", path: root + ["bots", botID], body: ["avatar": avatar], as: ReinBot.self)
    }
    func patchShell(_ patch: [ShellPatch]) async throws -> ReinState {
        try await json(method: "POST", path: root + ["state"], body: PatchBody(patch: patch), as: ReinState.self)
    }
    func setPreference(lastBotID: String) async throws -> ReinState {
        try await json(method: "POST", path: root + ["prefs"], body: PreferenceBody(key: "lastBotId", value: lastBotID), as: ReinState.self)
    }
    func cancel(runID: String) async throws {
        let _: OKResponse = try await json(method: "POST", path: root + ["runs", runID, "cancel"], body: EmptyBody(), as: OKResponse.self)
    }
    func answerTool(runID: String, callID: String, result: String, isError: Bool) async throws {
        let _: OKResponse = try await json(method: "POST", path: root + ["runs", runID, "tools", callID], body: ToolResultRequest(result: result, isError: isError), as: OKResponse.self)
    }
    func answerApproval(runID: String, approvalID: String, allow: Bool) async throws {
        let _: OKResponse = try await json(method: "POST", path: root + ["runs", runID, "approvals", approvalID], body: ApprovalRequest(allow: allow), as: OKResponse.self)
    }

    func runStatus(runID: String) async throws -> MobileRunSnapshot {
        try await json(method: "GET", path: root + ["runs", runID], as: MobileRunSnapshot.self)
    }

    func startRun(_ input: RunRequest) async throws -> MobileRunReceipt {
        let receipt: MobileRunReceipt = try await json(method: "POST", path: root + ["runs"], body: input, as: MobileRunReceipt.self)
        guard receipt.runId == input.runId else { throw GatewayClientError.invalidResponse }
        return receipt
    }

    func resume(runID: String, after: Int) -> AsyncThrowingStream<RunStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do { try await stream(runID: runID, after: after, continuation: continuation); continuation.finish() }
                catch is CancellationError { continuation.finish() }
                catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func stream(runID: String, after initialAfter: Int, continuation: AsyncThrowingStream<RunStreamEvent, Error>.Continuation) async throws {
        var after = max(0, initialAfter), failures = 0
        while !Task.isCancelled {
            do {
                var request = try makeRequest(method: "GET", path: root + ["runs", runID, "events"], query: [URLQueryItem(name: "after", value: String(after))], body: Optional<EmptyBody>.none)
                request.timeoutInterval = 7_200; request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                let (bytes, response) = try await session.bytes(for: request)
                try validate(response: response, expectedEventStream: true)
                var parser = SSEDecoder(), receivedDone = false
                for try await byte in bytes {
                    for frame in try parser.append(Data([byte])) {
                        if frame.event == "rein.run.event" {
                            guard let data = frame.data.data(using: .utf8), let envelope = try? decoder.decode(MobileEventEnvelope.self, from: data) else { throw GatewayClientError.invalidResponse }
                            guard envelope.sequence > after else { continue }
                            after = envelope.sequence
                            continuation.yield(.init(runID: runID, sequence: envelope.sequence, event: envelope.event))
                        } else if frame.event == "rein.run.done" { receivedDone = true }
                    }
                }
                for frame in try parser.append(Data(), final: true) { if frame.event == "rein.run.done" { receivedDone = true } }
                let status = try await runStatus(runID: runID)
                if receivedDone || status.isTerminal && status.lastSequence <= after { return }
                failures = 0
            } catch is CancellationError { throw CancellationError() }
            catch {
                let status = try? await runStatus(runID: runID)
                if let status, status.isTerminal && status.lastSequence <= after { return }
                failures += 1
                if failures >= 8 { throw error }
                try await Task.sleep(for: .milliseconds(min(3_000, 250 * (1 << min(failures, 3)))))
            }
        }
        throw CancellationError()
    }

    private func endpoint(_ path: [String], query: [URLQueryItem] = []) throws -> URL {
        var url = connection.baseURL
        for component in path { url.append(path: component) }
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw GatewayClientError.invalidResponse }
        parts.queryItems = query.isEmpty ? nil : query
        guard let result = parts.url else { throw GatewayClientError.invalidResponse }
        return result
    }

    private func makeRequest<Body: Encodable>(method: String, path: [String], query: [URLQueryItem] = [], body: Body? = nil) throws -> URLRequest {
        var request = URLRequest(url: try endpoint(path, query: query))
        request.httpMethod = method
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue(connection.baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 30
        if let body { request.httpBody = try encoder.encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return request
    }

    private func json<Response: Decodable>(method: String, path: [String], query: [URLQueryItem] = [], as: Response.Type) async throws -> Response {
        try await json(method: method, path: path, query: query, body: Optional<EmptyBody>.none, as: Response.self)
    }

    private func json<Body: Encodable, Response: Decodable>(method: String, path: [String], query: [URLQueryItem] = [], body: Body?, as: Response.Type) async throws -> Response {
        let request = try makeRequest(method: method, path: path, query: query, body: body)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, body: data)
        do { return try decoder.decode(Response.self, from: data) }
        catch { throw GatewayClientError.invalidResponse }
    }

    private func validate(response: URLResponse, body: Data = Data(), expectedEventStream: Bool = false) throws {
        guard let http = response as? HTTPURLResponse else { throw GatewayClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let object = try? JSONDecoder().decode([String: String].self, from: body)
            throw GatewayClientError.http(http.statusCode, object?["error"] ?? "The request was rejected.")
        }
        if expectedEventStream, !(http.value(forHTTPHeaderField: "Content-Type") ?? "").hasPrefix("text/event-stream") {
            throw GatewayClientError.unexpectedContentType
        }
    }
}

private struct PatchBody: Encodable { let patch: [ShellPatch] }
private struct PreferenceBody: Encodable { let key: String; let value: String }
private struct EmptyBody: Codable {}
private struct OKResponse: Decodable { let ok: Bool }

extension ReinGatewayClient {
    static let frontendTools: [FrontendToolDeclaration] = [
        .init(name: "patchShell", description: "Change the visible shell and persist it through rein serve.", parameters: .object([
            "type": .string("object"), "properties": .object(["patch": .object(["type": .string("array")])]), "required": .array([.string("patch")])
        ])),
        .init(name: "setPref", description: "Choose the last opened bot.", parameters: .object([
            "type": .string("object"), "properties": .object(["key": .object(["const": .string("lastBotId")]), "value": .object(["type": .string("string")])]), "required": .array([.string("key"), .string("value")])
        ])),
        .init(name: "navigateTo", description: "Open bots, chat, or settings.", parameters: .object([
            "type": .string("object"), "properties": .object(["dest": .object(["enum": .array([.string("bots"), .string("chat"), .string("settings")])])]), "required": .array([.string("dest")])
        ])),
        .init(name: "confirmAction", description: "Ask the user to explicitly confirm an action.", parameters: .object([
            "type": .string("object"), "properties": .object(["action": .object(["type": .string("string")]), "importance": .object(["enum": .array([.string("low"), .string("medium"), .string("high"), .string("critical")])])]), "required": .array([.string("action")])
        ]))
    ]
}
