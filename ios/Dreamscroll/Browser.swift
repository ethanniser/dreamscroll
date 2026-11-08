import SwiftUI
import WebKit
import os

let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "dreamscroll", category: "browser")

struct BrowserRequest: Identifiable, Equatable {
    /// browse: a destination. signIn: X/Instagram sign-in. feed: the bundled snapshot
    /// page. unlocked: real X home for the daily budget (granted for `day`).
    enum Mode { case browse, signIn, feed, unlocked }
    let id = UUID()
    let url: URL
    let site: Site
    let mode: Mode
    var day: String? = nil
    /// An Instagram start page (P.startViews) this browser may open on Instagram home, e.g. "saved".
    var start: String? = nil
}

/// What the browser asks of the app for the feed snapshot and unlocked home.
@MainActor
protocol FeedHost: AnyObject {
    func captureBatch() async throws
}

/// Owns one WKWebView and applies the same rules as the extension's worker:
/// deliberate destinations load, feeds send you back to the dashboard.
@MainActor
@Observable
final class BrowserController: NSObject, Identifiable, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"
    let id = UUID()
    let request: BrowserRequest
    let webView: WKWebView
    var canGoBack = false
    var isLoading = true
    var title = ""
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    @ObservationIgnored private let onFinish: (BrowserController.Outcome) -> Void
    @ObservationIgnored private var finished = false
    @ObservationIgnored private var sawLogin = false
    @ObservationIgnored weak var host: FeedHost?
    /// Unlocked mode: true until the budget runs out or the day changes.
    @ObservationIgnored private var unlockValid: Bool

    enum Outcome { case closed, blockedFeed(Site), signedIn(Site), unlock, budgetUsed }

    init(request: BrowserRequest, host: FeedHost? = nil, onFinish: @escaping (Outcome) -> Void) {
        self.request = request
        self.onFinish = onFinish
        self.host = host
        self.unlockValid = request.mode == .unlocked
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()  // the app's own persistent sessions
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = .all
        Shim.userScripts(request.mode == .unlocked ? .unlocked : request.start.map { .start($0) } ?? .none).forEach(config.userContentController.addUserScript)
        // The bundled feed page talks to the app through its own handler (checked to come from the file).
        config.userContentController.addUserScript(WKUserScript(source: """
        if (location.protocol === 'file:') window.chrome = {runtime: {getURL: p => p, sendMessage: m => window.webkit.messageHandlers.dreamscrollPage.postMessage(m)}};
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        webView = WKWebView(frame: .zero, configuration: config)
        // Look like Safari so the sites serve their normal mobile web apps.
        webView.customUserAgent = Self.userAgent
        // Edge swipes go back/forward, except on the For You page, where swipes belong to the cards.
        webView.allowsBackForwardNavigationGestures = !request.url.isFileURL
        #if DEBUG
        webView.isInspectable = true  // Safari Web Inspector, for development only
        #endif
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        observations = [
            webView.observe(\.canGoBack, options: [.new]) { [weak self] web, _ in Task { @MainActor in self?.canGoBack = web.canGoBack } },
            webView.observe(\.isLoading, options: [.new]) { [weak self] web, _ in Task { @MainActor in self?.isLoading = web.isLoading } },
            webView.observe(\.title, options: [.new]) { [weak self] web, _ in Task { @MainActor in self?.title = web.title ?? "" } },
            // In-page (pushState) navigation never reaches decidePolicyFor.
            webView.observe(\.url, options: [.new]) { [weak self] web, _ in
                guard let url = web.url else { return }
                Task { @MainActor in await self?.urlChanged(url) }
            },
        ]
        // Weak relay: the content controller retains its handlers.
        let relay = MessageRelay(self)
        config.userContentController.addScriptMessageHandler(relay, contentWorld: Shim.world, name: "dreamscroll")
        config.userContentController.addScriptMessageHandler(relay, contentWorld: .page, name: "dreamscrollPage")
        if request.url.isFileURL { webView.loadFileURL(request.url, allowingReadAccessTo: request.url.deletingLastPathComponent()) }
        else { webView.load(URLRequest(url: request.url)) }
    }

    // MARK: Messages from the page scripts (X) and the feed page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        let body = message.body as? [String: Any] ?? [:]
        let type = body["type"] as? String ?? ""
        let store = FeedStore.shared
        if message.name == "dreamscrollPage" {
            // Only the bundled feed page (a file origin) may use this handler.
            guard request.mode == .feed, message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "file" else { return (["error": "Not permitted."], nil) }
            switch type {
            case "snapshot":
                let state = await store.apply(.state)
                var payload = state.dictionary
                payload["read"] = store.readIds(in: state.tweets)
                return (payload, nil)
            case "feedRead":
                guard let ids = body["ids"] as? [String], !ids.isEmpty else { return (["error": "Invalid message."], nil) }
                return (["read": store.markRead(ids: ids, read: body["read"] as? Bool ?? true)], nil)
            case "feed":
                do {
                    try await host?.captureBatch()
                    webView.reload()
                    return (["ok": true], nil)
                } catch { return (["error": error.localizedDescription], nil) }
            case "unlock":
                finish(.unlock)
                return (["ok": true], nil)
            default:
                return (["error": "Not permitted."], nil)
            }
        }
        // Page scripts on X: unlocked home only.
        guard request.mode == .unlocked else { return (type == "feedDone" ? ["error": "Not permitted."] : ["unlocked": false], nil) }
        switch type {
        case "unlockState":
            let state = await store.apply(.state, local: true)
            unlockValid = unlockValid && state.day == request.day && state.remainingMs > 0
            return (["unlocked": unlockValid, "feed": ["remainingMs": state.remainingMs, "limitMs": state.limitMs]], nil)
        case "feedTick":
            let state = await store.apply(.spend(body["ms"] as? Double ?? 0))
            if state.remainingMs <= 0 { unlockValid = false }
            return (["mode": unlockValid ? "unlocked" as Any : NSNull(), "remainingMs": state.remainingMs, "limitMs": state.limitMs], nil)
        case "feedDone":
            finish(.closed)
            return (["done": true], nil)
        default:
            return (["error": "Not permitted."], nil)
        }
    }

    func close() { finish(.closed) }
    func back() { webView.goBack() }
    func reload() { webView.reload() }

    private func finish(_ outcome: Outcome) {
        guard !finished else { return }
        log.notice("SF finish \(String(describing: outcome), privacy: .public)")
        finished = true
        webView.stopLoading()
        onFinish(outcome)
    }

    private func isUnlockedHome(_ view: PageView?) -> Bool {
        request.mode == .unlocked && unlockValid && view?.kind == "home" && view?.site == "x"
    }

    /// A feed was reached. Right after a sign-in page, reaching home means it worked.
    private func reachedFeed(_ site: Site) {
        if request.mode == .unlocked && !unlockValid { finish(.budgetUsed); return }
        finish(request.mode == .signIn || sawLogin ? .signedIn(site) : .blockedFeed(site))
    }

    private func site(of url: URL) -> Site {
        url.host?.contains("instagram") == true ? .instagram : .x
    }

    private func urlChanged(_ url: URL) async {
        guard !finished, ["http", "https"].contains(url.scheme) else { return }
        let policy = PolicyEngine.shared
        guard await policy.isSocial(url) else { return }
        let view = await policy.view(url)
        // URLs can hold DM ids, searches and sign-in codes: logged privately (redacted outside a debugger).
        log.notice("SF url \(url.absoluteString, privacy: .private) -> \(view?.kind ?? "nil", privacy: .public)")
        if view?.kind == "login" { sawLogin = true }
        if isUnlockedHome(view) { return }
        if view == nil || view?.isDestination == false { reachedFeed(site(of: url)) }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        (await decide(action), preferences)
    }

    /// Private WebKit value used by many browsers: allow, but don't hand the link to
    /// the native X or Instagram app via universal links.
    private static let allowWithoutAppLink = WKNavigationActionPolicy(rawValue: WKNavigationActionPolicy.allow.rawValue + 2) ?? .allow

    private func decide(_ action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return .cancel }
        log.notice("SF decide \(url.absoluteString, privacy: .private) main=\(action.targetFrame?.isMainFrame ?? true, privacy: .public)")
        if scheme == "dreamscroll" {
            // content.js asked for the intent page (a feed) or the dashboard.
            reachedFeed(url.query?.contains("site=instagram") == true ? .instagram : site(of: webView.url ?? request.url))
            return .cancel
        }
        if ["about", "blob", "data"].contains(scheme) { return .allow }
        if scheme == "file" {
            if request.mode == .feed, url.lastPathComponent == "feed.html", url.deletingLastPathComponent().path == Bundled.feedPage.deletingLastPathComponent().path { return .allow }
            finish(.closed)
            return .cancel
        }
        if action.targetFrame?.isMainFrame == false { return .allow }
        guard ["http", "https"].contains(scheme) else { return .cancel }  // twitter://, instagram:// app links
        let policy = PolicyEngine.shared
        if !(await policy.isSocial(url)) {
            // Sign-in can pass through Apple, Google or a captcha provider.
            if url.host == "t.co" || request.mode == .signIn || sawLogin { return .allow }
            // Anything else leaves for Safari; the app is only for X and Instagram.
            await UIApplication.shared.open(url)
            return .cancel
        }
        let view = await policy.view(url)
        if view?.kind == "login" { sawLogin = true }
        if isUnlockedHome(view) { return Self.allowWithoutAppLink }
        // The start page itself (content.js goes on from there, e.g. to your saved posts).
        if request.start != nil, view?.kind == "home", view?.site == "instagram" { return Self.allowWithoutAppLink }
        guard let view, view.isDestination else {
            reachedFeed(site(of: url))
            return .cancel
        }
        return Self.allowWithoutAppLink
    }

    // target=_blank and window.open stay in this view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil, let url = action.request.url { webView.load(URLRequest(url: url)) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        webView.allowsBackForwardNavigationGestures = webView.url?.isFileURL != true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { scheduleProbe() }

    /// Development only, and off unless built with the DREAMSCROLL_PROBE flag
    /// (`SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG DREAMSCROLL_PROBE` in ios/Local.xcconfig):
    /// runs Documents/probe.js (copied with `xcrun devicectl device copy to`) in the page a few
    /// seconds after load and logs its result, to inspect live mobile layouts.
    private func scheduleProbe() {
        #if DREAMSCROLL_PROBE
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard let self, !self.finished,
                  let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
                  let script = try? String(contentsOf: dir.appendingPathComponent("probe.js"), encoding: .utf8) else { return }
            let result = (try? await self.webView.callAsyncJavaScript(script, contentWorld: Shim.world)).map { "\($0)" } ?? "probe failed"
            for (i, chunk) in result.chunked(700).enumerated() { log.notice("SF probe[\(i, privacy: .public)] \(chunk, privacy: .public)") }
        }
        #endif
    }
}

private struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct BrowserView: View {
    let controller: BrowserController

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Button { controller.close() } label: { Image(systemName: "xmark").frame(width: 40, height: 40) }
                    .accessibilityLabel("Close")
                Button { controller.back() } label: { Image(systemName: "chevron.left").frame(width: 40, height: 40) }
                    .disabled(!controller.canGoBack)
                    .accessibilityLabel("Back")
                Spacer(minLength: 0)
                Text(controller.request.mode == .signIn ? "Sign in to \(controller.request.site.name)" : controller.request.mode == .feed ? "For You" : controller.request.site.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Group {
                    if controller.isLoading { ProgressView() } else {
                        Button { controller.reload() } label: { Image(systemName: "arrow.clockwise") }
                            .accessibilityLabel("Reload")
                    }
                }
                .frame(width: 40, height: 40)
                Color.clear.frame(width: 40, height: 40)
            }
            .font(.body.weight(.medium))
            .tint(Theme.ink)
            .padding(.horizontal, 8)
            .background(Theme.background)
            Divider()
            WebViewHost(webView: controller.webView)
                .ignoresSafeArea(edges: .bottom)
        }
        .background(Theme.background)
    }
}

extension String {
    func chunked(_ size: Int) -> [String] {
        stride(from: 0, to: count, by: size).map { start in
            let lower = index(startIndex, offsetBy: start)
            return String(self[lower..<(index(lower, offsetBy: size, limitedBy: endIndex) ?? endIndex)])
        }
    }
}

/// Breaks the retain cycle between WKUserContentController and the controller.
private final class MessageRelay: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: BrowserController?
    init(_ target: BrowserController) { self.target = target }
    @MainActor
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let target else { return (nil, "closed") }
        return await target.userContentController(controller, didReceive: message)
    }
}
