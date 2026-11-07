import Foundation
import Security

/// The X For You snapshot (10 tweets, 2 hours) and the daily unlocked-scrolling
/// budget (15 minutes). A Swift port of the extension's background.js feedOp and
/// feed.js rules: local-first, synced with a sync server when configured (the server wins; docs/sync-api.md).
@MainActor
final class FeedStore {
    static let shared = FeedStore()

    enum Rules {
        static let batchSize = 10
        static let cooldownMs = 2.0 * 60 * 60 * 1000
        static let dailyBudgetMs = 15.0 * 60 * 1000
        static let maxSpendPerReportMs = 30.0 * 1000
    }

    struct Snapshot: Codable { var startedAt: Double; var endsAt: Double; var tweets: Data }
    struct Budget: Codable { var day: String; var usedMs: Double }
    private struct Stored: Codable {
        var snapshot: Snapshot?
        var budget: Budget
        var highWater: Double = 0
        var pendingSnapshot = false
        var snapshotRefused = false
        var pendingSpendMs: Double = 0
    }

    struct SyncStatus { var configured = false; var synced = false; var error: String? }
    struct Summary {
        var active: Bool
        var startedAt: Double?
        var endsAt: Double?
        var count: Int
        var remainingMs: Double
        var limitMs: Double
        var day: String
        var tweets: Data
        var sync: SyncStatus
        /// JSON-friendly form for the feed page and the page scripts.
        var dictionary: [String: Any] {
            ["active": active, "startedAt": startedAt ?? NSNull(), "endsAt": endsAt ?? NSNull(), "count": count, "size": Rules.batchSize,
             "remainingMs": remainingMs, "limitMs": limitMs,
             "tweets": (try? JSONSerialization.jsonObject(with: tweets)) ?? []]
        }
    }

