import SwiftUI
import WebKit

@MainActor
@Observable
final class AppModel: FeedHost {
    var site: Site = .x
    var browser: BrowserController?
    var notice: Notice?
    var signedIn: [Site: Bool] = [:]
    var showSettings = false
    /// The X For You snapshot and the daily budget (dashboard panel).
    var feed: FeedStore.Summary?
    var capturing = false
    /// Sync details from a dreamscroll://sync link, waiting for the user to accept them.
    var syncOffer: SyncSettings?
    @ObservationIgnored private var pendingSync: SyncSettings?
    /// Something to open once the current page has finished closing.
    @ObservationIgnored private var afterDismiss: (() async -> Void)?
    /// A shared link that arrived while a page was open: opened after it closes.
    @ObservationIgnored private var pending: URL?

    struct Notice: Equatable {
        let text: String
        var isError = false
    }

    private let policy = PolicyEngine.shared

    enum Action: String { case notifications, messages, compose, saved }

    func url(for action: Action, on site: Site) -> URL? {
        switch (site, action) {
        case (.x, .notifications): URL(string: "https://x.com/notifications")
        case (.x, .messages): URL(string: "https://x.com/i/chat")
        case (.x, .compose): URL(string: "https://x.com/compose/post")
        // Mobile web has a real activity page (desktop uses a side panel instead).
        case (.instagram, .notifications): URL(string: "https://www.instagram.com/accounts/activity/")
        case (.instagram, .messages): URL(string: "https://www.instagram.com/direct/inbox/")
        case (.instagram, .compose): nil
        // Saved posts: X's Bookmarks; on Instagram, home is the start page where content.js
        // finds your /<you>/saved/ (allowed only in a browser opened for it).
        case (.x, .saved): URL(string: "https://x.com/i/bookmarks")
        case (.instagram, .saved): URL(string: "https://www.instagram.com/")
        }
    }

    func open(_ action: Action, on site: Site) async {
        guard let url = url(for: action, on: site) else { return }
        if site == .instagram && action == .saved {
            notice = nil
            present(BrowserRequest(url: url, site: site, mode: .browse, start: action.rawValue))
            return
        }
        await open(url, site: site)
    }

    func open(_ url: URL, site: Site, mode: BrowserRequest.Mode = .browse) async {
        // Every destination goes through the same policy as the extension.
        if mode == .browse {
            guard let view = await policy.view(url), view.isDestination else {
                notice = Notice(text: "That isn’t a destination Dreamscroll opens.", isError: true)
                return
            }
        }
        notice = nil
        present(BrowserRequest(url: url, site: site, mode: mode))
    }

    private func present(_ request: BrowserRequest) {
        browser = BrowserController(request: request, host: self) { [weak self] outcome in self?.browserFinished(outcome) }
    }

    // MARK: X For You snapshot and unlocked scrolling

    func refreshFeed() async {
        feed = await FeedStore.shared.apply(.state, fresh: true)
    }

    /// Takes a new snapshot from X in an invisible web view and stores it (or adopts the sync server's).
    func captureBatch() async throws {
        let tweets = try await CaptureController().run()
        feed = await FeedStore.shared.apply(.snapshot(tweets))
    }

    func openFeed() async {
        guard !capturing else { return }
        var state = await FeedStore.shared.apply(.state, fresh: true)
        if !state.active {
            capturing = true
            defer { capturing = false }
            do { try await captureBatch() } catch {
                notice = Notice(text: error.localizedDescription, isError: true)
                return
            }
            state = await FeedStore.shared.apply(.state)
        }
        feed = state
        notice = nil
        present(BrowserRequest(url: Bundled.feedPage, site: .x, mode: .feed))
    }

    func unlock() async {
        let state = await FeedStore.shared.apply(.state, fresh: true)
        feed = state
        guard state.remainingMs > 0 else {
            notice = Notice(text: "Today’s full scrolling is used up.", isError: true)
            return
        }
        notice = nil
        present(BrowserRequest(url: URL(string: "https://x.com/home")!, site: .x, mode: .unlocked, day: state.day))
    }

    /// What the one input can do with its text: open a link, or search X / open the
    /// account on X or Instagram. The first choice is what Return does.
    struct Choice: Identifiable { let id: String; let label: String; let run: () async -> Void }

    func choices(for raw: String) -> [Choice] {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return [] }
        let isLink = value.range(of: #"^(https?://)?([a-z0-9-]+\.)*(x|twitter|instagram)\.com/"#, options: [.regularExpression, .caseInsensitive]) != nil
        if isLink || value.lowercased().hasPrefix("http") {
            let link = value.lowercased().hasPrefix("http") ? value : "https://\(value)"
            return [Choice(id: "link", label: "Open link") { [weak self] in await self?.openLink(link) }]
        }
        let handle = value.hasPrefix("@") ? String(value.dropFirst()) : value
        let search = Choice(id: "search", label: "Search X for “\(value)”") { [weak self] in await self?.search(value) }
        var accounts: [Choice] = []
        if handle.range(of: #"^[A-Za-z0-9_]{1,15}$"#, options: .regularExpression) != nil {
            accounts.append(Choice(id: "x", label: "@\(handle) on X") { [weak self] in await self?.openProfile(handle, on: .x) })
        }
        if handle.range(of: #"^[A-Za-z0-9_.]{1,30}$"#, options: .regularExpression) != nil {
            accounts.append(Choice(id: "ig", label: "@\(handle) on Instagram") { [weak self] in await self?.openProfile(handle, on: .instagram) })
        }
        return value.hasPrefix("@") ? accounts + [search] : [search] + accounts
    }

