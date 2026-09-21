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

    var body: some View {
        ZStack {
            Color(red: 0.93, green: 0.89, blue: 0.82).ignoresSafeArea()
            KlaudWebView(bridge: bridge, start: klaudOrigin)
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

final class KlaudBridge: NSObject, ObservableObject {
    @Published var fault: String?
    @Published var shareItem: ShareItem?
    weak var webView: WKWebView?
    let feel = KlaudKeyFeel()
    let dictation = KlaudDictation()

    func reload() {
        fault = nil
        webView?.load(URLRequest(url: klaudOrigin, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
    }

    func handoff(action: String, name: String, mime: String, bytes: Data) {
        let safe = (name as NSString).lastPathComponent
            .replacingOccurrences(of: "/", with: "")
            .replacingOccurrences(of: ":", with: "")
        let file = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(safe.isEmpty ? "klaudbot.bin" : safe)
        try? bytes.write(to: file, options: .atomic)
        DispatchQueue.main.async { self.shareItem = ShareItem(url: file) }
        _ = action
        _ = mime
    }
}

final class KlaudKeyFeel {
    private var engine: CHHapticEngine?
    private var ready = false

    func prepare() {
        guard !ready else { return }
        ready = true
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        engine = try? CHHapticEngine()
        engine?.resetHandler = { [weak self] in try? self?.engine?.start() }
        engine?.stoppedHandler = { [weak self] _ in try? self?.engine?.start() }
        try? engine?.start()
    }

    func tap() {
        prepare()
        guard let engine else { return }
        let travel = CHHapticEvent(eventType: .hapticContinuous, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.34),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.18)
        ], relativeTime: 0, duration: 0.026)
        let seat = CHHapticEvent(eventType: .hapticTransient, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: 1.0),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.95)
        ], relativeTime: 0.01)
        let bottom = CHHapticEvent(eventType: .hapticTransient, parameters: [
            CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.58),
            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.22)
        ], relativeTime: 0.022)
        guard let pattern = try? CHHapticPattern(events: [travel, seat, bottom], parameters: []),
              let player = try? engine.makePlayer(with: pattern) else { return }
        try? player.start(atTime: 0)
    }
}

final class KlaudDictation {
    private let recognizer = SFSpeechRecognizer()
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var hasTap = false
    weak var webView: WKWebView?

    func start() {
        stop()
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard status == .authorized else {
                self?.js("window.klaudNative&&window.klaudNative.onDictate&&window.klaudNative.onDictate('',true,'denied')")
                return
            }
            DispatchQueue.main.async { self?.run() }
        }
    }

    private func run() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
        try? session.setActive(true, options: .notifyOthersOnDeactivation)
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request
        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        if hasTap { input.removeTap(onBus: 0); hasTap = false }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        hasTap = true
        audio.prepare()
        try? audio.start()
        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.js("window.klaudNative&&window.klaudNative.onDictate&&window.klaudNative.onDictate(\(Self.json(result.bestTranscription.formattedString)),\(result.isFinal),'')")
                if result.isFinal { self.stop() }
            } else if error != nil {
                self.js("window.klaudNative&&window.klaudNative.onDictate&&window.klaudNative.onDictate('',true,'error')")
                self.stop()
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if hasTap { audio.inputNode.removeTap(onBus: 0); hasTap = false }
        if audio.isRunning { audio.stop() }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func js(_ source: String) {
        DispatchQueue.main.async { self.webView?.evaluateJavaScript(source, completionHandler: nil) }
    }

    private static func json(_ value: String) -> String {
        let data = (try? JSONEncoder().encode(value)) ?? Data("\"\"".utf8)
        return String(data: data, encoding: .utf8) ?? "\"\""
    }
}

struct KlaudWebView: UIViewRepresentable {
    @ObservedObject var bridge: KlaudBridge
    let start: URL

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }

    func makeUIView(context: Context) -> WKWebView {
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
        let boot = "window.klaudNative=Object.assign(window.klaudNative||{},{inApp:true,systemKeyboard:\(thirdParty ? "true" : "false")});"
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
        bridge.dictation.webView = view
        view.load(URLRequest(url: start, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        bridge.webView = view
        bridge.dictation.webView = view
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let bridge: KlaudBridge
        init(bridge: KlaudBridge) { self.bridge = bridge }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "klaud", let body = message.body as? [String: Any] else { return }
            let kind = body["kind"] as? String ?? ""
            if kind == "haptic" {
                DispatchQueue.main.async { self.bridge.feel.tap() }
                return
            }
            if kind == "dictate" {
                let action = body["action"] as? String ?? "start"
                DispatchQueue.main.async {
                    self.bridge.dictation.webView = self.bridge.webView
                    if action == "stop" { self.bridge.dictation.stop() } else { self.bridge.dictation.start() }
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

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            bridge.fault = error.localizedDescription
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let code = (error as NSError).code
            if code == NSURLErrorCancelled { return }
            bridge.fault = error.localizedDescription
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            bridge.fault = nil
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
            decisionHandler(.grant)
        }
    }
}
