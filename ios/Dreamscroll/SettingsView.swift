import SafariServices
import SwiftUI
import VisionKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @State private var blockInSafari = SharedSettings.blockInSafari
    /// Whether the user turned the blocker on in Safari's settings (nil: unknown yet).
    @State private var blockerEnabled: Bool?
    @State private var syncURL = UserDefaults.standard.string(forKey: "syncEndpoint") ?? ""
    @State private var syncToken = ""
    @State private var syncMessage: String?
    @State private var syncConfigured = SyncSettings.current != nil
    @State private var scanning = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Block X and Instagram in Safari", isOn: $blockInSafari)
                        .tint(Theme.accent)
                } footer: {
                    Text("x.com, twitter.com and instagram.com won’t load in Safari. To open a link there, tap Share › Dreamscroll.")
                }

                if blockInSafari {
                    Section {
                        HStack {
                            Text("Safari extension")
                            Spacer()
                            switch blockerEnabled {
                            case .some(true): Label("On", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.accent)
                            case .some(false): Text("Off").foregroundStyle(Theme.error)
                            case .none: ProgressView()
                            }
                        }
                        if blockerEnabled == false {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Turn it on once:").font(.subheadline.weight(.semibold))
                                Text("Settings › Apps › Safari › Extensions › Dreamscroll › Allow Extension")
                                    .font(.subheadline).foregroundStyle(Theme.muted)
                            }
                            .padding(.vertical, 4)
                        }
                    } footer: {
                        Text("iOS requires you to allow content blockers yourself; apps can’t turn them on.")
                    }
                }

                Section("Accounts") {
                    ForEach(Site.allCases) { site in
                        HStack {
                            Circle().fill(model.signedIn[site] == true ? Theme.accent : Theme.edge).frame(width: 8, height: 8)
                            Text(site.name)
                            Text(model.signedIn[site] == true ? "Signed in" : "Signed out").foregroundStyle(Theme.muted)
                            Spacer()
                            if model.signedIn[site] == true {
                                Button("Sign out", role: .destructive) { Task { await model.signOut(site) } }
                            } else {
                                Button("Sign in") { dismiss(); model.signIn(site) }
                            }
                        }
                    }
                }

                Section {
                    if DataScannerViewController.isSupported {
                        Button { scanning = true } label: { Label("Scan QR code", systemImage: "qrcode.viewfinder") }
                    }
                    // A String (not a string literal key), so SwiftUI doesn't render the URL as a link.
                    TextField(String("https://your-sync-server.example"), text: $syncURL)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField(syncConfigured ? "Token saved · paste to replace" : "Sync token", text: $syncToken)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    HStack {
                        Button("Save") { Task { await saveSync() } }
                        Spacer()
                        if syncConfigured { Button("Use this device only", role: .destructive) { clearSync() } }
                    }
                    if let syncMessage { Text(syncMessage).font(.footnote).foregroundStyle(Theme.muted) }
                } header: {
                    Text("Sync (optional)")
                } footer: {
                    Text("Shares the For You batch with the browser extension. In the extension, open Sync › QR for iPhone and scan it here. The token is kept in the Keychain.")
                }

                Section("Opening links") {
                    Text("From any app, hold an X or Instagram link, tap Share, then Dreamscroll. It opens here with feeds hidden.")
                        .foregroundStyle(Theme.muted)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .tint(Theme.ink)
        .sheet(isPresented: $scanning) {
            QRScanner { payload in
                scanning = false
                guard let settings = SyncSettings.from(link: payload) else {
                    syncMessage = "That isn’t a Dreamscroll sync code."
                    return
                }
                syncURL = settings.endpoint.absoluteString
                Task { await save(settings) }
            }
            .ignoresSafeArea()
        }
        .task { await refreshBlocker() }
        .onChange(of: phase) { _, phase in if phase == .active { Task { await refreshBlocker() } } }
        .onChange(of: blockInSafari) { _, value in
            SharedSettings.blockInSafari = value
            Task { await reloadBlocker() }
        }
    }

    private func saveSync() async {
        do {
            // An empty token field keeps the saved token, but only for the same server.
            let current = SyncSettings.current
            let settings = try SyncSettings.make(endpoint: syncURL, token: syncToken.isEmpty ? (current?.token ?? "") : syncToken)
            if syncToken.isEmpty, settings.endpoint != current?.endpoint { throw FeedStore.RemoteError.failed("Enter the sync token for this server.") }
            await save(settings)
        } catch {
            syncMessage = (error as? FeedStore.RemoteError)?.message ?? error.localizedDescription
        }
    }

    private func save(_ settings: SyncSettings) async {
        syncMessage = "Checking…"
        do {
            try await FeedStore.shared.verify(settings)
            settings.save()
            syncToken = ""
            syncConfigured = true
            syncMessage = "Synced."
            await model.refreshFeed()
        } catch {
            syncMessage = (error as? FeedStore.RemoteError)?.message ?? error.localizedDescription
        }
    }

    private func clearSync() {
        SyncSettings.clear()
        syncConfigured = false
        syncMessage = "This device keeps its own limits now."
        Task { await model.refreshFeed() }
    }

    private func refreshBlocker() async {
        blockerEnabled = (try? await SFContentBlockerManager.stateOfContentBlocker(withIdentifier: SharedSettings.blockerIdentifier))?.isEnabled ?? false
    }

    private func reloadBlocker() async {
        try? await SFContentBlockerManager.reloadContentBlocker(withIdentifier: SharedSettings.blockerIdentifier)
    }
}
