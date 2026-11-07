import Foundation
import WebKit

/// Keeps X and Instagram sign-ins across launches, updates and force-quits.
/// WKWebView writes cookies to disk lazily, so a session set shortly before the
/// app is killed or reinstalled can be lost. The vault mirrors those cookies into
/// a protected file (not backed up) and restores any that are missing at launch.
@MainActor
final class CookieVault: NSObject, WKHTTPCookieStoreObserver {
    static let shared = CookieVault()
    private let domains = ["x.com", "twitter.com", "instagram.com"]
    private var store: WKHTTPCookieStore { WKWebsiteDataStore.default().httpCookieStore }
    private var pendingSave: Task<Void, Never>?

    private var file: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("sessions.plist")
    }

    private func relevant(_ cookie: HTTPCookie) -> Bool {
        let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
        return domains.contains { domain == $0 || domain.hasSuffix("." + $0) }
    }

    func start() async {
        await restore()
        store.add(self)
    }

    nonisolated func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        Task { @MainActor in self.scheduleSave() }
    }

    private func scheduleSave() {
        pendingSave?.cancel()
        pendingSave = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            await self?.save()
        }
    }

    func save() async {
        let cookies = await store.allCookies().filter(relevant)
        let records: [[String: Any]] = cookies.compactMap { cookie in
            guard let properties = cookie.properties else { return nil }
            var record: [String: Any] = [:]
            for (key, value) in properties {
                switch value {
                case let url as URL: record[key.rawValue] = url.absoluteString
                case is String, is Date, is NSNumber: record[key.rawValue] = value
                default: break
                }
            }
            return record
        }
        guard let data = try? PropertyListSerialization.data(fromPropertyList: records, format: .binary, options: 0) else { return }
        var url = file
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    private func restore() async {
        guard let data = try? Data(contentsOf: file),
              let records = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [[String: Any]] else { return }
        let existing = await store.allCookies()
        let now = Date()
        for record in records {
            var properties: [HTTPCookiePropertyKey: Any] = [:]
            for (key, value) in record { properties[HTTPCookiePropertyKey(key)] = value }
            guard let cookie = HTTPCookie(properties: properties), (cookie.expiresDate ?? .distantFuture) > now,
                  !existing.contains(where: { $0.name == cookie.name && $0.domain == cookie.domain && $0.path == cookie.path }) else { continue }
            await store.setCookie(cookie)
        }
    }
}
