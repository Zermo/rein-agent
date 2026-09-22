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

    func rejoin() {
        guard let webView else { return }
        let host = webView.url?.host?.lowercased() ?? ""
        if host == "auth.zermo.org" || host.isEmpty {
            reload()
            return
        }
        if host == "openbot.zermo.org" || host == "reinklaud.zermo.org" {
            webView.evaluateJavaScript("document.dispatchEvent(new Event('visibilitychange'))")
            return
        }
        reload()
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

final class KlaudDictation {
    private let recognizer = SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audio = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var hasTap = false
    weak var webView: WKWebView?

    func start() {
        stop()
        askMic { [weak self] mic in
            guard let self else { return }
            guard mic else {
                self.js("window.klaudNative&&window.klaudNative.onDictate&&window.klaudNative.onDictate('',true,'denied')")
                return
            }
            SFSpeechRecognizer.requestAuthorization { status in
                guard status == .authorized else {
                    self.js("window.klaudNative&&window.klaudNative.onDictate&&window.klaudNative.onDictate('',true,'denied')")
                    return
                }
                DispatchQueue.main.async { self.run() }
            }
        }
    }

    private func askMic(_ done: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async { done(granted) }
            }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async { done(granted) }
            }
        }
    }

    private func run() {
        guard let recognizer, recognizer.isAvailable else {
            js("window.klaudNative&&window.klaudNative.onDictate&&window.klaudNative.onDictate('',true,'unavailable')")
            return
        }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            js("window.klaudNative&&window.klaudNative.onDictate&&window.klaudNative.onDictate('',true,'error')")
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = false
        self.request = request
        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        if hasTap { input.removeTap(onBus: 0); hasTap = false }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        hasTap = true
        audio.prepare()
        do { try audio.start() } catch {
            js("window.klaudNative&&window.klaudNative.onDictate&&window.klaudNative.onDictate('',true,'error')")
            return
        }
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.js("window.klaudNative&&window.klaudNative.onDictate&&window.klaudNative.onDictate(\(Self.json(result.bestTranscription.formattedString)),false,'')")
            } else if error != nil {
                self.js("window.klaudNative&&window.klaudNative.onDictate&&window.klaudNative.onDictate('',true,'error')")
                self.stop()
            }
        }
    }

    func stop() {
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        if hasTap { audio.inputNode.removeTap(onBus: 0); hasTap = false }
        if audio.isRunning { audio.stop() }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true, options: .notifyOthersOnDeactivation)
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
        window.klaudNative=Object.assign(window.klaudNative||{},{inApp:true,systemKeyboard:\(thirdParty ? "true" : "false")});
        window.klaudNative.feel=function(k){try{window.webkit.messageHandlers.klaud.postMessage({kind:'haptic',key:String(k||'letter')});}catch(e){}};
        window.klaudNative.dictate=function(a){try{window.webkit.messageHandlers.klaud.postMessage({kind:'dictate',action:String(a||'start')});}catch(e){}};
        (function(){
          try {
            if (\(ready ? "true" : "false")) localStorage.setItem('rein.klaud.account-ready','1');
            if (\(seen ? "true" : "false")) localStorage.setItem('rein.klaud.setup-seen','1');
          } catch (e) {}
          var orig = Storage.prototype.setItem;
          Storage.prototype.setItem = function(k, v) {
            orig.call(this, k, v);
            if (k === 'rein.klaud.account-ready' || k === 'rein.klaud.setup-seen' || k === 'rein.klaud.setup-profile') {
              try { window.webkit.messageHandlers.klaud.postMessage({kind:'setup',key:String(k),value:String(v||'')}); } catch (e) {}
            }
          };
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
                let key = body["key"] as? String ?? "letter"
                DispatchQueue.main.async { self.bridge.feel.tap(key) }
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
            if kind == "setup" {
                let key = body["key"] as? String ?? ""
                if key == "rein.klaud.account-ready" || key == "rein.klaud.setup-seen" {
                    UserDefaults.standard.set(true, forKey: key)
                }
                if key == "rein.klaud.setup-profile" {
                    UserDefaults.standard.set(true, forKey: "rein.klaud.setup-seen")
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
            webView.load(URLRequest(url: klaudOrigin, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
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
            let host = webView.url?.host?.lowercased() ?? ""
            if host == "openbot.zermo.org" || host == "reinklaud.zermo.org" {
                UserDefaults.standard.set(true, forKey: "rein.klaud.account-ready")
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
            decisionHandler(.grant)
        }
    }
}
