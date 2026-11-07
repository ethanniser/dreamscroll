import Foundation
import WebKit

enum Site: String, CaseIterable, Identifiable, Codable {
    case x, instagram
    var id: String { rawValue }
    var name: String { self == .x ? "X" : "Instagram" }
    var cookieDomain: String { self == .x ? "x.com" : "instagram.com" }
    /// The cookie that only exists while signed in.
    var sessionCookie: String { self == .x ? "auth_token" : "sessionid" }
    var loginURL: URL {
        URL(string: self == .x ? "https://x.com/i/flow/login" : "https://www.instagram.com/accounts/login/")!
    }
}

/// What policy.js says a URL is. `kind` is post, profile, search, notifications,
/// messages, compose, home, or (app only) login.
struct PageView: Decodable, Equatable {
    let kind: String
    let site: String
    var subpage: Bool?
    var isDestination: Bool { kind != "home" }
}

/// Sign-in, challenge and two-factor routes. These must work for an app that
/// holds its own session; they show no feed. The shim reuses this pattern in-page.
/// X moved sign-in to /i/jf/onboarding/web?mode=login in 2026.
enum LoginRoutes {
    static let pattern = #"^https://(?:(?:www|mobile)\.)?(?:x|twitter)\.com/(?:i/flow/[A-Za-z0-9_-]+|i/jf/[A-Za-z0-9_/-]+|login|logout|account/access|account/login_verification|i/jot)(?:[/?#]|$)|^https://(?:www\.|m\.)?instagram\.com/(?:accounts/(?:login|onetap|emailsignup|password|two_factor|suspended|fb_login)|challenge|auth_platform)(?:[/?#]|$)"#
    private static let regex = try! NSRegularExpression(pattern: pattern)
    static func matches(_ url: URL) -> Bool {
        let s = url.absoluteString
        return regex.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
}

enum Bundled {
    static func text(_ name: String, _ ext: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: ext),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            fatalError("Missing bundled \(name).\(ext)")
        }
        return text
    }
    static let policy = text("policy", "js")
    static let content = text("content", "js")
    static let css = text("content", "css")
    static let timeline = text("timeline", "js")
    static let captureMain = text("capture-main", "js")
    /// The extension's feed page, bundled as files (feed.html and its scripts and styles).
    static var feedPage: URL { Bundle.main.url(forResource: "feed", withExtension: "html")! }
}

/// Evaluates the extension's policy.js in a hidden web view, so native navigation
/// decisions use exactly the same rules as the page filter and the extension.
@MainActor
final class PolicyEngine: NSObject, WKNavigationDelegate {
    static let shared = PolicyEngine()
    private let webView: WKWebView
    private var loaded = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.loadHTMLString("<!doctype html><script>\(Bundled.policy)</script>", baseURL: URL(string: "https://policy.invalid/"))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }

    private func ready() async {
        if loaded { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func call<T: Decodable>(_ body: String, _ args: [String: Any]) async -> T? {
        await ready()
        guard let json = try? await webView.callAsyncJavaScript("return JSON.stringify(\(body))", arguments: args, contentWorld: .page) as? String,
              let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    func view(_ url: URL) async -> PageView? {
        if LoginRoutes.matches(url) {
            return PageView(kind: "login", site: url.host?.contains("instagram") == true ? "instagram" : "x")
        }
        return await call("SocialPolicy.view(u) ?? null", ["u": url.absoluteString])
    }

    private struct Destination: Decodable { let site: String; let url: String }
    /// A pasted or shared link, canonicalized; nil for feeds and anything unsupported.
    func destination(_ raw: String) async -> URL? {
        let found: Destination? = await call("SocialPolicy.destination(u) ?? null", ["u": raw])
        return found.flatMap { URL(string: $0.url) }
    }

    func isSocial(_ url: URL) async -> Bool {
        (await call("SocialPolicy.social(u)", ["u": url.absoluteString]) as Bool?) ?? false
    }
}