    private var lastRemote = 0.0, lastSpendFlush = 0.0
    private var file: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("feed.json")
    }

    static func localDay(_ ms: Double) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
    private static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
    private static func tweetCount(_ data: Data) -> Int { ((try? JSONSerialization.jsonObject(with: data)) as? [Any])?.count ?? 0 }

    private func load() -> Stored {
        if let data = try? Data(contentsOf: file), let stored = try? JSONDecoder().decode(Stored.self, from: data) { return stored }
        return Stored(budget: Budget(day: Self.localDay(Self.nowMs()), usedMs: 0))
    }
    private func save(_ stored: Stored) {
        guard let data = try? JSONEncoder().encode(stored) else { return }
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    enum Op { case state, snapshot(Data), spend(Double) }

    /// One operation at a time, so network awaits never interleave two read-modify-writes.
    private var queue: Task<Summary, Never>?

    /// Applies an operation locally, then (when configured) syncs with the sync server, whose state wins.
    @discardableResult
    func apply(_ op: Op, fresh: Bool = false, local: Bool = false) async -> Summary {
        let previous = queue
        let task = Task { @MainActor in
            _ = await previous?.value
            return await self.run(op, fresh: fresh, local: local)
        }
        queue = task
        return await task.value
    }

    private func run(_ op: Op, fresh: Bool, local: Bool) async -> Summary {
        var s = load()
        // Offline, the clock can't be wound back to reopen a batch or restart the day.
        let now = max(Self.nowMs(), s.highWater), day = Self.localDay(now)
        s.highWater = now
        let sync = SyncSettings.current
        // Without sync the device's day rolls the budget over; with sync, the server decides the day.
        if sync == nil && s.budget.day != day { s.budget = Budget(day: day, usedMs: 0); s.pendingSpendMs = 0 }
        let active = { (snap: Snapshot?) in snap.map { now < $0.endsAt } ?? false }

        switch op {
        case .state: break
        case .snapshot(let tweets):
            // The first snapshot of a window wins.
            if !active(s.snapshot) {
                s.snapshot = Snapshot(startedAt: now, endsAt: now + Rules.cooldownMs, tweets: tweets)
                s.pendingSnapshot = true
                s.snapshotRefused = false
            }
        case .spend(let ms):
            let amount = ms.isFinite ? min(max(ms, 0), Rules.maxSpendPerReportMs) : 0
            let after = min(Rules.dailyBudgetMs, max(0, s.budget.usedMs) + amount)
            s.pendingSpendMs += after - s.budget.usedMs
            s.budget.usedMs = after
        }

        var status = SyncStatus(configured: sync != nil)
        let due = fresh || s.pendingSnapshot || (s.pendingSpendMs > 0 && now - lastSpendFlush >= 15000) || now - lastRemote >= 10000
        if let sync, due, !local {
            do {
                var remoteState: [String: Any]?
                if s.pendingSnapshot, let snap = s.snapshot, active(snap) {
                    do { remoteState = try await remote(sync, "snapshot", ["tweets": (try? JSONSerialization.jsonObject(with: snap.tweets)) ?? []]) }
                    catch RemoteError.refused(let message) { s.pendingSnapshot = false; s.snapshotRefused = true; status.error = message }
                }
                var spends = 0
                while s.pendingSpendMs > 0 && spends < 6 {
                    let ms = min(s.pendingSpendMs, Rules.maxSpendPerReportMs)
                    remoteState = try await remote(sync, "spend", ["ms": ms])
                    s.pendingSpendMs -= ms
                    lastSpendFlush = now
                    spends += 1
                }
                if remoteState == nil { remoteState = try await remote(sync, "state", nil) }
                s.pendingSnapshot = false
                if let remoteState {
                    let batch = remoteState["batch"] as? [String: Any] ?? [:]
                    let budget = remoteState["budget"] as? [String: Any] ?? [:]
                    let remoteActive = batch["active"] as? Bool ?? false
                    // Keep a local batch the server refused (until it ends); otherwise the server's wins.
                    let keepLocal = !remoteActive && s.snapshotRefused && active(s.snapshot)
                    if !keepLocal {
                        if remoteActive, let start = batch["startedAt"] as? Double, let end = batch["endsAt"] as? Double {
                            let tweets = (try? JSONSerialization.data(withJSONObject: batch["tweets"] as? [Any] ?? [])) ?? Data("[]".utf8)
                            s.snapshot = Snapshot(startedAt: start, endsAt: end, tweets: tweets)
                        } else { s.snapshot = nil }
                    }
                    s.budget = Budget(day: budget["day"] as? String ?? day, usedMs: budget["usedMs"] as? Double ?? s.budget.usedMs)
                }
                lastRemote = now
                status.synced = status.error == nil
            } catch {
                status.error = (error as? RemoteError)?.message ?? "The sync server is unreachable."
            }
        } else if sync == nil {
            s.pendingSnapshot = false
            s.pendingSpendMs = 0
        }
        save(s)
        let isActive = active(s.snapshot)
        let tweets = isActive ? (s.snapshot?.tweets ?? Data("[]".utf8)) : Data("[]".utf8)
        return Summary(active: isActive, startedAt: isActive ? s.snapshot?.startedAt : nil, endsAt: isActive ? s.snapshot?.endsAt : nil, count: Self.tweetCount(tweets),
                       remainingMs: max(0, Rules.dailyBudgetMs - s.budget.usedMs), limitMs: Rules.dailyBudgetMs,
                       day: s.budget.day, tweets: tweets, sync: status)
    }

    // MARK: Read tweets (swiped away on the feed page)
    // Only ids in the current batch are kept: read state survives sync adopting the batch,
    // a stale page can't mark another batch, and a new batch starts with nothing read.

    private struct ReadState: Codable { var ids: [String] }
    private static let readKey = "feedRead"

    private static func tweetIds(_ tweets: Data?) -> Set<String> {
        guard let tweets, let list = (try? JSONSerialization.jsonObject(with: tweets)) as? [[String: Any]] else { return [] }
        return Set(list.compactMap { $0["id"] as? String })
    }
    private func storedReadIds() -> [String] {
        guard let data = UserDefaults.standard.data(forKey: Self.readKey), let state = try? JSONDecoder().decode(ReadState.self, from: data) else { return [] }
        return state.ids
    }

    func readIds(in tweets: Data) -> [String] {
        let inBatch = Self.tweetIds(tweets)
        return storedReadIds().filter(inBatch.contains)
    }

    /// Marks tweets of the current batch read (or unread).
    func markRead(ids: [String], read: Bool) -> [String] {
        let inBatch = Self.tweetIds(load().snapshot?.tweets)
        var current = storedReadIds().filter(inBatch.contains)
        for id in ids where inBatch.contains(id) {
            if read { if !current.contains(id) { current.append(id) } } else { current.removeAll { $0 == id } }
        }
        if let data = try? JSONEncoder().encode(ReadState(ids: current)) { UserDefaults.standard.set(data, forKey: Self.readKey) }
        return current
    }

    // MARK: Sync server (docs/sync-api.md)

    enum RemoteError: Error {
        case refused(String), failed(String)
        var message: String { switch self { case .refused(let m), .failed(let m): m } }
    }

    private func remote(_ sync: SyncSettings, _ op: String, _ body: [String: Any]?) async throws -> [String: Any] {
        var request = URLRequest(url: sync.endpoint.appendingPathComponent("dreamscroll/\(op)"), timeoutInterval: 5)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue("Bearer \(sync.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response): (Data, URLResponse)
        do { (data, response) = try await URLSession.shared.data(for: request) }
        catch { throw RemoteError.failed("The sync server is unreachable.") }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 { throw RemoteError.failed("The sync server rejected the token (401).") }
        if (400..<500).contains(code) { throw RemoteError.refused("The sync server refused the request (\(code)).") }
        guard (200..<300).contains(code), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RemoteError.failed("Sync failed (\(code)).")
        }
        return json
    }

    /// Checks a URL and token against the sync server before they are saved.
    func verify(_ settings: SyncSettings) async throws {
        _ = try await remote(settings, "state", nil)
        lastRemote = 0
    }
}

