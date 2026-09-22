#!/usr/bin/env python3
"""Run the production Swift lifecycle with controllable Apple-framework scheduling.
No model/device/UI claim. Standard library + the installed Swift compiler only.
"""
from pathlib import Path
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / "ReinKlaud/LocalAI/KlaudLocalInference.swift").read_text()
source = source.replace("import BackgroundTasks", "").replace("import FoundationModels", "")
platform = r'''
import Foundation
import Combine
import Darwin
struct SystemLanguageModel {
    enum Reason { case deviceNotEligible, appleIntelligenceNotEnabled, modelNotReady, other }
    enum Availability { case available; case unavailable(Reason) }
    static let `default` = SystemLanguageModel()
    var availability: Availability { .available }
}
struct GenerationOptions { let temperature: Double; let maximumResponseTokens: Int }
struct ModelResponse { let content: String }
@MainActor final class LanguageModelSession {
    init(model: SystemLanguageModel, instructions: String) {}
    func respond(to prompt: String, options: GenerationOptions) async throws -> ModelResponse {
        let draft = prompt.components(separatedBy: "\n\n").last!
        return try await withCheckedThrowingContinuation { Model.pending[draft] = $0 }
    }
}
@MainActor enum Model {
    static var pending: [String: CheckedContinuation<ModelResponse, Error>] = [:]
    static func resolve(_ draft: String) { pending.removeValue(forKey: draft)!.resume(returning: ModelResponse(content: draft + " rewrite")) }
}
class BGTask {
    let identifier: String
    var expirationHandler: (() -> Void)?
    var completions: [Bool] = []
    init(_ identifier: String) { self.identifier = identifier }
    func setTaskCompleted(success: Bool) { completions.append(success); expirationHandler = nil }
}
final class BGContinuedProcessingTask: BGTask {
    var progress = Progress(totalUnitCount: 0)
    func updateTitle(_ title: String, subtitle: String) {}
}
final class BGContinuedProcessingTaskRequest {
    enum Strategy { case fail }
    let identifier: String
    var strategy = Strategy.fail
    var requiredResources: [String] = []
    init(identifier: String, title: String, subtitle: String) { self.identifier = identifier }
}
@MainActor final class BGTaskScheduler {
    static let shared = BGTaskScheduler()
    var registrations: [(String, (BGTask) -> Void)] = []
    var submitted: Set<String> = []
    var pending: Set<String> = []
    var holdNextSubmission = false
    var admissions: [String: CheckedContinuation<Void, Never>] = [:]
    func register(forTaskWithIdentifier id: String, using: DispatchQueue?, launchHandler: @escaping (BGTask) -> Void) -> Bool {
        registrations.append((id, launchHandler)); return true
    }
    func submitTaskRequest(_ request: BGContinuedProcessingTaskRequest) async throws {
        if holdNextSubmission {
            holdNextSubmission = false
            await withCheckedContinuation { admissions[request.identifier] = $0 }
        }
        submitted.insert(request.identifier); pending.insert(request.identifier)
    }
    func cancel(taskRequestWithIdentifier id: String) { pending.remove(id) }
    func captureLaunch(_ id: String) -> (BGContinuedProcessingTask, () -> Void) {
        pending.remove(id)
        let task = BGContinuedProcessingTask(id), handler = registrations.first { $0.0 == id }!.1
        return (task, { handler(task) })
    }
}
@MainActor func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw NSError(domain: message, code: 1) }
}
@MainActor func waitFor(_ condition: @escaping @MainActor () -> Bool) async throws {
    for _ in 0..<2000 {
        if condition() { return }
        try await Task.sleep(nanoseconds: 1_000_000)
    }
    throw NSError(domain: "Scheduling timeout", code: 2)
}
func describe(_ result: Result<String, Error>) -> String {
    switch result { case .success(let text): return text; case .failure(let error): return error.localizedDescription }
}
'''
check = r'''
@main struct LifecycleCheck {
    @MainActor static func main() async {
        do {
            let scheduler = BGTaskScheduler.shared, inference = KlaudLocalInference()
            var results: [String: [String]] = [:]
            inference.refine("A") { results["A", default: []].append(describe($0)) }
            let idA = scheduler.registrations.last!.0
            try await waitFor { Model.pending["A"] != nil && scheduler.submitted.contains(idA) }
            let (bgA, launchA) = scheduler.captureLaunch(idA); launchA()
            try await waitFor { bgA.expirationHandler != nil }
            let oldExpiration = bgA.expirationHandler!
            oldExpiration()
            try await waitFor { bgA.completions == [false] }
            try require(inference.isRunning, "cancel must retain ownership until model execution settles")
            inference.refine("B") { results["rejected", default: []].append(describe($0)) }
            try require(results["rejected"]?.first?.contains("already running") == true, "replacement started while cancelled work was alive")
            try require(Model.pending["B"] == nil, "cancelled parent spawned replacement work")
            Model.resolve("A")
            try await waitFor { !inference.isRunning }
            try require(results["A"]?.count == 1 && results["A"]![0].contains("paused"), "expired work delivered success or finalized twice")
            try require(bgA.completions == [false], "background task completed twice")

            inference.refine("B") { results["B", default: []].append(describe($0)) }
            let idB = scheduler.registrations.last!.0
            try await waitFor { Model.pending["B"] != nil && scheduler.submitted.contains(idB) }
            let (bgB, launchB) = scheduler.captureLaunch(idB); launchB()
            try await waitFor { bgB.expirationHandler != nil }
            oldExpiration()
            try await Task.sleep(nanoseconds: 10_000_000)
            try require(inference.isRunning && results["B"] == nil, "stale expiration finalized replacement")
            Model.resolve("B")
            try await waitFor { !inference.isRunning }
            try require(results["B"] == ["B rewrite"] && bgB.completions == [true], "replacement lost its result or background handle")

            inference.refine("C") { results["C", default: []].append(describe($0)) }
            let idC = scheduler.registrations.last!.0
            try await waitFor { Model.pending["C"] != nil && scheduler.submitted.contains(idC) }
            let (oldBG, lateLaunch) = scheduler.captureLaunch(idC)
            Model.resolve("C")
            try await waitFor { !inference.isRunning }
            inference.refine("D") { results["D", default: []].append(describe($0)) }
            let idD = scheduler.registrations.last!.0
            try await waitFor { Model.pending["D"] != nil && scheduler.submitted.contains(idD) }
            let (currentBG, launchD) = scheduler.captureLaunch(idD); launchD()
            try await waitFor { currentBG.expirationHandler != nil }
            lateLaunch()
            try await waitFor { !oldBG.completions.isEmpty }
            try require(inference.isRunning && currentBG.completions.isEmpty && results["D"] == nil, "stale attachment stole the active task")
            Model.resolve("D")
            try await waitFor { !inference.isRunning }
            try require(results["D"] == ["D rewrite"] && currentBG.completions == [true], "active task orphaned")
            scheduler.holdNextSubmission = true
            inference.refine("E") { results["E", default: []].append(describe($0)) }
            let idE = scheduler.registrations.last!.0
            try await waitFor { Model.pending["E"] != nil && scheduler.admissions[idE] != nil }
            Model.resolve("E")
            try await waitFor { !inference.isRunning }
            inference.refine("F") { results["F", default: []].append(describe($0)) }
            let idF = scheduler.registrations.last!.0
            try await waitFor { Model.pending["F"] != nil && scheduler.pending.contains(idF) }
            scheduler.admissions.removeValue(forKey: idE)!.resume()
            try await waitFor { scheduler.submitted.contains(idE) }
            try await Task.sleep(nanoseconds: 10_000_000)
            try require(!scheduler.pending.contains(idE) && scheduler.pending.contains(idF), "late admission orphaned its request or cancelled the replacement")
            Model.resolve("F")
            try await waitFor { !inference.isRunning }
            try require(results.values.allSatisfy { $0.count == 1 } && Model.pending.isEmpty, "leaked work or repeated callbacks")
            print("PASS: cancellation drains before restart; stale expiration/attachment rejected; callbacks and BG completion exactly once")
        } catch { print("FAIL:", error); exit(1) }
    }
}
'''
with tempfile.TemporaryDirectory(prefix="klaud-lifecycle-") as directory:
    directory = Path(directory)
    swift = directory / "LifecycleCheck.swift"
    swift.write_text(platform + source + check)
    subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-parse-as-library", str(swift), "-o", str(directory / "check")], check=True)
    raise SystemExit(subprocess.run([str(directory / "check")]).returncode)
