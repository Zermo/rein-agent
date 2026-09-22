import SwiftUI
import WebKit
import UniformTypeIdentifiers
import Speech
import AVFoundation
import CoreHaptics

@main
struct ReinKlaudApp: App {
    var body: some Scene {
        WindowGroup {
            KlaudWebShell()
                .preferredColorScheme(.light)
        }
    }
}

private let klaudOrigin = URL(string: "https://openbot.zermo.org/")!

struct KlaudWebShell: View {
    @StateObject private var bridge = KlaudBridge()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color(red: 0.07, green: 0.06, blue: 0.05).ignoresSafeArea()
            VStack(spacing: 0) {
                KlaudWebView(bridge: bridge, start: klaudOrigin)
                if bridge.composerVisible {
                    KlaudNativeComposer(bridge: bridge)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.18), value: bridge.composerVisible)
            if let message = bridge.fault {
                VStack(spacing: 12) {
                    Text("klaʊdbot")
                        .font(.system(size: 22, weight: .semibold, design: .serif))
                    Text(message)
                        .font(.system(size: 14, design: .monospaced))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    Button("Retry") { bridge.reload() }
                        .buttonStyle(.borderedProminent)
                        .tint(Color(red: 0.77, green: 0.36, blue: 0.23))
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(red: 0.93, green: 0.89, blue: 0.82))
            }
        }
        .sheet(item: $bridge.shareItem) { item in
            ShareSheet(url: item.url)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { bridge.rejoin() }
        }
    }
}

struct ShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

enum KlaudLegacyEvaluationResult: Equatable {
    case accepted
    case rejected
    case unknown
}

@MainActor
final class KlaudBridge: NSObject, ObservableObject {
    @Published var fault: String?
    @Published var shareItem: ShareItem?
    @Published private(set) var composerVisible = false
    @Published private(set) var composerText = ""
    @Published private(set) var composerEnabled = false
    @Published private(set) var composerBusy = false
    @Published private(set) var composerRevision = 0
    @Published private(set) var composerSubmitting = false
    @Published private(set) var composerDeliveryUncertain = false
    @Published var keyboardVisible = false
    @Published var keyboardDismissRequest = 0
    @Published var keyboardShowRequest = 0

    weak var webView: WKWebView?
    weak var composerTextView: KlaudComposerTextView?
    let feel = KlaudKeyFeel()
    let dictation = KlaudDictation()
    let sounds = ReinSoundEngine()
    let localInference = KlaudLocalInference()
    var commandSink: (([String: Any]) -> Void)?
    var legacyCommandSink: ((String, @escaping (KlaudLegacyEvaluationResult) -> Void) -> Void)?

    struct DraftSnapshot {
        let scope: KlaudComposerScope?
        let text: String
        let revision: Int
    }

    private struct DraftRecord {
        var text: String
        var revision: Int
    }

    private struct SubmitLatch {
        let requestID: String
        let scope: KlaudComposerScope
        let revision: Int
    }

    private enum ComposerTransport {
        case none
        case scoped
        case legacy
    }

    private var composerScope: KlaudComposerScope?
    private var drafts: [KlaudComposerScope: DraftRecord] = [:]
    private var pendingSends: [String: KlaudPendingComposerSend] = [:]
    private var submitLatches: [KlaudComposerScope: SubmitLatch] = [:]
    private var transport: ComposerTransport = .none
    private var pendingLegacyDraft: (revision: Int, text: String)?
    private var legacyDocumentNonce: String?
    private(set) var dictationActive = false
    private var dictationRange: NSRange?
    private var dictationScope: KlaudComposerScope?
    private var dictationExpectedRevision: Int?

    override init() {
        super.init()
        dictation.onResult = { [weak self] text, isFinal, error in
            self?.applyDictation(text: text, isFinal: isFinal, error: error)
        }
    }