/// Sync settings: the server's address (defaults) and the token (Keychain).
struct SyncSettings {
    let endpoint: URL
    let token: String

    private static let endpointKey = "syncEndpoint"
    private static let service = (Bundle.main.bundleIdentifier ?? "dreamscroll") + ".sync"

    static var current: SyncSettings? {
        guard let raw = UserDefaults.standard.string(forKey: endpointKey), let url = URL(string: raw), let token = Keychain.read(service) else { return nil }
        return SyncSettings(endpoint: url, token: token)
    }

    /// Validated like the extension: an https origin (no path) and a 32+ character token.
    static func make(endpoint raw: String, token rawToken: String) throws -> SyncSettings {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
        guard let url = URL(string: trimmed), url.scheme == "https", let host = url.host, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else {
            throw FeedStore.RemoteError.failed("Enter your sync server’s https:// address (no path).")
        }
        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.count >= 32 else { throw FeedStore.RemoteError.failed("Enter the sync token (32+ characters).") }
        // Rebuilt from parts (keeps the port; URLComponents brackets IPv6 hosts).
        var origin = URLComponents()
        origin.scheme = "https"; origin.host = host; origin.port = url.port
        guard let endpoint = origin.url else { throw FeedStore.RemoteError.failed("Enter your sync server’s https:// address (no path).") }
        return SyncSettings(endpoint: endpoint, token: token)
    }

    /// Parses dreamscroll://sync?endpoint=…&token=… (the extension's QR code), validated like `make`.
    static func from(link: String) -> SyncSettings? {
        guard let parts = URLComponents(string: link), parts.scheme == "dreamscroll", parts.host == "sync",
              let endpoint = parts.queryItems?.first(where: { $0.name == "endpoint" })?.value,
              let token = parts.queryItems?.first(where: { $0.name == "token" })?.value else { return nil }
        return try? make(endpoint: endpoint, token: token)
    }

    func save() {
        UserDefaults.standard.set(endpoint.absoluteString, forKey: Self.endpointKey)
        Keychain.write(Self.service, token)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: endpointKey)
        Keychain.delete(service)
    }
}

enum Keychain {
    private static func query(_ service: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "token"]
    }
    static func read(_ service: String) -> String? {
        var q = query(service)
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func write(_ service: String, _ value: String) {
        delete(service)
        var q = query(service)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
    static func delete(_ service: String) { SecItemDelete(query(service) as CFDictionary) }
}
