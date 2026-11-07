# Working on Dreamscroll

Instructions for people and coding agents changing this repository. To **install** it, follow [INSTALL.md](INSTALL.md) instead.

## Layout

| Path | What |
|---|---|
| `extension/` | The Chrome extension (Manifest V3). Loaded unpacked as-is; no build step. |
| `extension/policy.js` | The URL rules shared by everything. `rules.json` is generated from it. |
| `extension/content.js`, `content.css` | Filtering on x.com and instagram.com pages (also run by the iPhone app). |
| `extension/background.js` | The worker: navigation, For You capture, batch storage, sync. |
| `extension/timeline.js`, `capture-main.js` | Parsing and capturing X's timeline data. |
| `extension/feed.js` | Batch and budget rules (mirrored in `ios/Dreamscroll/FeedStore.swift` and `sync/convex/dreamscroll/rules.ts`). |
| `src/ui/` | React + [Base UI](https://base-ui.com) sources for the main page and the feed page. |
| `extension/popup.js`, `feed-page.js` | **Generated** from `src/ui/` by `bun run build:ui`. Don't edit by hand. |
| `ios/` | The iPhone app (SwiftUI, XcodeGen). `Local.xcconfig` (git-ignored) holds the team and bundle prefix. |
| `sync/` | Optional sync server: a Convex component and a minimal app that mounts it. |
| `docs/` | `sync-api.md` (the sync contract), `how-it-works.md`, and README media. |
| `assets/` | `icon.svg` (app and extension icon) and `mark.svg` (the one-color logo). `bun run icons` renders the PNGs. |
| `scripts/` | Rule generation, UI bundling, versioning and media capture. |
| `tests/` | Node tests (`node:test` + jsdom) for the extension. |

## Commands

Needs [bun](https://bun.sh) (package manager and scripts), Node 22.22+ or 24.15+ (the test runner: `bun run test` runs `node --test`, not `bun test`) and [uv](https://docs.astral.sh/uv/) for the regex check.

```sh
bun install
bun run test         # extension tests; the regex check needs `uv`
bun run check        # syntax, plus generated rules and UI bundles are current
bun run build:rules  # after editing extension/policy.js
bun run build:ui     # after editing src/ui/
bun run media        # README screenshots from the extension (Chrome)
bun run media:ios    # the iPhone app in a Simulator with demo data (Xcode + xcodegen)
bun run icons        # after editing assets/icon.svg or mark.svg (Chrome)

cd sync && bun install && bun run test && bun run typecheck   # sync server

cd ios && xcodegen generate && xcodebuild -project Dreamscroll.xcodeproj -scheme Dreamscroll \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build   # iPhone app compiles
```

CI runs the tests, `check` (which fails if generated files are stale), the sync tests and the iOS build; not the media or icon scripts.

## Conventions

- **One set of rules.** A behavior change to what's allowed goes in `policy.js` and `content.js`, which both clients run. Changes to batch timing or sync go in `feed.js`, `FeedStore.swift` and `sync/convex/dreamscroll/rules.ts` together, and in `docs/sync-api.md` if the contract changes.
- **Commit generated files.** After changing `policy.js` or `src/ui/`, rebuild and commit `rules.json`, `popup.js` and `feed-page.js`; `bun run check` fails otherwise.
- **Sanitize everything from X.** Tweets pass through `sanitizeTweet` before they're stored or shown, and pages render them with React (no HTML strings). Only `https` links and X's own image hosts are allowed.
- **Never touch real accounts in tests or media.** Use the demo data in `scripts/media/demo.mjs`. Don't post, like, follow or send messages while testing on a real account.
- **Live sites change.** Tests use fixtures, so after a change to filtering, also run the manual checks at the end of [docs/how-it-works.md](docs/how-it-works.md).

## Releases

1. Add a section for the new version at the top of [CHANGELOG.md](CHANGELOG.md) (Added / Changed / Fixed / Removed), written for people who use it.
2. `bun run set-version -- X.Y.Z` updates `extension/manifest.json`, both `package.json` files and the iOS version and build number.
3. Commit and push, wait for CI to pass, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The release workflow attaches `dreamscroll-extension-vX.Y.Z.zip` (the `extension/` folder) to a GitHub release with that changelog section as its notes.

Versions follow [semver](https://semver.org): a change people have to act on (re-entering sync settings, a new permission) is at least a minor version.
