import Foundation

enum SSEDecoderError: Error, Equatable { case eventTooLarge, incompleteEvent }

struct SSEFrame: Equatable, Sendable {
    let id: String?
    let event: String?
    let data: String
}

struct SSEDecoder: Sendable {
    private(set) var buffer = Data()
    let maximumEventBytes: Int

    init(maximumEventBytes: Int = 1_048_576) { self.maximumEventBytes = maximumEventBytes }

    mutating func append(_ data: Data, final: Bool = false) throws -> [SSEFrame] {
        buffer.append(data)
        guard buffer.count <= maximumEventBytes else { throw SSEDecoderError.eventTooLarge }
        var frames: [SSEFrame] = []
        while let boundary = boundaryRange(in: buffer) {
            let block = buffer[..<boundary.lowerBound]
            buffer.removeSubrange(..<boundary.upperBound)
            let text = String(decoding: block, as: UTF8.self).replacingOccurrences(of: "\r\n", with: "\n")
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            let payload = lines.filter { $0.hasPrefix("data:") }.map { line -> String in
                    var value = String(line.dropFirst(5))
                    if value.first == " " { value.removeFirst() }
                    return value
                }.joined(separator: "\n")
            if payload == "[DONE]" { buffer.removeAll(); return frames }
            if !payload.isEmpty {
                let id = lines.first(where: { $0.hasPrefix("id:") }).map { String($0.dropFirst(3)).trimmingCharacters(in: .whitespaces) }
                let event = lines.first(where: { $0.hasPrefix("event:") }).map { String($0.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
                frames.append(.init(id: id, event: event, data: payload))
            }
        }
        if final && !buffer.isEmpty {
            if String(decoding: buffer, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { buffer.removeAll() }
            else { throw SSEDecoderError.incompleteEvent }
        }
        return frames
    }

    private func boundaryRange(in data: Data) -> Range<Data.Index>? {
        if let range = data.range(of: Data([10, 10])) { return range }
        return data.range(of: Data([13, 10, 13, 10]))
    }
}
