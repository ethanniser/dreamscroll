import Foundation

/// Settings shared between the app and its extensions via the App Group.
enum SharedSettings {
    /// From Info.plist, so forks only change BUNDLE_ID_PREFIX (ios/Local.xcconfig).
    static let appGroup = Bundle.main.object(forInfoDictionaryKey: "DreamscrollAppGroup") as? String ?? ""
    static let blockerIdentifier = Bundle.main.object(forInfoDictionaryKey: "DreamscrollBlockerIdentifier") as? String ?? ""
    private static var defaults: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }

    /// On by default: X, Twitter and Instagram are blocked in Safari.
    static var blockInSafari: Bool {
        get { defaults.object(forKey: "blockInSafari") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "blockInSafari") }
    }
}
