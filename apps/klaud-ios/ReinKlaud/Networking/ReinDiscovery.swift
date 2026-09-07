import Foundation
import Network

struct DiscoveredReinHost: Identifiable, Equatable {
    let id: String
    let name: String
    let type: String
    let domain: String
}

@MainActor
final class ReinDiscovery: ObservableObject {
    @Published private(set) var hosts: [DiscoveredReinHost] = []
    @Published private(set) var isSearching = false
    @Published private(set) var message: String?
    private var browser: NWBrowser?
    private var resolver: ServiceResolver?

    func start() {
        stop(); hosts = []; message = nil; isSearching = true
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        let browser = NWBrowser(for: .bonjour(type: "_rein-klaud._tcp", domain: nil), using: parameters)
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .failed: self.message = "I couldn't search this network."; self.stop()
                case .waiting: self.message = "Waiting for local-network access…"
                case .ready: self.message = "Searching this local network…"
                case .cancelled: self.isSearching = false
                default: break
                }
            }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let mapped = results.compactMap(Self.host(from:)).sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            Task { @MainActor in self?.hosts = mapped; self?.message = mapped.isEmpty ? "Searching this local network…" : nil }
        }
        self.browser = browser
        browser.start(queue: .global(qos: .userInitiated))
    }

    func stop() { browser?.cancel(); browser = nil; isSearching = false }

    func resolve(_ host: DiscoveredReinHost) async -> String? {
        let resolver = ServiceResolver(host: host)
        self.resolver = resolver
        let result = await resolver.resolve()
        self.resolver = nil
        if result == nil { message = "I found Rein but couldn't resolve its address. Enter the host manually." }
        return result
    }

    nonisolated private static func host(from result: NWBrowser.Result) -> DiscoveredReinHost? {
        guard case .service(let name, let type, let domain, _) = result.endpoint else { return nil }
        return DiscoveredReinHost(id: "\(name).\(type).\(domain)", name: name, type: type, domain: domain)
    }
}

private final class ServiceResolver: NSObject, NetServiceDelegate {
    private let service: NetService
    private var continuation: CheckedContinuation<String?, Never>?

    init(host: DiscoveredReinHost) {
        service = NetService(domain: host.domain, type: host.type, name: host.name)
        super.init(); service.delegate = self
    }

    func resolve() async -> String? {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            service.resolve(withTimeout: 5)
        }
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        guard let hostname = sender.hostName, sender.port > 0 else { finish(nil); return }
        let clean = hostname.hasSuffix(".") ? String(hostname.dropLast()) : hostname
        finish("http://\(clean):\(sender.port)")
    }
    func netService(_ sender: NetService, didNotResolve errorDict: [String : NSNumber]) { finish(nil) }
    private func finish(_ value: String?) { continuation?.resume(returning: value); continuation = nil; service.stop() }
}
