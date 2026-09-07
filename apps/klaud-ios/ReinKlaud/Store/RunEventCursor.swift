import Foundation

@MainActor
final class RunEventCursor {
    private let defaults: UserDefaults
    private let prefix = "rein-klaud:run-event-cursor:v1:"

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func lastHandled(runID: String) -> Int {
        max(0, defaults.integer(forKey: key(runID)))
    }

    func shouldHandle(runID: String, sequence: Int) -> Bool {
        sequence > lastHandled(runID: runID)
    }

    func markHandled(runID: String, sequence: Int) {
        guard sequence > lastHandled(runID: runID) else { return }
        defaults.set(sequence, forKey: key(runID))
    }

    func clear(runID: String) { defaults.removeObject(forKey: key(runID)) }

    private func key(_ runID: String) -> String { prefix + runID }
}
