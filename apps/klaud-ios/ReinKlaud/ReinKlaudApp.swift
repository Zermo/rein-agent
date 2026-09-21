import SwiftUI
import WebKit
import UniformTypeIdentifiers

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

struct KlaudWebView: UIViewRepresentable {
    @ObservedObject var bridge: KlaudBridge
    let start: URL

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.allowsInlineMediaPlayback = true
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
        view.load(URLRequest(url: start, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        bridge.webView = view
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let bridge: KlaudBridge
        init(bridge: KlaudBridge) { self.bridge = bridge }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "klaud", let body = message.body as? [String: Any] else { return }
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
    }
}
