# Working on Dreamscroll

Instructions for people and coding agents changing this repository. To **install** it, follow [INSTALL.md](INSTALL.md) instead.

**Agents:** also read `AGENTS.local.md` if it exists (git-ignored; the maintainer's devices, servers and current open items), and [docs/how-it-works.md](docs/how-it-works.md) before changing filtering. Repo skills live in `.agents/skills/` (also at `.claude/skills/`): `iphone-device` (build, install and drive the app on a real iPhone) and `live-check` (verify a change on the real sites).

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

## Gotchas

Learned the hard way; check here before debugging something that "should work".

- **Chrome compiles each rule's regex with RE2 under a 2 KB memory budget.** Bounded quantifiers (`{1,15}`) blow it and the rule is silently skipped in some browsers: use unbounded repeats. `scripts/check-regex.py` (part of `bun run test`) checks every generated pattern; trust its exit code, not a skim of its output.
- **Network rules never see URL fragments, and can't know intent.** Anything that must load a normally gated page (X home for the For You capture, Instagram home for the Notifications panel and Saved) gets a tab-scoped session rule, a *grant* in `background.js`, and the worker tells that tab's content script which view it is. Don't put markers in URLs.
- **Static rule ids are blocks:** posts 100+, profiles 200+, personal routes 400+ (these shift when entries are added; that's fine), searches 500+, gate redirects a fixed block at 600+, reserved paths 1000+. Duplicate ids silently drop rules.
- **X keeps menus, hover cards, toasts and confirm sheets in `#layers`,** which is hidden. On non-compose views `content.js` reveals only the allowlisted pop-ups (`VIEW_POPOVER`); a new X menu that "doesn't open" probably needs adding there.
- **Matching the post on a post page** uses the post's own `<time>` link, skips quote cards (`[role="link"]:not(a)`), and accepts `/status/<id>/history` (edited posts). Posts X can't show fall back to X's own notice: a non-tweet article (suspended, protected) or `[data-testid="error-detail"]` (deleted).
- **Never `display:none` X's page while it starts** (see how-it-works.md): pages load at `opacity: 0`.
- **Tests:** the worker runs in a `vm` context, so spread its arrays (`[...arr]`) before `deepEqual`. Content tests take `{reply}` to fake the worker's `check` answer (`startReply(action)` builds a start view). A new test should fail without the fix: check that once.
- **Shell:** zsh expands unquoted globs such as `--include=*.js` (quote them); `rg` with no path inside `$(...)` waits on stdin (pass `.`).

## Live sites and real accounts

- Only the maintainer's own browser and phone are signed in. Inspect live pages with narrow structural queries (test ids, roles, element counts), never by dumping text from inboxes or notifications.
- Never post, like, repost, follow, bookmark or send messages, even to test. Opening menus and composers is fine; submitting isn't.
- Agents can't reload an unpacked extension (`chrome://extensions` is off limits); the person reloads it. Say which commit needs loading.
- Changes to system or security settings on a phone or computer (Safari extensions, permissions) are the owner's to make; at most navigate there and stop.

## Releases

1. Add a section for the new version at the top of [CHANGELOG.md](CHANGELOG.md) (Added / Changed / Fixed / Removed), written for people who use it.
2. `bun run set-version -- X.Y.Z` updates `extension/manifest.json`, both `package.json` files and the iOS version and build number.
3. Commit and push, wait for CI to pass, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The release workflow attaches `dreamscroll-extension-vX.Y.Z.zip` (the `extension/` folder) to a GitHub release with that changelog section as its notes.

Versions follow [semver](https://semver.org): a change people have to act on (re-entering sync settings, a new permission) is at least a minor version.
