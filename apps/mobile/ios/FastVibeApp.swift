import SwiftUI
import FastVibeUI

@main
struct FastVibeApp: App {
    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if let launch = SimulatorPrototypeLaunch() {
                SimulatorPrototypeView(launch: launch)
            } else {
                OrdinaryApplicationView()
            }
            #else
            OrdinaryApplicationView()
            #endif
        }
    }
}

/// Construct the session only after the launch-only fixture branch has been ruled out.
private struct OrdinaryApplicationView: View {
    @StateObject private var session = MobileSessionController()

    var body: some View {
        FastVibeRootView(session: session)
            .onOpenURL { session.handleOAuthCallback($0) }
    }
}
