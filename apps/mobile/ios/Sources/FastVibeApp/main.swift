import SwiftUI
import FastVibeUI

@main
struct FastVibePackageApp: App {
    @StateObject private var session = MobileSessionController()

    var body: some Scene {
        WindowGroup {
            FastVibeRootView(session: session)
                .onOpenURL { session.handleOAuthCallback($0) }
        }
    }
}
