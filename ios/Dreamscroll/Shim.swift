import WebKit

/// Runs the extension's content filter inside an isolated script world (like an
/// extension content script: shared DOM, separate JS globals). The shim stands in
/// for chrome.runtime; "dreamscroll://internal/…" URLs are caught natively.
enum Shim {
    static let world = WKContentWorld.world(name: "Dreamscroll")

    /// Which grant a web view holds: none, the hidden snapshot capture, an unlock, or
    /// Instagram home as the start page for an action (P.startViews, e.g. "saved").
    enum Grant { case none, capture(nonce: String), unlocked, start(String) }

    static func userScripts(_ grant: Grant = .none) -> [WKUserScript] {
        let css = jsString(Bundled.css)
        var captureNonce = "null", unlockable = "false", startAction = "null"
        if case .capture(let nonce) = grant { captureNonce = jsString(nonce) }
        if case .unlocked = grant { unlockable = "true" }
        if case .start(let action) = grant { startAction = jsString(action) }
        // Like an extension's match patterns: only X and Instagram pages, never the
        // web view's initial about:blank (which content.js would treat as a feed).
        let source = """
        if (/^https:\\/\\/(?:[a-z0-9-]+\\.)*(?:x|twitter|instagram)\\.com\\//.test(location.href)) {
        (() => {
          // Hide before the site paints; content.js reveals only the approved view.
          const style = document.createElement('style');
          style.textContent = \(css);
          (document.head || document.documentElement).appendChild(style);
        })();
        \(Bundled.policy)
        \(Bundled.timeline)
        (() => {
          const P = globalThis.SocialPolicy;
          const login = new RegExp(\(jsString(LoginRoutes.pattern)));
          const CAPTURE = \(captureNonce), UNLOCKABLE = \(unlockable);
          const START = \(startAction) && Object.hasOwn(P.startViews.instagram, \(startAction)) ? P.startViews.instagram[\(startAction)] : null;
          // App-only view: sign-in pages are allowed as-is (see content.js 'login').
          const view = P.view;
          P.view = url => login.test(String(url)) ? {kind:'login', site: /instagram\\.com/.test(String(url)) ? 'instagram' : 'x'} : view(url);
          const native = message => window.webkit.messageHandlers.dreamscroll.postMessage(message);
          globalThis.chrome = {runtime: {
            id: 'dreamscroll-ios',
            getURL: path => 'dreamscroll://internal/' + path,
            onMessage: {addListener() {}},
            async sendMessage(message) {
              if (message?.type === 'check') {
                const url = String(message.url || location.href);
                // The capture web view (the only one with CAPTURE set) may show X home.
                if (CAPTURE && P.view(url)?.kind === 'home' && P.view(url)?.site === 'x') return {allowed: true, view: {kind: 'capture', site: 'x'}};
                // A web view opened for an Instagram start page (Saved) may show Instagram home.
                if (START && P.instagramHome(url)) return {allowed: true, view: {...START}};
                const v = P.view(url);
                if (UNLOCKABLE && v?.kind === 'home' && v.site === 'x') {
                  const state = await native({type: 'unlockState'});
                  if (state?.unlocked) return {allowed: true, view: {kind: 'feed', site: 'x', mode: 'unlocked'}, feed: state.feed};
                }
                return {allowed: !!v && v.kind !== 'home', view: v, post: P.post(url)};
              }
              if (['captured', 'feedTick', 'feedDone'].includes(message?.type)) return await native(message);
              return {error: 'Not permitted.'};
            }
          }};
        })();
        \(Bundled.content)
        }
        """
        var scripts = [WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world)]
        // The capture view also passes X's For You data on from X's own page world.
        if case .capture = grant { scripts.append(WKUserScript(source: Bundled.captureMain, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)) }
        return scripts
    }

    private static func jsString(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed])
        let array = String(data: data, encoding: .utf8)!
        return String(array.dropFirst().dropLast())
    }
}
