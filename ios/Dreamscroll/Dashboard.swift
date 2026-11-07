import SwiftUI

enum Theme {
    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
    static let background = dynamic(0xF7F7F4, 0x121514)
    static let ink = dynamic(0x16201C, 0xE8EBE8)
    static let muted = dynamic(0x6B7570, 0x98A29D)
    static let faint = dynamic(0x9AA29E, 0x6D7671)
    static let field = dynamic(0xFFFFFF, 0x1A1E1C)
    static let line = dynamic(0xE3E5E0, 0x262B29)
    static let edge = dynamic(0xCFD4CC, 0x343B38)
    static let pressed = dynamic(0xEFF1EC, 0x1F2422)
    static let accent = dynamic(0x234E3D, 0x8CC4A2)
    static let onAccent = dynamic(0xFFFFFF, 0x0F1A15)
    static let error = dynamic(0xA3392B, 0xF0A092)
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

private struct TileStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(Theme.ink)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(RoundedRectangle(cornerRadius: 12).fill(configuration.isPressed ? Theme.pressed : Theme.field))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }
}

struct DashboardView: View {
    @Environment(AppModel.self) private var model
    @State private var input = ""
    @FocusState private var inputFocused: Bool

    var body: some View {
        @Bindable var model = model
        let choices = model.choices(for: input)
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Image("Mark").resizable().frame(width: 22, height: 22).foregroundStyle(Theme.accent)
                    Text("Dreamscroll").font(.system(size: 16, weight: .semibold))
                    Spacer()
                    Button { model.showSettings = true } label: { Image(systemName: "gearshape").frame(width: 32, height: 32) }
                        .tint(Theme.muted)
                        .accessibilityLabel("Settings")
                }
                .foregroundStyle(Theme.ink)
                .padding(.bottom, 6)

                VStack(spacing: 0) {
                    TextField("Search X, @username or link", text: $input)
                        .focused($inputFocused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.webSearch)
                        .submitLabel(.go)
                        .onSubmit { if let first = choices.first { Task { await first.run() } } }
                        .padding(.horizontal, 14).padding(.vertical, 14)
                    if inputFocused && !choices.isEmpty {
                        Divider().overlay(Theme.line)
                        ForEach(choices) { choice in
                            Button { Task { await choice.run() } } label: {
                                Text(choice.label).font(.system(size: 15)).foregroundStyle(Theme.ink)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 14).padding(.vertical, 11)
                                    .contentShape(Rectangle())
                            }
                        }
                    }
                }
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.field))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(inputFocused ? Theme.accent : Theme.edge))

                if let notice = model.notice {
                    Text(notice.text)
                        .font(.system(size: 13))
                        .foregroundStyle(notice.isError ? Theme.error : Theme.muted)
                        .padding(.horizontal, 2)
                        .transition(.opacity)
                }

                siteSection(.x)
                siteSection(.instagram)
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.background.ignoresSafeArea())
        .tint(Theme.accent)
        .animation(.default, value: model.notice)
        .fullScreenCover(item: $model.browser, onDismiss: model.browserDismissed) { controller in
            BrowserView(controller: controller)
        }
        .sheet(isPresented: $model.showSettings, onDismiss: model.browserDismissed) { SettingsView() }
        // A dreamscroll://sync link (the extension's QR code, scanned with the Camera app) asks first.
        .alert("Sync with this server?", isPresented: Binding(get: { model.syncOffer != nil }, set: { if !$0 { model.syncOffer = nil } }), presenting: model.syncOffer) { offer in
            Button("Use sync") { Task { await model.acceptSync(offer) } }
            Button("Cancel", role: .cancel) {}
        } message: { offer in
            Text("Share the For You batch with \(offer.endpoint.host ?? "this server")\(SyncSettings.current == nil ? "" : ", replacing your current sync server"). Only accept a code from your own computer.")
        }
        .task { await model.refreshSessions(); await model.refreshFeed() }
    }

    private func siteSection(_ site: Site) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(site.name).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted).padding(.horizontal, 2)
            if model.signedIn[site] == false {
                Button { model.signIn(site) } label: {
                    HStack { Text("Sign in to \(site.name)"); Spacer(); Image(systemName: "arrow.right") }
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.onAccent)
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.accent))
                }
            } else {
                if site == .x { forYou }
                HStack(spacing: 8) {
                    Button("Notifications") { Task { await model.open(.notifications, on: site) } }
                    Button("Messages") { Task { await model.open(.messages, on: site) } }
                    if site == .x { Button("Post") { Task { await model.open(.compose, on: site) } } }
                }
                .buttonStyle(TileStyle())
            }
        }
        .padding(.top, 14)
    }

    /// The X For You batch. (Unlocked scrolling still exists in AppModel; it's just not offered.)
    private var forYou: some View {
        let feed = model.feed
        let clock = { (ms: Double) in Date(timeIntervalSince1970: ms / 1000).formatted(date: .omitted, time: .shortened) }
        let status = model.capturing ? "Fetching…" : feed.map { $0.active ? "\($0.count) tweets · until \(clock($0.endsAt ?? 0))" : "\(FeedStore.Rules.batchSize) new tweets" } ?? ""
        return HStack(spacing: 8) {
            Button { Task { await model.openFeed() } } label: {
                HStack {
                    Text("For You").font(.system(size: 16, weight: .semibold))
                    Spacer(minLength: 8)
                    Text(status).font(.system(size: 13)).opacity(0.8).lineLimit(1)
                }
                .foregroundStyle(Theme.onAccent)
                .padding(.horizontal, 14).padding(.vertical, 15)
                .background(RoundedRectangle(cornerRadius: 12).fill(Theme.accent))
            }
            .disabled(model.capturing)
        }
    }
}
