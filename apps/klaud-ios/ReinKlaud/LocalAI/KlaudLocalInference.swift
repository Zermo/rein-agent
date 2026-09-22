import BackgroundTasks
import Foundation
import FoundationModels

/// A deliberately narrow on-device provider for editing the reply draft.
/// Full agent/tool work continues through the authenticated Rein web session.
@MainActor
final class KlaudLocalInference: ObservableObject {
    static let maximumDraftBytes = 3_000
    static let maximumResponseTokens = 768

    enum Availability: Equatable {
        case ready
        case deviceNotEligible
        case appleIntelligenceDisabled
        case modelPreparing

        var label: String {
            switch self {
            case .ready: return "On-device model ready"
            case .deviceNotEligible: return "On-device model unavailable on this iPhone"
            case .appleIntelligenceDisabled: return "Turn on Apple Intelligence to refine locally"
            case .modelPreparing: return "On-device model is preparing"
            }
        }
    }

    enum LocalError: LocalizedError, Equatable {
        case emptyDraft
        case draftTooLong(maximumBytes: Int)
        case alreadyRunning
        case unavailable(Availability)
        case registrationFailed
        case expired
        case emptyResponse

        var errorDescription: String? {
            switch self {
            case .emptyDraft:
                return "Write a reply before refining it."
            case .draftTooLong(let maximumBytes):
                return "Keep the draft under \(maximumBytes) UTF-8 bytes for on-device refinement."
            case .alreadyRunning:
                return "A local refinement is already running."
            case .unavailable(let state):
                return state.label
            case .registrationFailed:
                return "iOS could not extend this refinement into the background."
            case .expired:
                return "iOS paused local inference before it finished."
            case .emptyResponse:
                return "The on-device model returned an empty draft."
            }
        }
    }

    @Published private(set) var availability: Availability = .modelPreparing
    @Published private(set) var isRunning = false
    @Published private(set) var status = ""

    typealias Completion = @MainActor (Result<String, Error>) -> Void

    private let model = SystemLanguageModel.default
    private var work: Task<Void, Never>?
    private var submission: Task<String?, Never>?
    private var activeBackgroundTask: BGContinuedProcessingTask?
    private var requestIdentifier: String?
    private var cancellationError: LocalError?
    private var completion: Completion?
    private var progressUnitCount: Int64 = 0

    init() {
        refreshAvailability()
    }

    func refreshAvailability() {
        switch model.availability {
        case .available:
            availability = .ready
        case .unavailable(.deviceNotEligible):
            availability = .deviceNotEligible
        case .unavailable(.appleIntelligenceNotEnabled):
            availability = .appleIntelligenceDisabled
        case .unavailable(.modelNotReady):
            availability = .modelPreparing
        case .unavailable:
            availability = .modelPreparing
        }
    }

