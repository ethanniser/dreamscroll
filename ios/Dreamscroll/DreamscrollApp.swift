import SwiftUI

@main
struct DreamscrollApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            DashboardView()
                .environment(model)
                .tint(Theme.accent)
                .onOpenURL { model.handleIncoming($0) }
                .onChange(of: phase) { _, phase in
                    if phase == .active { Task { await model.refreshSessions() } }
                    if phase == .background { Task { await CookieVault.shared.save() } }
                }
                .task {
                    // Restore saved sign-ins before anything loads.
                    await CookieVault.shared.start()
                    await model.refreshSessions()
                }
                .onAppear { _ = PolicyEngine.shared }  // warm up the policy web view
        }
    }
}
