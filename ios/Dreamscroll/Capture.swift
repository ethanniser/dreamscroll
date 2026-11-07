import UIKit
import WebKit

/// Takes the X For You snapshot: loads x.com/home in an invisible web view, where
/// capture-main.js passes on X's own HomeTimeline data and content.js parses the
/// first tweets of the batch (timeline.js) and reports them. Same flow as the extension.
@MainActor
final class CaptureController: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    enum Failure: LocalizedError {
        case signedOut, timedOut, empty
        var errorDescription: String? {
            switch self {
            case .signedOut: "Sign in to X first, then get a batch."
            case .timedOut: "X didn’t load your feed in time. Try again."
            case .empty: "Couldn’t read your For You feed. Try again in a moment."
            }
        }
    }

    private let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    private var webView: WKWebView?
    private var continuation: CheckedContinuation<Data, Error>?

    /// The batch's tweets as JSON (sanitized again before they are ever rendered).
    func run() async throws -> Data {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        Shim.userScripts(.capture(nonce: nonce)).forEach(config.userContentController.addUserScript)
        config.userContentController.addScriptMessageHandler(self, contentWorld: Shim.world, name: "dreamscroll")
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 800), configuration: config)
        web.customUserAgent = BrowserController.userAgent
        web.navigationDelegate = self
        // Attached to the window but invisible: a detached web view may be throttled.
        web.alpha = 0
        web.isUserInteractionEnabled = false
        Self.keyWindow?.insertSubview(web, at: 0)
        webView = web
        defer {
            web.stopLoading()
            web.configuration.userContentController.removeAllScriptMessageHandlers()
            web.removeFromSuperview()
            webView = nil
        }
        let timeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(30))
            self?.finish(.failure(Failure.timedOut))
        }
        defer { timeout.cancel() }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            // The nonce is in the fragment, which is never sent to X.
            web.load(URLRequest(url: URL(string: "https://x.com/home#sf_capture=\(nonce)")!))
        }
    }

    private func finish(_ result: Result<Data, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }

    private static var keyWindow: UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
    }

    // The page reports {type:'captured', nonce, tweets}; anything else is refused.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], body["type"] as? String == "captured", body["nonce"] as? String == nonce,
              let tweets = body["tweets"] as? [Any] else { return (["error": "Not permitted."], nil) }
        guard !tweets.isEmpty, let data = try? JSONSerialization.data(withJSONObject: Array(tweets.prefix(FeedStore.Rules.batchSize))) else {
            finish(.failure(Failure.empty))
            return (["ok": true], nil)
        }
        finish(.success(data))
        return (["ok": true], nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if action.targetFrame?.isMainFrame == false || ["about", "blob", "data"].contains(url.scheme ?? "") { return .allow }
        // Signed out: X sends the capture to its sign-in flow.
        if LoginRoutes.matches(url) { finish(.failure(Failure.signedOut)); return .cancel }
        if url.scheme == "dreamscroll" { finish(.failure(Failure.empty)); return .cancel }
        return url.host == "x.com" && url.path == "/home" ? .allow : .cancel
    }
}