    func reload() {
        fault = nil
        resetComposerTransport()
        webView?.load(URLRequest(url: klaudOrigin, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
    }

    func rejoin() {
        localInference.refreshAvailability()
        guard let webView else { return }
        let host = webView.url?.host?.lowercased() ?? ""
        if host == "auth.zermo.org" {
            // Preserve Authelia's in-progress MFA/passkey document when the
            // user returns from another app.
            webView.evaluateJavaScript("document.dispatchEvent(new Event('visibilitychange'))")
            return
        }
        if host.isEmpty {
            reload()
            return
        }
        if host == "openbot.zermo.org" || host == "reinklaud.zermo.org" {
            webView.evaluateJavaScript("document.dispatchEvent(new Event('visibilitychange'))")
            return
        }
        reload()
    }

    func resetComposerTransport() {
        stopDictation()
        persistCurrentDraft()
        pendingLegacyDraft = nil
        legacyDocumentNonce = nil
        transport = .none
        composerScope = nil
        composerVisible = false
        composerEnabled = false
        composerBusy = false
        composerSubmitting = !submitLatches.isEmpty
        composerDeliveryUncertain = !submitLatches.isEmpty
        requestKeyboardDismissal()
    }

    func receiveComposerMessage(_ body: [String: Any]) {
        let version = (body["protocolVersion"] as? NSNumber)?.intValue
        guard version == KlaudComposerContract.version,
              let action = body["action"] as? String else { return }
        switch action {
        case "state":
            let promotedFromLegacy = transport == .legacy
            transport = .scoped
            pendingLegacyDraft = nil
            legacyDocumentNonce = nil
            updateComposerState(body, promotedFromLegacy: promotedFromLegacy)
        case "legacyState":
            guard transport != .scoped else { return }
            legacyDocumentNonce = body["documentNonce"] as? String
            updateLegacyComposerState(body)
        case "sendAck":
            receiveSendAcknowledgement(body)
        case "dismiss":
            requestKeyboardDismissal()
        default:
            break
        }
    }

    func setComposerDraft(_ text: String) {
        guard text != composerText,
              text.utf8.count <= KlaudComposerContract.maximumUTF8Count else { return }
        composerText = text
        composerRevision &+= 1
        persistCurrentDraft()
        if transport == .legacy, let composerScope {
            pendingLegacyDraft = (composerRevision, text)
            evaluateLegacy("setDraft(\(Self.json(text)),\(composerRevision),\(Self.json(Self.legacyScopeKey(composerScope))))")
            return
        }
        emitComposerCommand([
            "action": "draft",
            "revision": composerRevision,
            "text": text
        ])
    }

    func submitComposer() {
        guard composerEnabled, !composerBusy, submitLatches.isEmpty, let composerScope,
              !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        stopDictationForManualEditing()
        let requestID = UUID().uuidString.lowercased()
        let latch = SubmitLatch(requestID: requestID, scope: composerScope, revision: composerRevision)
        submitLatches[composerScope] = latch
        composerSubmitting = true
        composerDeliveryUncertain = false
        pendingSends[requestID] = KlaudPendingComposerSend(
            requestID: requestID,
            scope: composerScope,
            revision: composerRevision,
            text: composerText
        )
        if transport == .legacy {
            let expectedDocumentNonce = legacyDocumentNonce
            evaluateLegacy("submit(\(Self.json(Self.legacyScopeKey(composerScope))))") { [weak self] result in
                guard let self,
                      self.submitLatches[composerScope]?.requestID == requestID else { return }
                guard self.transport == .legacy,
                      let expectedDocumentNonce,
                      self.legacyDocumentNonce == expectedDocumentNonce else {
                    self.markDeliveryUnknown(scope: composerScope, requestID: requestID)
                    return
                }
                switch result {
                case .accepted:
                    break
                case .rejected:
                    self.pendingSends.removeValue(forKey: requestID)
                    self.releaseSubmitLatch(scope: composerScope, requestID: requestID)
                case .unknown:
                    self.markDeliveryUnknown(scope: composerScope, requestID: requestID)
                }
            }
            return
        }
        emitComposerCommand([
            "action": "send",
            "requestId": requestID,
            "revision": composerRevision,
            "text": composerText
        ])
    }

    func stopRun() {
        guard composerBusy, composerScope != nil else { return }
        if transport == .legacy, let composerScope {
            evaluateLegacy("stop(\(Self.json(Self.legacyScopeKey(composerScope))))")
            return
        }
        emitComposerCommand([
            "action": "stop",
            "requestId": UUID().uuidString.lowercased()
        ])
    }

    func allowRetryAfterUnknownDelivery() {
        guard composerDeliveryUncertain else { return }
        pendingSends.removeAll()
        submitLatches.removeAll()
        composerSubmitting = false
        composerDeliveryUncertain = false
    }

    func appendAttachmentNames(_ urls: [URL]) {
        let names = urls.prefix(8).map(\.lastPathComponent).filter { !$0.isEmpty }
        guard !names.isEmpty else { return }
        let suffix = "+ \(names.joined(separator: ", "))"
        let next = composerText.isEmpty
            ? suffix
            : "\(composerText)\(composerText.hasSuffix("\n") ? "" : "\n")\(suffix)"
        setComposerDraft(next)
    }

    func requestKeyboardDismissal() {
        keyboardDismissRequest &+= 1
        keyboardVisible = false
    }

    func requestKeyboardPresentation() {
        keyboardShowRequest &+= 1
    }

    func toggleDictation() {
        if dictationActive { stopDictation() } else { startDictation() }
    }

    func startDictation() {
        guard !dictationActive, composerEnabled, !composerBusy,
              let editor = composerTextView else { return }
        beginDictationTracking(in: editor)
        dictation.start()
    }

    func beginDictationTracking(in editor: KlaudComposerTextView) {
        let length = (editor.text as NSString).length
        let location = min(editor.selectedRange.location, length)
        let rangeLength = min(editor.selectedRange.length, length - location)
        dictationRange = NSRange(location: location, length: rangeLength)
        dictationScope = composerScope
        dictationExpectedRevision = composerRevision
        dictationActive = true
    }

    func stopDictation() {
        guard dictationActive else {
            dictationScope = nil
            dictationExpectedRevision = nil
            dictationRange = nil
            return
        }
        dictation.stop()
        dictationActive = false
        dictationRange = nil
        dictationScope = nil
        dictationExpectedRevision = nil
    }

    func stopDictationForManualEditing() {
        if dictationActive { stopDictation() }
    }

    private func applyDictation(text: String, isFinal: Bool, error: String?) {
        guard error == nil else {
            stopDictation()
            return
        }
        guard dictationActive,
              let editor = composerTextView,
              composerScope == dictationScope,
              composerRevision == dictationExpectedRevision else {
            stopDictation()
            return
        }
        let proposed = dictationRange ?? editor.selectedRange
        let current = editor.text as NSString
        let location = min(proposed.location, current.length)
        let rangeLength = min(proposed.length, current.length - location)
        let clamped = NSRange(location: location, length: rangeLength)
        let candidate = current.replacingCharacters(in: clamped, with: text)
        guard candidate.utf8.count <= KlaudComposerContract.maximumUTF8Count else {
            stopDictation()
            return
        }
        dictationRange = editor.performProgrammaticUpdate {
            editor.replaceText(in: clamped, with: text)
        }
        setComposerDraft(editor.text)
        dictationExpectedRevision = composerRevision
        if isFinal {
            stopDictation()
        }
    }

    func refineDraftOnDevice() {
        let snapshot = currentDraftSnapshot()
        localInference.refine(snapshot.text) { [weak self] result in
            guard let self, case .success(let revised) = result else { return }
            self.applyRefinedDraft(revised, from: snapshot)
        }
    }

    func currentDraftSnapshot() -> DraftSnapshot {
        DraftSnapshot(scope: composerScope, text: composerText, revision: composerRevision)
    }

    func applyRefinedDraft(_ revised: String, from snapshot: DraftSnapshot) {
        guard composerScope == snapshot.scope,
              composerRevision == snapshot.revision,
              composerText == snapshot.text else {
            localInference.markDraftChanged()
            return
        }
        setComposerDraft(revised)
        requestKeyboardPresentation()
    }

    func keyFeedback(_ key: String) {
        feel.tap(key)
        sounds.play(key == "send" ? .send : .key)
    }

    func handoff(action: String, name: String, mime: String, bytes: Data) {
        let safe = (name as NSString).lastPathComponent
            .replacingOccurrences(of: "/", with: "")
            .replacingOccurrences(of: ":", with: "")
        let file = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(safe.isEmpty ? "klaudbot.bin" : safe)
        try? bytes.write(to: file, options: .atomic)
        shareItem = ShareItem(url: file)
        _ = action
        _ = mime
    }

    private func updateComposerState(
        _ body: [String: Any],
        promotedFromLegacy: Bool
    ) {
        guard body["visible"] as? Bool == true,
              let nextScope = KlaudComposerContract.scope(from: body) else {
            resetComposerTransport()
            return
        }

        let remoteDraft = (body["draft"] as? String) ?? ""
        let nextEnabled = body["enabled"] as? Bool ?? false
        let nextBusy = body["busy"] as? Bool ?? false
        if composerScope != nextScope {
            stopDictation()
            persistCurrentDraft()
            composerScope = nextScope
            let record = drafts[nextScope] ?? DraftRecord(
                text: remoteDraft.utf8.count <= KlaudComposerContract.maximumUTF8Count ? remoteDraft : "",
                revision: 0
            )
            drafts[nextScope] = record
            composerText = record.text
            composerRevision = record.revision
        }
        if !nextEnabled || nextBusy { stopDictation() }
        if let latch = submitLatches[nextScope] {
            if promotedFromLegacy {
                markDeliveryUnknown(scope: nextScope, requestID: latch.requestID)
            }
            if let pending = pendingSends[latch.requestID], nextBusy {
                acceptPendingSend(pending)
            }
        }

        composerVisible = true
        composerEnabled = nextEnabled
        composerBusy = nextBusy
        composerSubmitting = !submitLatches.isEmpty
        if remoteDraft != composerText {
            emitComposerCommand([
                "action": "draft",
                "revision": composerRevision,
                "text": composerText
            ])
        }
    }

    private func updateLegacyComposerState(_ body: [String: Any]) {
        guard body["visible"] as? Bool == true,
              let scopeKey = body["scope"] as? String,
              !scopeKey.isEmpty,
              let nextScope = KlaudComposerContract.scope(from: body) else {
            resetComposerTransport()
            return
        }
        let remoteDraft = (body["draft"] as? String) ?? ""
        let reportedRevision = (body["revision"] as? NSNumber)?.intValue ?? 0
        let nextEnabled = body["enabled"] as? Bool ?? false
        let nextBusy = body["busy"] as? Bool ?? false
        if transport != .legacy || composerScope != nextScope {
            stopDictation()
            persistCurrentDraft()
            transport = .legacy
            composerScope = nextScope
            pendingLegacyDraft = nil
            composerText = remoteDraft.utf8.count <= KlaudComposerContract.maximumUTF8Count ? remoteDraft : ""
            composerRevision = reportedRevision
            persistCurrentDraft()
        } else if reportedRevision >= composerRevision {
            if let pendingLegacyDraft, reportedRevision == pendingLegacyDraft.revision {
                if remoteDraft == pendingLegacyDraft.text {
                    self.pendingLegacyDraft = nil
                }
            } else if remoteDraft.utf8.count <= KlaudComposerContract.maximumUTF8Count {
                composerText = remoteDraft
                composerRevision = reportedRevision
                persistCurrentDraft()
            }
        }
        if !nextEnabled || nextBusy { stopDictation() }
        if let latch = submitLatches[nextScope],
           let pending = pendingSends[latch.requestID],
           nextBusy || (reportedRevision == latch.revision && remoteDraft.isEmpty) {
            acceptPendingSend(pending)
        }
        composerVisible = true
        composerEnabled = nextEnabled
        composerBusy = nextBusy
        composerSubmitting = !submitLatches.isEmpty
    }

    private func receiveSendAcknowledgement(_ body: [String: Any]) {
        guard let requestID = body["requestId"] as? String,
              let pending = pendingSends[requestID],
              KlaudComposerContract.scope(from: body) == pending.scope,
              (body["revision"] as? NSNumber)?.intValue == pending.revision else { return }
        guard body["accepted"] as? Bool == true else {
            pendingSends.removeValue(forKey: requestID)
            releaseSubmitLatch(scope: pending.scope, requestID: requestID)
            return
        }
        acceptPendingSend(pending)
    }

    private func acceptPendingSend(_ pending: KlaudPendingComposerSend) {
        pendingSends.removeValue(forKey: pending.requestID)
        releaseSubmitLatch(scope: pending.scope, requestID: pending.requestID)
        if composerScope == pending.scope,
           composerRevision == pending.revision,
           composerText == pending.text {
            setComposerDraft("")
            return
        }
        if let record = drafts[pending.scope],
           record.revision == pending.revision,
           record.text == pending.text {
            drafts[pending.scope] = DraftRecord(text: "", revision: pending.revision &+ 1)
        }
    }

    private func releaseSubmitLatch(
        scope: KlaudComposerScope,
        requestID: String? = nil
    ) {
        guard let latch = submitLatches[scope],
              requestID == nil || latch.requestID == requestID else { return }
        submitLatches.removeValue(forKey: scope)
        composerSubmitting = !submitLatches.isEmpty
        if submitLatches.isEmpty { composerDeliveryUncertain = false }
    }

    private func markDeliveryUnknown(scope: KlaudComposerScope, requestID: String) {
        guard submitLatches[scope]?.requestID == requestID else { return }
        composerSubmitting = true
        composerDeliveryUncertain = true
    }

    private func persistCurrentDraft() {
        guard let composerScope else { return }
        drafts[composerScope] = DraftRecord(text: composerText, revision: composerRevision)
    }

    private func emitComposerCommand(_ values: [String: Any]) {
        guard transport == .scoped, let composerScope else { return }
        var payload = values
        payload["protocolVersion"] = KlaudComposerContract.version
        payload["botId"] = composerScope.botID
        payload["sessionId"] = composerScope.sessionID
        if let commandSink {
            commandSink(payload)
            return
        }
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let source = "window.dispatchEvent(new CustomEvent('\(KlaudComposerContract.eventName)',{detail:\(json)}))"
        webView?.evaluateJavaScript(source, completionHandler: nil)
    }

    private func evaluateLegacy(
        _ invocation: String,
        completion: ((KlaudLegacyEvaluationResult) -> Void)? = nil
    ) {
        if let legacyCommandSink {
            legacyCommandSink(invocation) { result in
                Task { @MainActor in completion?(result) }
            }
            return
        }
        guard let webView else {
            completion?(.unknown)
            return
        }
        webView.evaluateJavaScript(
            "window.klaudLegacyNativeComposer&&window.klaudLegacyNativeComposer.\(invocation)"
        ) { result, error in
            Task { @MainActor in
                guard error == nil, let value = result as? NSNumber else {
                    completion?(.unknown)
                    return
                }
                completion?(value.boolValue ? .accepted : .rejected)
            }
        }
    }

    private static func legacyScopeKey(_ scope: KlaudComposerScope) -> String {
        "\(scope.botID)|\(scope.sessionID)"
    }

    private static func json(_ value: String) -> String {
        let data = (try? JSONEncoder().encode(value)) ?? Data("\"\"".utf8)
        return String(data: data, encoding: .utf8) ?? "\"\""
    }
}

final class KlaudKeyFeel {
    private let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private let soft = UIImpactFeedbackGenerator(style: .soft)
    private let heavy = UIImpactFeedbackGenerator(style: .heavy)
    private let medium = UIImpactFeedbackGenerator(style: .medium)
    private var engine: CHHapticEngine?
    private var ready = false

    func prepare() {
        rigid.prepare()
        soft.prepare()
        heavy.prepare()
        medium.prepare()
        guard !ready else { return }
        ready = true
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        engine = try? CHHapticEngine()
        engine?.playsHapticsOnly = true
        engine?.resetHandler = { [weak self] in try? self?.engine?.start() }
        engine?.stoppedHandler = { [weak self] _ in try? self?.engine?.start() }
        try? engine?.start()
    }

    func tap(_ key: String) {
        prepare()
        switch key {
        case "space":
            soft.impactOccurred(intensity: 0.88)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { [weak self] in
                self?.medium.impactOccurred(intensity: 0.62)
            }
            rumble(travel: 0.038, travelIntensity: 0.42, seat: 0.78, seatSharp: 0.28, bottom: 0.5)
        case "delete":
            rigid.impactOccurred(intensity: 1.0)
            rumble(travel: 0.012, travelIntensity: 0.2, seat: 1.0, seatSharp: 0.95, bottom: 0.3)
        case "return":
            heavy.impactOccurred(intensity: 0.92)
            rumble(travel: 0.03, travelIntensity: 0.38, seat: 0.9, seatSharp: 0.45, bottom: 0.7)
        case "send":
            heavy.impactOccurred(intensity: 1.0)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) { [weak self] in
                self?.rigid.impactOccurred(intensity: 0.55)
            }
            rumble(travel: 0.028, travelIntensity: 0.4, seat: 1.0, seatSharp: 0.55, bottom: 0.65)
        default:
            rigid.impactOccurred(intensity: 0.78)
            rumble(travel: 0.02, travelIntensity: 0.28, seat: 0.86, seatSharp: 0.7, bottom: 0.45)
        }
    }

    private func rumble(travel: TimeInterval, travelIntensity: Float, seat: Float, seatSharp: Float, bottom: Float) {
        guard let engine else { return }
        let go = CHHapticEvent(eventType: .hapticContinuous, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: travelIntensity),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.16)
        ], relativeTime: 0, duration: travel)
        let hit = CHHapticEvent(eventType: .hapticTransient, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: seat),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: seatSharp)
        ], relativeTime: travel * 0.45)
        let stop = CHHapticEvent(eventType: .hapticTransient, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: bottom),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.2)
        ], relativeTime: travel)
        guard let pattern = try? CHHapticPattern(events: [go, hit, stop], parameters: []),
              let player = try? engine.makePlayer(with: pattern) else { return }
        try? player.start(atTime: 0)
    }
}

