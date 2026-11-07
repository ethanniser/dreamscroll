import UIKit
import UniformTypeIdentifiers

/// "Dreamscroll" in the share sheet: hands the shared link to the app via
/// dreamscroll://open?url=… so it opens in the focused view.
final class ShareViewController: UIViewController {
    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await handOff() }
    }

    private func handOff() async {
        guard let link = await sharedLink(),
              var components = URLComponents(string: "dreamscroll://open") else {
            return fail("Share a link to an X or Instagram post, account, or conversation.")
        }
        components.queryItems = [URLQueryItem(name: "url", value: link.absoluteString)]
        guard let url = components.url, openContainingApp(url) else {
            return fail("Couldn’t open Dreamscroll. Copy the link and paste it in the app.")
        }
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func sharedLink() async -> URL? {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, url.scheme?.hasPrefix("http") == true { return url }
        }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String,
               let url = Self.firstLink(in: text) { return url }
        }
        return nil
    }

    private static func firstLink(in text: String) -> URL? {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        return detector?.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))?.url
    }

    /// Extensions can't call UIApplication.shared. Walk the responder chain to the
    /// host's UIApplication and call open(_:options:completionHandler:) on it.
    private func openContainingApp(_ url: URL) -> Bool {
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current.isKind(of: NSClassFromString("UIApplication")!), current.responds(to: selector) {
                typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
                let open = unsafeBitCast(current.method(for: selector), to: Open.self)
                open(current, selector, url as NSURL, NSDictionary(), nil)
                return true
            }
            responder = current.next
        }
        return false
    }

    private func fail(_ message: String) {
        view.backgroundColor = .systemBackground
        label.text = message
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .body)
        label.translatesAutoresizingMaskIntoConstraints = false
        let done = UIButton(type: .system, primaryAction: UIAction(title: "Done") { [weak self] _ in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        done.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        view.addSubview(done)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            done.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 20),
            done.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])
    }
}
