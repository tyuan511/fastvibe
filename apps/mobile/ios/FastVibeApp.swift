import SwiftUI
import FastVibeUI

@main
struct FastVibeApp: App {
    @StateObject private var session = MobileSessionController()

    var body: some Scene {
        WindowGroup {
            FastVibeRootView(session: session)
                .onOpenURL { session.handleOAuthCallback($0) }
        }
    }
}