@MainActor
final class KlaudDictation {
    private let recognizer = SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var hasTap = false
    private var generation = 0
    var onResult: ((String, Bool, String?) -> Void)?

    func start() {
        stop()
        generation &+= 1
        let token = generation
        askMic { [weak self] mic in
            guard let self, token == self.generation else { return }
            guard mic else {
                self.onResult?("", true, "denied")
                return
            }
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                Task { @MainActor in
                    guard let self, token == self.generation else { return }
                    guard status == .authorized else {
                        self.onResult?("", true, "denied")
                        return
                    }
                    self.run(token: token)
                }
            }
        }
    }

    private func askMic(_ done: @escaping @MainActor (Bool) -> Void) {
        AVAudioApplication.requestRecordPermission { granted in
            Task { @MainActor in done(granted) }
        }
    }

    private func run(token: Int) {
        guard token == generation else { return }
        guard let recognizer, recognizer.isAvailable else {
            onResult?("", true, "unavailable")
            return
        }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            onResult?("", true, "error")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = false
        self.request = request

        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        if hasTap { input.removeTap(onBus: 0); hasTap = false }
        guard format.sampleRate > 0, format.channelCount > 0 else {
            self.request = nil
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            onResult?("", true, "unavailable")
            return
        }
        if #available(iOS 27.0, *) {
            do {
                try input.installAudioTap(
                    onBus: 0,
                    bufferSize: 1024,
                    format: format
                ) { [weak request] buffer, _ in
                    request?.append(AVAudioPCMBuffer(copying: buffer))
                }
            } catch {
                self.request = nil
                try? session.setActive(false, options: .notifyOthersOnDeactivation)
                onResult?("", true, "error")
                return
            }
        } else {
            input.installTap(
                onBus: 0,
                bufferSize: 1024,
                format: format
            ) { [weak request] buffer, _ in
                request?.append(buffer)
            }
        }

        hasTap = true
        audio.prepare()
        do {
            try audio.start()
        } catch {
            input.removeTap(onBus: 0)
            hasTap = false
            self.request = nil
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            onResult?("", true, "error")
            return
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self, token == self.generation else { return }
                if let result {
                    self.onResult?(result.bestTranscription.formattedString, result.isFinal, nil)
                    if result.isFinal { self.stop() }
                } else if error != nil {
                    self.onResult?("", true, "error")
                    self.stop()
                }
            }
        }
    }

    func stop() {
        generation &+= 1
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        if hasTap { audio.inputNode.removeTap(onBus: 0); hasTap = false }
        if audio.isRunning { audio.stop() }
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try? session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
    }
}

