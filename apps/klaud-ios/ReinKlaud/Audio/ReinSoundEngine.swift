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
    private var players: [ReinSoundCue: AVAudioPlayer] = [:]
    private var lastPlayed: [ReinSoundCue: TimeInterval] = [:]
    private var configuredSession = false
    private let cooldown: [ReinSoundCue: TimeInterval] = [.hover: 0.07, .click: 0.045, .key: 0.028, .send: 0.14, .tool: 0.26, .reply: 0.3, .error: 0.5, .ready: 0.4]

    init(preference: SoundPreferenceStore = DefaultsSoundPreferenceStore()) {
        self.preference = preference
        self.enabled = preference.enabled()
    }

    func setEnabled(_ value: Bool) {
        enabled = value; preference.setEnabled(value)
        if !value { players.values.forEach { $0.stop() } }
    }

    func play(_ cue: ReinSoundCue) {
        guard enabled else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let previous = lastPlayed[cue], now - previous < (cooldown[cue] ?? 0) { return }
        do {
            if !configuredSession {
                try AVAudioSession.sharedInstance().setCategory(.ambient, options: [.mixWithOthers])
                try AVAudioSession.sharedInstance().setActive(true)
                configuredSession = true
            }
            let player: AVAudioPlayer
            if let cached = players[cue] { player = cached }
            else {
                guard let url = Bundle.main.url(forResource: cue.rawValue, withExtension: "wav") else { return }
                player = try AVAudioPlayer(contentsOf: url); player.volume = 0.72; player.prepareToPlay(); players[cue] = player
            }
            lastPlayed[cue] = now
            player.currentTime = 0; player.play()
        } catch { /* Sounds are enhancement-only. */ }
    }
}
