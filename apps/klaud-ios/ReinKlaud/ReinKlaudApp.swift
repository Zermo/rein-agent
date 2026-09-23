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

private let klaudOrigin = URL(string: "https://reinklaud.zermo.org/")!

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

    private var composerScope: KlaudComposerScope?
    private var drafts: [KlaudComposerScope: DraftRecord] = [:]
    private var pendingSends: [String: KlaudPendingComposerSend] = [:]
    private var submitLatches: [KlaudComposerScope: SubmitLatch] = [:]
    private var composerDocumentNonce: String?
    private var webEdits: [KlaudComposerScope: (document: String, revision: Int)] = [:]
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
        composerDocumentNonce = nil
        hideComposer()
    }

    private func endComposerEditing() {
        stopDictation()
        if let editor = composerTextView, editor.markedTextRange != nil {
            editor.unmarkText()
            setComposerDraft(editor.text)
        }
        composerTextView?.resignFirstResponder()
    }

    private func hideComposer() {
        endComposerEditing()
        persistCurrentDraft()
        composerScope = nil
        composerVisible = false
        composerEnabled = false
        composerBusy = false
        composerSubmitting = !submitLatches.isEmpty
        composerDeliveryUncertain = !submitLatches.isEmpty
        requestKeyboardDismissal()
    }

    func receiveComposerMessage(_ body: [String: Any]) {
        guard KlaudComposerContract.integer(body["protocolVersion"]) == KlaudComposerContract.version,
              let action = body["action"] as? String,
              let nonce = KlaudComposerContract.identifier(body["documentNonce"]) else { return }
        if action == "hello" {
            guard let scope = KlaudComposerContract.scope(from: body),
                  let requestID = KlaudComposerContract.identifier(body["requestId"]) else { return }
            composerDocumentNonce = nonce
            emitComposerCommand(["action": "ready", "requestId": requestID], scope: scope)
            return
        }
        guard composerDocumentNonce == nonce else { return }
        switch action {
        case "state": updateComposerState(body)
        case "sendAck": receiveSendAcknowledgement(body)
        case "dismiss": requestKeyboardDismissal()
        default: break
        }
    }

    var composerWithinLimit: Bool {
        composerText.utf8.count <= KlaudComposerContract.maximumUTF8Count
    }

    private var composerTextIsReady: Bool {
        guard composerWithinLimit, !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard let editor = composerTextView else { return true }
        return editor.markedTextRange == nil &&
            editor.text.utf8.count <= KlaudComposerContract.maximumUTF8Count &&
            editor.text.utf8.elementsEqual(composerText.utf8)
    }

    func setComposerDraft(_ text: String) {
        // Keep the local composition intact; the outbound boundary enforces its byte limit.
        // Swift String equality is canonical, not byte-exact; revisions must track the actual UTF-8.
        guard !text.utf8.elementsEqual(composerText.utf8) else { return }
        composerText = text
        composerRevision &+= 1
        persistCurrentDraft()
        emitComposerCommand([
            "action": "draft",
            "revision": composerRevision,
            "text": text
        ])
    }

    func submitComposer() {
        guard composerEnabled, !composerBusy, submitLatches.isEmpty, let composerScope,
              composerTextIsReady else { return }
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
        emitComposerCommand([
            "action": "send",
            "requestId": requestID,
            "revision": composerRevision,
            "text": composerText
        ])
    }

    func stopRun() {
        guard composerBusy, composerScope != nil else { return }
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
        guard composerTextIsReady else { return }
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
              composerText.utf8.elementsEqual(snapshot.text.utf8) else {
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

    private func updateComposerState(_ body: [String: Any]) {
        guard let visible = KlaudComposerContract.boolean(body["visible"]) else { return }
        if !visible { hideComposer(); return }
        guard let nextScope = KlaudComposerContract.scope(from: body),
              let remoteDraft = body["draft"] as? String,
              remoteDraft.utf8.count <= KlaudComposerContract.maximumUTF8Count,
              let nextEnabled = KlaudComposerContract.boolean(body["enabled"]),
              let nextBusy = KlaudComposerContract.boolean(body["busy"]),
              let webRevision = KlaudComposerContract.integer(body["webRevision"]),
              let document = composerDocumentNonce else { return }
        let changedScope = composerScope != nextScope
        let editedOnWeb = webRevision > 0 &&
            (webEdits[nextScope]?.document != document || webRevision > (webEdits[nextScope]?.revision ?? 0))
        if changedScope {
            endComposerEditing()
            persistCurrentDraft()
            composerScope = nextScope
            let record = drafts[nextScope] ?? DraftRecord(text: "", revision: 0)
            composerText = record.text
            composerRevision = record.revision
        }
        if editedOnWeb {
            composerText = remoteDraft
            composerRevision &+= 1
            webEdits[nextScope] = (document, webRevision)
        }
        persistCurrentDraft()
        if !nextEnabled || nextBusy { stopDictation() }
        composerVisible = true
        composerEnabled = nextEnabled
        composerBusy = nextBusy
        composerSubmitting = !submitLatches.isEmpty
        // Busy is optimistic UI state, never evidence that this send was accepted.
        if changedScope || editedOnWeb || !remoteDraft.utf8.elementsEqual(composerText.utf8) {
            emitComposerCommand(["action": "draft", "revision": composerRevision, "text": composerText])
        }
    }

    private func receiveSendAcknowledgement(_ body: [String: Any]) {
        guard let requestID = body["requestId"] as? String,
              let pending = pendingSends[requestID],
              KlaudComposerContract.scope(from: body) == pending.scope,
              KlaudComposerContract.integer(body["revision"]) == pending.revision,
              let accepted = KlaudComposerContract.boolean(body["accepted"]) else { return }
        guard accepted else {
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
           composerText.utf8.elementsEqual(pending.text.utf8) {
            setComposerDraft("")
            return
        }
        if let record = drafts[pending.scope],
           record.revision == pending.revision,
           record.text.utf8.elementsEqual(pending.text.utf8) {
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

    private func persistCurrentDraft() {
        guard let composerScope else { return }
        drafts[composerScope] = DraftRecord(text: composerText, revision: composerRevision)
    }

    private func emitComposerCommand(_ values: [String: Any], scope: KlaudComposerScope? = nil) {
        guard let composerScope = scope ?? composerScope, let nonce = composerDocumentNonce else { return }
        if let text = values["text"] as? String, text.utf8.count > KlaudComposerContract.maximumUTF8Count { return }
        var payload = values
        payload["documentNonce"] = nonce
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
        let source = "if(window.klaudNative&&window.klaudNative.documentNonce===\(Self.json(nonce))){window.dispatchEvent(new CustomEvent('\(KlaudComposerContract.eventName)',{detail:\(json)}))}"
        webView?.evaluateJavaScript(source, completionHandler: nil)
    }

    fileprivate static func json(_ value: String) -> String {
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
          var documentNonce = window.crypto && window.crypto.randomUUID && window.crypto.randomUUID();
          if (!documentNonce) return;
          var trusted = location.protocol === 'https:' &&
            (location.hostname === 'openbot.zermo.org' || location.hostname === 'reinklaud.zermo.org') &&
            (!location.port || location.port === '443');
          if (!trusted) return;
          var native = window.klaudNative || {};
          var capabilities = Array.isArray(native.capabilities) ? native.capabilities.slice() : [];
          if (!capabilities.includes('composer.v2')) capabilities.push('composer.v2');
          window.klaudNative = Object.assign(native, {
            inApp: true,
            protocolVersion: 2,
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
          window.dispatchEvent(new CustomEvent('klaud-native-ready', {detail:{protocolVersion:2,documentNonce:documentNonce}}));
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
                    if let accepted = self.documentGate.receiveComposer(body, capturedEpoch: messageEpoch) {
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
            if code == NSURLErrorCancelled {
                documentGate.beginNavigation()
                commitCurrentDocument(webView)
                return
            }
            bridge.fault = error.localizedDescription
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard navigation === activeNavigation else { return }
            bridge.fault = nil
            activeNavigation = nil
            commitCurrentDocument(webView)
        }

        private func commitCurrentDocument(_ webView: WKWebView) {
            let finishedEpoch = documentGate.epoch
            webView.evaluateJavaScript("({nonce:window.klaudNative&&window.klaudNative.documentNonce,scheme:window.location.protocol,host:window.location.hostname,port:window.location.port})") { result, _ in
                DispatchQueue.main.async {
                    guard self.documentGate.epoch == finishedEpoch,
                          self.documentGate.navigationInProgress else { return }
                    guard let page = result as? [String: Any],
                          let nonce = KlaudComposerContract.identifier(page["nonce"]),
                          page["scheme"] as? String == "https:",
                          let host = page["host"] as? String,
                          let port = page["port"] as? String,
                          (port.isEmpty || port == "443"),
                          KlaudComposerContract.allowedHosts.contains(host) else {
                        self.documentGate.failNavigation()
                        self.bridge.resetComposerTransport()
                        return
                    }
                    guard self.documentGate.commit(nonce: nonce, capturedEpoch: finishedEpoch) else { return }
                    UserDefaults.standard.set(true, forKey: "rein.klaud.account-ready")
                    // Precommit messages were discarded. Ask the committed document to negotiate again.
                    webView.evaluateJavaScript("if(window.klaudNative&&window.klaudNative.documentNonce===\(KlaudBridge.json(nonce))){window.dispatchEvent(new Event('klaud-native-ready'))}")
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