struct KlaudWebView: UIViewRepresentable {
    @ObservedObject var bridge: KlaudBridge
    let start: URL

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }

    func makeUIView(context: Context) -> WKWebView {
        if let existing = bridge.webView { return existing }
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()
        let installed = UserDefaults.standard.object(forKey: "AppleKeyboards") as? [String] ?? []
        let thirdParty = installed.contains { id in
            let lower = id.lowercased()
            if lower.hasPrefix("com.apple") { return false }
            if lower.contains("emoji") { return false }
            return lower.contains("com.")
        }
        let ready = UserDefaults.standard.bool(forKey: "rein.klaud.account-ready")
        let seen = UserDefaults.standard.bool(forKey: "rein.klaud.setup-seen") || ready
        let boot = """
        (function(){
          var documentNonce = (window.crypto && window.crypto.randomUUID)
            ? window.crypto.randomUUID()
            : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
          var trusted = location.protocol === 'https:' &&
            (location.hostname === 'openbot.zermo.org' || location.hostname === 'reinklaud.zermo.org') &&
            (!location.port || location.port === '443');
          if (!trusted) return;
          var native = window.klaudNative || {};
          var capabilities = Array.isArray(native.capabilities) ? native.capabilities.slice() : [];
          if (!capabilities.includes('composer.v1')) capabilities.push('composer.v1');
          window.klaudNative = Object.assign(native, {
            inApp: true,
            protocolVersion: 1,
            capabilities: capabilities,
            documentNonce: documentNonce,
            systemKeyboard: \(thirdParty ? "true" : "false")
          });
          window.klaudNative.feel = function(k){
            try { window.webkit.messageHandlers.klaud.postMessage({kind:'haptic',documentNonce:documentNonce,key:String(k||'letter')}); } catch(e) {}
          };
          window.klaudNative.dictate = function(a){
            try { window.webkit.messageHandlers.klaud.postMessage({kind:'dictate',documentNonce:documentNonce,action:String(a||'start')}); } catch(e) {}
          };
          try {
            if (\(ready ? "true" : "false")) localStorage.setItem('rein.klaud.account-ready','1');
            if (\(seen ? "true" : "false")) localStorage.setItem('rein.klaud.setup-seen','1');
          } catch(e) {}
          var originalSetItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function(k, v) {
            originalSetItem.call(this, k, v);
            if (k === 'rein.klaud.account-ready' || k === 'rein.klaud.setup-seen' || k === 'rein.klaud.setup-profile') {
              try { window.webkit.messageHandlers.klaud.postMessage({kind:'setup',documentNonce:documentNonce,key:String(k),value:String(v||'')}); } catch(e) {}
            }
          };
          window.dispatchEvent(new CustomEvent('klaud-native-ready', {detail:{protocolVersion:1,documentNonce:documentNonce}}));
          setTimeout(function(){
            if (window.__klaudLegacyNativeComposerInstalled) return;
            window.__klaudLegacyNativeComposerInstalled = true;
            var lastState = '';
            var lastLedger = null;
            var lastScrollTop = 0;
            var nativeRevision = 0;
            var activeScope = '';
            var descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            var nativeValueSetter = descriptor && descriptor.set;
            function post(message) {
              message.documentNonce = documentNonce;
              try { window.webkit.messageHandlers.klaud.postMessage(message); } catch(e) {}
            }
            function fiberIdentity(pane) {
              var key = Object.keys(pane).find(function(value){ return value.indexOf('__reactFiber$') === 0; });
              var node = key ? pane[key] : null;
              while (node) {
                var props = node.memoizedProps;
                var bot = props && props.bot;
                if (bot && typeof bot.id === 'string' && bot.id &&
                    typeof bot.sessionId === 'string' && bot.sessionId) {
                  return {botID:bot.id,sessionID:bot.sessionId,scope:bot.id+'|'+bot.sessionId};
                }
                node = node.return;
              }
              return null;
            }
            function legacyContext() {
              var panes = Array.prototype.filter.call(document.querySelectorAll('.chat-pane'), function(pane){
                var style = window.getComputedStyle(pane);
                return pane.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden';
              });
              if (panes.length !== 1) return null;
              var pane = panes[0];
              var botID = pane.getAttribute('data-bot-id') || '';
              var sessionID = pane.getAttribute('data-session-id') || '';
              var identity = botID && sessionID
                ? {botID:botID,sessionID:sessionID,scope:botID+'|'+sessionID}
                : fiberIdentity(pane);
              if (!identity) return null;
              var field = pane.querySelector('textarea.crt-input');
              var form = field && field.closest('form');
              if (!field || !form || !pane.contains(form)) return null;
              return {
                pane: pane,
                field: field,
                form: form,
                stop: pane.querySelector('.stop-run'),
                ledger: pane.querySelector('.transcript'),
                botID: identity.botID,
                sessionID: identity.sessionID,
                scope: identity.scope
              };
            }
            function report() {
              var context = legacyContext();
              var scope = context ? context.scope : '';
              if (scope !== activeScope) {
                activeScope = scope;
                nativeRevision = 0;
                lastState = '';
              }
              var field = context ? context.field : null;
              var state = {
                kind: 'composer', protocolVersion: 1, action: 'legacyState',
                visible: !!context,
                enabled: !!(field && !field.disabled),
                busy: !!(context && context.stop),
                draft: field ? String(field.value || '') : '',
                revision: nativeRevision,
                botId: context ? context.botID : '',
                sessionId: context ? context.sessionID : '',
                scope: scope
              };
              var encoded = JSON.stringify(state);
              if (encoded !== lastState) { lastState = encoded; post(state); }
              var ledger = context ? context.ledger : null;
              if (ledger && ledger !== lastLedger) {
                lastLedger = ledger;
                lastScrollTop = ledger.scrollTop;
                ledger.addEventListener('scroll', function(){
                  var next = ledger.scrollTop;
                  if (Math.abs(next - lastScrollTop) > 14) {
                    post({kind:'composer',protocolVersion:1,action:'dismiss'});
                  }
                  lastScrollTop = next;
                }, {passive:true});
              }
            }
            window.klaudLegacyNativeComposer = {
              setDraft: function(value, revision, expectedScope) {
                var context = legacyContext();
                if (!context || !expectedScope || expectedScope !== context.scope || !nativeValueSetter) return false;
                nativeRevision = Number(revision) || 0;
                nativeValueSetter.call(context.field, String(value || ''));
                context.field.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertText',data:null}));
                report();
                return true;
              },
              submit: function(expectedScope) {
                var context = legacyContext();
                if (!context || !expectedScope || expectedScope !== context.scope ||
                    context.field.disabled || !String(context.field.value || '').trim()) return false;
                if (context.form.requestSubmit) context.form.requestSubmit();
                else context.form.dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));
                return true;
              },
              stop: function(expectedScope) {
                var context = legacyContext();
                if (!context || !expectedScope || expectedScope !== context.scope || !context.stop) return false;
                context.stop.click();
                return true;
              }
            };
            var nativeStyle = document.createElement('style');
            nativeStyle.id = 'klaud-native-composer-style';
            nativeStyle.textContent = '.crt-prompt-dock,.field-kb-shell{display:none!important}';
            (document.head || document.documentElement).appendChild(nativeStyle);
            document.addEventListener('input', function(event){
              if (event.target && event.target.matches && event.target.matches('textarea.crt-input')) report();
            }, true);
            setInterval(report, 140);
            report();
          }, 400);
        })();
        """
        config.userContentController.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(context.coordinator, name: "klaud")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.scrollView.keyboardDismissMode = .interactive
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.contentInset = .zero
        view.isOpaque = true
        view.backgroundColor = UIColor(red: 0.07, green: 0.06, blue: 0.05, alpha: 1)
        bridge.webView = view
        view.load(URLRequest(url: start, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        bridge.webView = view
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let bridge: KlaudBridge
        private var documentGate = KlaudDocumentBridgeGate()
        private var activeNavigation: WKNavigation?
        init(bridge: KlaudBridge) { self.bridge = bridge }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "klaud",
                  KlaudComposerContract.trusts(message),
                  let body = message.body as? [String: Any] else { return }
            let kind = body["kind"] as? String ?? ""
            let messageEpoch = documentGate.epoch
            if kind == "haptic" {
                let key = body["key"] as? String ?? "letter"
                DispatchQueue.main.async {
                    guard self.documentGate.accepts(body, capturedEpoch: messageEpoch) else { return }
                    self.bridge.feel.tap(key)
                }
                return
            }
            if kind == "dictate" {
                let action = body["action"] as? String ?? "start"
                DispatchQueue.main.async {
                    guard self.documentGate.accepts(body, capturedEpoch: messageEpoch) else { return }
                    if action == "stop" { self.bridge.stopDictation() } else { self.bridge.startDictation() }
                }
                return
            }
            if kind == "composer" {
                DispatchQueue.main.async {
                    for accepted in self.documentGate.receiveComposer(body, capturedEpoch: messageEpoch) {
                        self.bridge.receiveComposerMessage(accepted)
                    }
                }
                return
            }
            if kind == "setup" {
                let key = body["key"] as? String ?? ""
                DispatchQueue.main.async {
                    guard self.documentGate.accepts(body, capturedEpoch: messageEpoch) else { return }
                    if key == "rein.klaud.account-ready" || key == "rein.klaud.setup-seen" {
                        UserDefaults.standard.set(true, forKey: key)
                    }
                    if key == "rein.klaud.setup-profile" {
                        UserDefaults.standard.set(true, forKey: "rein.klaud.setup-seen")
                    }
                }
                return
            }
            guard body["bytes"] is String else { return }
            let action = body["action"] as? String ?? "share"
            let name = body["name"] as? String ?? "file"
            let mime = body["mime"] as? String ?? "application/octet-stream"
            let b64 = body["bytes"] as? String ?? ""
            guard let data = Data(base64Encoded: b64) else { return }
            bridge.handoff(action: action, name: name, mime: mime, bytes: data)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            documentGate.beginNavigation()
            activeNavigation = nil
            bridge.resetComposerTransport()
            webView.load(URLRequest(url: klaudOrigin, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            documentGate.beginNavigation()
            activeNavigation = navigation
            bridge.resetComposerTransport()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            guard navigation === activeNavigation else { return }
            documentGate.failNavigation()
            activeNavigation = nil
            bridge.fault = error.localizedDescription
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            guard navigation === activeNavigation else { return }
            documentGate.failNavigation()
            activeNavigation = nil
            let code = (error as NSError).code
            if code == NSURLErrorCancelled { return }
            bridge.fault = error.localizedDescription
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard navigation === activeNavigation else { return }
            bridge.fault = nil
            activeNavigation = nil
            let host = webView.url?.host?.lowercased() ?? ""
            guard host == "openbot.zermo.org" || host == "reinklaud.zermo.org" else {
                documentGate.failNavigation()
                bridge.resetComposerTransport()
                return
            }

            let finishedEpoch = documentGate.epoch
            webView.evaluateJavaScript("window.klaudNative&&window.klaudNative.documentNonce") { result, _ in
                DispatchQueue.main.async {
                    guard self.documentGate.epoch == finishedEpoch,
                          self.documentGate.navigationInProgress else { return }
                    guard let nonce = result as? String, !nonce.isEmpty else {
                        self.documentGate.failNavigation()
                        self.bridge.fault = "Native composer security handshake failed."
                        return
                    }
                    let pending = self.documentGate.commit(
                        nonce: nonce,
                        capturedEpoch: finishedEpoch
                    )
                    guard self.documentGate.committedNonce == nonce,
                          !self.documentGate.navigationInProgress else { return }
                    UserDefaults.standard.set(true, forKey: "rein.klaud.account-ready")
                    for message in pending { self.bridge.receiveComposerMessage(message) }
                }
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url, let host = url.host?.lowercased() else {
                decisionHandler(.cancel)
                return
            }
            if host == "openbot.zermo.org" || host == "auth.zermo.org" || host.hasSuffix(".zermo.org") {
                decisionHandler(.allow)
                return
            }
            if url.scheme == "http" || url.scheme == "https" {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
                webView.load(URLRequest(url: url))
            }
            return nil
        }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            let trusted = KlaudComposerContract.trusts(
                scheme: origin.protocol,
                host: origin.host,
                port: origin.port,
                isMainFrame: frame.isMainFrame
            )
            decisionHandler(trusted ? .grant : .deny)
        }
    }
}
