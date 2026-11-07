import Foundation

/// Safari content blocker: blocks X, Twitter and Instagram pages in Safari only.
/// Dreamscroll's own web views are unaffected (content blockers apply to Safari).
/// The app's Settings toggle is shared through the App Group.
final class ContentBlockerRequestHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let enabled = SharedSettings.blockInSafari
        let rules: [[String: Any]] = enabled
            // WebKit rule regexes have no alternation: one rule per domain.
            ? ["x", "twitter", "instagram"].map { name in
                ["trigger": ["url-filter": "^https?://([a-z0-9-]+\\.)*\(name)\\.com[/:]", "resource-type": ["document"]],
                 "action": ["type": "block"]]
            }
            // A rule list can't be empty; this one never matches anything real.
            : [["trigger": ["url-filter": "^https://dreamscroll\\.invalid/"], "action": ["type": "block"]]]
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("blockerList.json")
        do {
            try JSONSerialization.data(withJSONObject: rules).write(to: url, options: .atomic)
            let item = NSExtensionItem()
            item.attachments = [NSItemProvider(contentsOf: url)!]
            context.completeRequest(returningItems: [item])
        } catch {
            context.cancelRequest(withError: error)
        }
    }
}
