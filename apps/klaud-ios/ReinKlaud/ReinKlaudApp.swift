import SwiftUI

@main
struct ReinKlaudApp: App {
    @StateObject private var store = ReinAppStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(store: store)
                .environmentObject(store.sounds)
                .preferredColorScheme(store.state.shell.theme.dark ? .dark : .light)
                .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await store.didBecomeActive() } } }
        }
    }
}
