import AVFoundation
import Foundation

protocol SoundPreferenceStore: Sendable {
    func enabled() -> Bool
    func setEnabled(_ enabled: Bool)
}

struct DefaultsSoundPreferenceStore: SoundPreferenceStore, @unchecked Sendable {
    static let key = "rein-klaud:sound-effects:v1"
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    func enabled() -> Bool { defaults.object(forKey: Self.key) == nil || defaults.bool(forKey: Self.key) }
    func setEnabled(_ enabled: Bool) { defaults.set(enabled, forKey: Self.key) }
}

enum ReinSoundCue: String, CaseIterable, Sendable { case hover, click, key, send, tool, reply, error, ready }

@MainActor
final class ReinSoundEngine: ObservableObject {
    @Published var enabled: Bool
    private let preference: SoundPreferenceStore
    private var players: [ReinSoundCue: [AVAudioPlayer]] = [:]
    private var nextPlayer: [ReinSoundCue: Int] = [:]
    private var lastPlayed: [ReinSoundCue: TimeInterval] = [:]
    private var configuredSession = false
    private let cooldown: [ReinSoundCue: TimeInterval] = [.hover: 0.05, .click: 0.025, .key: 0.012, .send: 0.1, .tool: 0.26, .reply: 0.3, .error: 0.5, .ready: 0.4]

    init(preference: SoundPreferenceStore = DefaultsSoundPreferenceStore()) {
        self.preference = preference
        self.enabled = preference.enabled()
    }

    func setEnabled(_ value: Bool) {
        enabled = value; preference.setEnabled(value)
        if !value { players.values.flatMap { $0 }.forEach { $0.stop() } }
    }

    func play(_ cue: ReinSoundCue) {
        guard enabled else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let previous = lastPlayed[cue], now - previous < (cooldown[cue] ?? 0) { return }
        do {
            let session = AVAudioSession.sharedInstance()
            if !configuredSession {
                try session.setCategory(.ambient, options: [.mixWithOthers])
                configuredSession = true
            }
            // App switching and dictation can deactivate the shared session. Reactivate
            // for every cue; AVAudioSession makes an already-active call cheap.
            try session.setActive(true)

            var bank = players[cue] ?? []
            if bank.isEmpty {
                guard let url = Bundle.main.url(forResource: cue.rawValue, withExtension: "wav") else { return }
                bank = try (0..<4).map { _ in
                    let player = try AVAudioPlayer(contentsOf: url)
                    player.volume = 0.94
                    player.prepareToPlay()
                    return player
                }
                players[cue] = bank
            }
            let index = (nextPlayer[cue] ?? 0) % bank.count
            nextPlayer[cue] = index + 1
            let player = bank[index]
            lastPlayed[cue] = now
            player.currentTime = 0
            player.prepareToPlay()
            player.play()
        } catch {
            configuredSession = false
        }
    }
}