    static func preparedDraft(_ draft: String) throws -> String {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LocalError.emptyDraft }
        guard trimmed.lengthOfBytes(using: .utf8) <= maximumDraftBytes else {
            throw LocalError.draftTooLong(maximumBytes: maximumDraftBytes)
        }
        return trimmed
    }

    /// Starts a user-requested refinement immediately. A continued-processing
    /// request only extends that same operation if the app is backgrounded.
    func refine(
        _ draft: String,
        completion: @escaping Completion
    ) {
        let trimmed: String
        do {
            trimmed = try Self.preparedDraft(draft)
        } catch {
            status = error.localizedDescription
            completion(.failure(error))
            return
        }
        guard !isRunning else {
            let error = LocalError.alreadyRunning
            status = error.localizedDescription
            completion(.failure(error))
            return
        }
        refreshAvailability()
        guard availability == .ready else {
            let error = LocalError.unavailable(availability)
            status = error.localizedDescription
            completion(.failure(error))
            return
        }

        let identifier = "org.zermo.rein-klaud.ios.local-inference.\(UUID().uuidString.lowercased())"
        let registered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: identifier,
            using: .main
        ) { [weak self] task in
            guard let continuedTask = task as? BGContinuedProcessingTask else {
                task.setTaskCompleted(success: false)
                Task { @MainActor in self?.expire(identifier: identifier, error: .registrationFailed) }
                return
            }
            Task { @MainActor in self?.attach(continuedTask, identifier: identifier) }
        }
        guard registered else {
            let error = LocalError.registrationFailed
            status = error.localizedDescription
            completion(.failure(error))
            return
        }

        requestIdentifier = identifier
        cancellationError = nil
        self.completion = completion
        isRunning = true
        status = "Refining privately"
        updateProgress(5)
        startInference(draft: trimmed, identifier: identifier)
        submitContinuationRequest(identifier: identifier)
    }

    func markDraftChanged() {
        guard !isRunning else { return }
        status = "Draft changed; refinement was not applied"
    }

    private func submitContinuationRequest(identifier: String) {
        guard #available(iOS 27.0, *) else {
            status = "Refining in foreground"
            return
        }
        let submission = Task.detached(priority: .utility) { () -> String? in
            let request = BGContinuedProcessingTaskRequest(
                identifier: identifier,
                title: "Refining reply",
                subtitle: "klaʊdbot is polishing this draft on your iPhone."
            )
            request.strategy = .fail
            request.requiredResources = []
            do {
                try Task.checkCancellation()
                try await BGTaskScheduler.shared.submitTaskRequest(request)
                return nil
            } catch {
                return error.localizedDescription
            }
        }
        self.submission = submission
        Task { @MainActor [weak self] in
            let message = await submission.value
            guard let self, isRunning, requestIdentifier == identifier, cancellationError == nil else {
                BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
                return
            }
            if let message {
                continuationSubmissionFailed(identifier: identifier, message: message)
            }
        }
    }

    private func continuationSubmissionFailed(identifier: String, message: String) {
        guard isRunning, requestIdentifier == identifier, activeBackgroundTask == nil else { return }
        status = "Refining in foreground"
        _ = message
    }

    private func attach(_ task: BGContinuedProcessingTask, identifier: String) {
        if activeBackgroundTask === task { return }
        guard isRunning, requestIdentifier == identifier, task.identifier == identifier,
              cancellationError == nil, activeBackgroundTask == nil else {
            task.setTaskCompleted(success: false)
            return
        }
        activeBackgroundTask = task
        task.progress.totalUnitCount = 100
        task.progress.completedUnitCount = progressUnitCount
        task.updateTitle(
            "Refining reply",
            subtitle: "Running privately on this iPhone"
        )
        task.expirationHandler = { [weak self] in
            Task { @MainActor in self?.expire(identifier: identifier) }
        }
    }

    private func startInference(draft: String, identifier: String) {
        let session = LanguageModelSession(
            model: model,
            instructions: """
            You are the local drafting layer for klaʊdbot. Rewrite only the user's reply draft.
            Preserve intent, concrete names, paths, commands, and constraints. Be concise and natural.
            Return only the revised draft. Never add an answer to the draft and never invent facts.
            """
        )
        let options = GenerationOptions(
            temperature: 0.35,
            maximumResponseTokens: Self.maximumResponseTokens
        )
        let work = Task { @MainActor [weak self] in
            guard let self, requestIdentifier == identifier else { return }
            do {
                try Task.checkCancellation()
                updateProgress(25)
                let response = try await session.respond(
                    to: "Refine this reply draft without changing its meaning:\n\n\(draft)",
                    options: options
                )
                try Task.checkCancellation()
                updateProgress(85)
                let text = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { throw LocalError.emptyResponse }
                finish(.success(text), identifier: identifier)
            } catch is CancellationError {
                finish(.failure(LocalError.expired), identifier: identifier)
            } catch {
                finish(.failure(error), identifier: identifier)
            }
        }
        self.work = work
    }

    private func expire(identifier: String, error: LocalError = .expired) {
        guard isRunning, requestIdentifier == identifier, cancellationError == nil else { return }
        cancellationError = error
        status = error.localizedDescription
        work?.cancel()
        submission?.cancel()
        activeBackgroundTask?.setTaskCompleted(success: false)
        activeBackgroundTask = nil
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        // Cancellation requests termination; only the settled worker releases ownership.
    }

    private func finish(_ result: Result<String, Error>, identifier: String) {
        guard isRunning, requestIdentifier == identifier else { return }
        let result = cancellationError.map { Result<String, Error>.failure($0) } ?? result
        cancellationError = nil
        isRunning = false
        work = nil
        submission?.cancel()
        submission = nil

        let success: Bool
        switch result {
        case .success:
            success = true
            status = "Refined on device"
            updateProgress(100)
        case .failure(let error):
            success = false
            status = error.localizedDescription
        }
        activeBackgroundTask?.setTaskCompleted(success: success)
        activeBackgroundTask = nil

        if let requestIdentifier {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: requestIdentifier)
        }
        requestIdentifier = nil
        progressUnitCount = 0

        let completion = self.completion
        self.completion = nil
        completion?(result)
    }

    private func updateProgress(_ value: Int64) {
        progressUnitCount = value
        activeBackgroundTask?.progress.completedUnitCount = value
    }
}
