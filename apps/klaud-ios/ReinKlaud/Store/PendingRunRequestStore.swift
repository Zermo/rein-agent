import CryptoKit
import Foundation

enum PendingRunRequestLoadResult {
    case none
    case pending(RunRequest)
    case expired(runID: String)
}

@MainActor
protocol PendingRunRequestStorage {
    func load(for origin: URL, now: Date) throws -> PendingRunRequestLoadResult
    func save(_ request: RunRequest, for origin: URL, now: Date) throws
    func remove(runID: String, for origin: URL) throws
    func removeAll(for origin: URL) throws
}

enum PendingRunRequestStoreError: LocalizedError {
    case invalidRecord
    case recordTooLarge
    case capacityReached

    var errorDescription: String? {
        switch self {
        case .invalidRecord: "A saved pending request was invalid and was not replayed."
        case .recordTooLarge: "This request is too large for the protected retry queue."
        case .capacityReached: "The protected retry queue is full. Remove an old gateway before sending."
        }
    }
}

@MainActor
final class ProtectedPendingRunRequestStore: PendingRunRequestStorage {
    private struct Record: Codable {
        let version: Int
        let origin: String
        let createdAt: Date
        let request: RunRequest
    }

    private let fileManager: FileManager
    private let explicitDirectory: URL?
    private let maxAge: TimeInterval
    private let maxRecords: Int
    private let maxRecordBytes: Int

    init(
        directory: URL? = nil,
        fileManager: FileManager = .default,
        maxAge: TimeInterval = 24 * 60 * 60,
        maxRecords: Int = 16,
        maxRecordBytes: Int = 272 * 1024
    ) {
        self.explicitDirectory = directory
        self.fileManager = fileManager
        self.maxAge = maxAge
        self.maxRecords = maxRecords
        self.maxRecordBytes = maxRecordBytes
    }

    func load(for origin: URL, now: Date) throws -> PendingRunRequestLoadResult {
        let file = try fileURL(for: origin, createDirectory: false)
        guard fileManager.fileExists(atPath: file.path) else { return .none }
        let data = try Data(contentsOf: file, options: .mappedIfSafe)
        guard data.count <= maxRecordBytes else {
            try? fileManager.removeItem(at: file)
            throw PendingRunRequestStoreError.recordTooLarge
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        guard let record = try? decoder.decode(Record.self, from: data),
              record.version == 1,
              record.origin == origin.absoluteString,
              record.request.runId.range(of: #"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#, options: .regularExpression) != nil else {
            try? fileManager.removeItem(at: file)
            throw PendingRunRequestStoreError.invalidRecord
        }
        guard now.timeIntervalSince(record.createdAt) <= maxAge,
              record.createdAt.timeIntervalSince(now) <= 5 * 60 else {
            try? fileManager.removeItem(at: file)
            return .expired(runID: record.request.runId)
        }
        return .pending(record.request)
    }

    func save(_ request: RunRequest, for origin: URL, now: Date) throws {
        guard Data(request.message.utf8).count <= 128 * 1024,
              request.tools.count <= 4 else { throw PendingRunRequestStoreError.recordTooLarge }
        let directory = try directoryURL(create: true)
        try removeExpiredRecords(in: directory, now: now)
        let file = fileURL(in: directory, for: origin)
        let existing = fileManager.fileExists(atPath: file.path)
        let count = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.count
        guard existing || count < maxRecords else { throw PendingRunRequestStoreError.capacityReached }

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        let data = try encoder.encode(Record(version: 1, origin: origin.absoluteString, createdAt: now, request: request))
        guard data.count <= maxRecordBytes else { throw PendingRunRequestStoreError.recordTooLarge }
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: file.path
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedFile = file
        try protectedFile.setResourceValues(values)
    }

    func remove(runID: String, for origin: URL) throws {
        let file = try fileURL(for: origin, createDirectory: false)
        guard fileManager.fileExists(atPath: file.path) else { return }
        let data = try Data(contentsOf: file)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        guard let record = try? decoder.decode(Record.self, from: data), record.request.runId == runID else { return }
        try fileManager.removeItem(at: file)
    }

    func removeAll(for origin: URL) throws {
        let file = try fileURL(for: origin, createDirectory: false)
        guard fileManager.fileExists(atPath: file.path) else { return }
        try fileManager.removeItem(at: file)
    }

    private func directoryURL(create: Bool) throws -> URL {
        let directory: URL
        if let explicitDirectory { directory = explicitDirectory }
        else {
            directory = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: create)
                .appendingPathComponent("ReinKlaud", isDirectory: true)
                .appendingPathComponent("PendingRuns", isDirectory: true)
        }
        if create {
            try fileManager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.complete]
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var protectedDirectory = directory
            try protectedDirectory.setResourceValues(values)
        }
        return directory
    }

    private func fileURL(for origin: URL, createDirectory: Bool) throws -> URL {
        fileURL(in: try directoryURL(create: createDirectory), for: origin)
    }

    private func fileURL(in directory: URL, for origin: URL) -> URL {
        let digest = SHA256.hash(data: Data(origin.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(digest).appendingPathExtension("json")
    }

    private func removeExpiredRecords(in directory: URL, now: Date) throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        for file in try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) where file.pathExtension == "json" {
            let data = try Data(contentsOf: file)
            guard data.count <= maxRecordBytes,
                  let record = try? decoder.decode(Record.self, from: data),
                  record.version == 1,
                  now.timeIntervalSince(record.createdAt) <= maxAge,
                  record.createdAt.timeIntervalSince(now) <= 5 * 60 else {
                try? fileManager.removeItem(at: file)
                continue
            }
        }
    }
}
