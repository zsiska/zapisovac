import SwiftUI

@main
struct ZapisovacApp: App {
    @Environment(\.scenePhase) private var phase

    init() {
        UserDefaults.standard.register(defaults: AppSettings.defaults)
        Recovery.run()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(Library.shared)
                .environmentObject(Recorder.shared)
                .environmentObject(Processor.shared)
        }
        .onChange(of: phase) { _, now in
            if now == .active { Recorder.shared.ensureRunning() }
        }
    }
}