    func openProfile(_ raw: String, on site: Site) async {
        let handle = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "@", with: "")
        guard !handle.isEmpty, let encoded = handle.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "._"))),
              let url = URL(string: site == .x ? "https://x.com/\(encoded)" : "https://www.instagram.com/\(encoded)/"),
              await policy.view(url)?.kind == "profile" else {
            notice = Notice(text: "Enter a valid \(site.name) username.", isError: true)
            return
        }
        await open(url, site: site)
    }

    func search(_ raw: String) async {
        let query = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var components = URLComponents(string: "https://x.com/search")!
        components.queryItems = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "src", value: "typed_query")]
        guard !query.isEmpty, let url = components.url else {
            notice = Notice(text: "Enter something to search for.", isError: true)
            return
        }
        await open(url, site: .x)
    }

    func openLink(_ raw: String) async {
        guard let url = await policy.destination(raw) else {
            notice = Notice(text: "Paste a full link to an X or Instagram post, account, or conversation.", isError: true)
            return
        }
        let site: Site = url.host?.contains("instagram") == true ? .instagram : .x
        self.site = site
        await open(url, site: site)
    }

    /// dreamscroll://open?url=<link>, from the share extension or Shortcuts;
    /// dreamscroll://sync?endpoint=…&token=…, from the extension's QR code.
    func handleIncoming(_ url: URL) {
        if url.scheme == "dreamscroll", url.host == "sync" {
            guard let offer = SyncSettings.from(link: url.absoluteString) else {
                notice = Notice(text: "That sync code isn’t valid. Show a new one in the extension.", isError: true)
                return
            }
            // Ask on the dashboard. A page that's open stays open (it may hold a draft):
            // the question waits until it's closed.
            if browser != nil || showSettings { pendingSync = offer }
            else { syncOffer = offer }
            return
        }
        guard url.scheme == "dreamscroll", url.host == "open",
              let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "url" })?.value else { return }
        Task {
            // Anything on screen must close first; the link opens once it's gone.
            if browser != nil || showSettings, let link = URL(string: raw) {
                pending = link
                browser = nil
                showSettings = false
                return
            }
            await openLink(raw)
        }
    }

    func signIn(_ site: Site) {
        self.site = site
        present(BrowserRequest(url: site.loginURL, site: site, mode: .signIn))
    }

    func signOut(_ site: Site) async {
        let store = WKWebsiteDataStore.default()
        let records = await store.dataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes())
        let matching = records.filter { $0.displayName.contains(site.cookieDomain) || (site == .x && $0.displayName.contains("twitter.com")) }
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), for: matching)
        await CookieVault.shared.save()
        await refreshSessions()
        notice = Notice(text: "Signed out of \(site.name).")
    }

    func refreshSessions() async {
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        let now = Date()
        for site in Site.allCases {
            signedIn[site] = cookies.contains { cookie in
                cookie.name == site.sessionCookie && cookie.domain.hasSuffix(site.cookieDomain) && (cookie.expiresDate ?? .distantFuture) > now
            }
        }
    }

    func browserFinished(_ outcome: BrowserController.Outcome) {
        browser = nil
        switch outcome {
        case .closed: notice = nil
        case .blockedFeed(let site): notice = Notice(text: "That was \(site.name)’s feed, so it closed. Pick somewhere specific. ")
        case .signedIn: notice = nil
        case .unlock: afterDismiss = { [weak self] in await self?.unlock() }
        case .budgetUsed: notice = Notice(text: "That’s today’s full scrolling. The feed batch is still on the dashboard.")
        }
        Task { await refreshFeed() }
        Task {
            await CookieVault.shared.save()
            await refreshSessions()
            // Only claim success when the site actually set its session cookie.
            if case .signedIn(let site) = outcome {
                notice = signedIn[site] == true
                    ? Notice(text: "Signed in to \(site.name).")
                    : Notice(text: "\(site.name)’s sign-in didn’t finish. Try again.", isError: true)
            }
        }
    }

    /// Called when the page or Settings finishes dismissing.
    /// Verifies the details with the sync server before saving them.
    func acceptSync(_ settings: SyncSettings) async {
        do {
            try await FeedStore.shared.verify(settings)
            settings.save()
            notice = Notice(text: "Synced.")
            await refreshFeed()
        } catch {
            notice = Notice(text: (error as? FeedStore.RemoteError)?.message ?? error.localizedDescription, isError: true)
        }
    }

    func browserDismissed() {
        if let offer = pendingSync { pendingSync = nil; syncOffer = offer; return }
        if let next = afterDismiss { afterDismiss = nil; Task { await next() }; return }
        guard let link = pending else { return }
        pending = nil
        Task { await openLink(link.absoluteString) }
    }
}
