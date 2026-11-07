# Installing Dreamscroll

Three parts, each optional on its own:

1. [Chrome extension](#chrome-extension): 2 minutes, no build step.
2. [iPhone app](#iphone-app): needs a Mac with Xcode and an Apple ID.
3. [Sync](#sync-optional): shares the For You batch between the two. Skip it if you use one device.

Each step ends with a **Check**. If a check fails, see [Troubleshooting](#troubleshooting) before going on.

> **For AI agents:** do the steps in order and run every check. Some steps need the person at the keyboard (marked **👤**): clicking in Chrome's extension page, signing in to X or Instagram, and approving things on the iPhone. Ask them to do those, then verify. Never type their passwords into anything. You may generate the sync token with the command given, but the person pastes it into the extension. Run every command from the repository root unless a step says otherwise.

## Get the code

```sh
git clone https://github.com/ethanniser/dreamscroll.git
cd dreamscroll
```

**Check:** `ls extension/manifest.json ios/project.yml` prints both paths.

The built extension files are committed, so the extension needs no build step. Tooling ([bun](https://bun.sh) and Node) is only needed for development; see [AGENTS.md](AGENTS.md).

## Chrome extension

Works in Chrome 120+ and other Chromium browsers (Edge, Brave, Arc).

1. **👤** Open `chrome://extensions`.
2. **👤** Turn on **Developer mode** (top right).
3. **👤** Click **Load unpacked** and choose the repository's `extension` folder (the one containing `manifest.json`).
4. **👤** Pin it: Extensions menu (puzzle icon) › pin **Dreamscroll**.
5. **👤** Make sure you're signed in to x.com and instagram.com in this browser profile (sign in the usual way if not).

**Check:** visiting `https://x.com/home` opens the Dreamscroll page instead of the timeline, and clicking **For You** shows a batch of tweets after a few seconds (a minimized window opens and closes while it fetches).

Notes:

- Branded Google Chrome ignores the `--load-extension` command-line flag, so loading it can't be automated there; it has to be the **Load unpacked** button.
- It only affects the browser profile you install it in. For Incognito, enable **Allow in Incognito** on its details page.
- **Updating:** `git pull`, then click the reload icon on the extension's card in `chrome://extensions`.

## iPhone app

Requirements:

- A Mac with **Xcode 16** or later (`xcodebuild -version`).
- **XcodeGen**: `brew install xcodegen` (`xcodegen --version`).
- An iPhone on **iOS 18** or later, connected by cable the first time.
- An **Apple ID added to Xcode** (Xcode › Settings › Accounts). A paid Apple Developer account works best. A free one also works, with limits: installs expire after 7 days (run it from Xcode again to renew), and only 3 self-built apps can be on the phone at once.

### 1. Set your team and bundle ID

Create `ios/Local.xcconfig` (it's git-ignored):

```
DEVELOPMENT_TEAM = ABCDE12345
BUNDLE_ID_PREFIX = com.yourname
```

- `DEVELOPMENT_TEAM` is your 10-character Apple team ID. Find it in Xcode › Settings › Accounts › your team, or in the `OU=` field of `security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject`.
- `BUNDLE_ID_PREFIX` must be unique to you (reverse DNS, e.g. `com.janedoe`). The app becomes `<prefix>.dreamscroll`.

**Check:** `cat ios/Local.xcconfig` shows both values, with no quotes.

### 2. Generate the Xcode project

```sh
(cd ios && xcodegen generate)
```

**Check:** it prints `Created project at …/Dreamscroll.xcodeproj`.

### 3. Prepare the iPhone (first time only)

1. **👤** Connect it by cable, unlock it, and tap **Trust** on "Trust This Computer?".
2. **👤** Turn on **Developer Mode**: Settings › Privacy & Security › Developer Mode (the iPhone restarts). If the setting isn't there yet, do step 4 once; the failed attempt makes it appear.

**Check:** `xcrun devicectl list devices` lists the iPhone as `connected`. Note its identifier.

### 4. Build and install

Easiest: `open ios/Dreamscroll.xcodeproj`, pick your iPhone as the run destination, and press **Run** (⌘R).

From the command line instead (use the identifier from step 3; this also registers the iPhone with your team):

```sh
xcodebuild -project ios/Dreamscroll.xcodeproj -scheme Dreamscroll -configuration Debug \
  -destination 'platform=iOS,id=<identifier>' -derivedDataPath ios/build \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device <identifier> ios/build/Build/Products/Debug-iphoneos/Dreamscroll.app
```

**Check:** the build ends with `** BUILD SUCCEEDED **` and the install prints `App installed`.

### 5. On the iPhone

1. **👤** If the app won't open ("Untrusted Developer"), go to Settings › General › VPN & Device Management and trust your developer certificate.
2. **👤** Open Dreamscroll and tap **Sign in to X** and **Sign in to Instagram**. Sessions stay inside the app, separate from Safari.
3. **👤** Optional Safari blocker: Settings › Apps › Safari › Extensions › Dreamscroll › **Allow Extension**. Then x.com and instagram.com won't load in Safari; share links to Dreamscroll instead.

**Check:** the dashboard shows **For You**, and tapping it shows a batch of tweets after a few seconds.

If you use Screen Time's web content limits, set them to **Unrestricted**: other settings also block the app's own browser and lock Safari's extension settings.

## Sync (optional)

Without sync, each device keeps its own For You batch, and everything else works the same. With sync, both show the same batch.

1. Run a sync server: deploy [`sync/`](sync/README.md) to Convex (free; **👤** the person logs in to Convex once), or use anything that implements the [sync API](docs/sync-api.md). You'll have an `https://` address and a token of 32+ characters.
2. **👤** In the extension's main page, open **Sync**, paste the address and token, and click **Save**. Allow access to the server when Chrome asks.
3. **👤** Click **QR for iPhone**. In the iPhone app, open Settings › **Scan QR code** and point it at the screen (or use the Camera app and confirm).

**Check:** the extension shows **Sync on**, and after fetching a batch on one device, the other shows the same tweets.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Manifest file is missing or unreadable` | You chose the repository folder; choose `extension/` inside it. |
| x.com still shows the timeline | Reload the extension, then reload the tab. Check it's enabled for this profile. |
| For You says it can't fetch | Sign in to x.com in that browser (or in the app), then try again. |
| `No Account for Team` / signing errors | `ios/Local.xcconfig` has the wrong team ID, or the Apple ID isn't added to Xcode. |
| `Your team has no devices from which to generate a provisioning profile` | Build for the connected iPhone (`-destination 'platform=iOS,id=…'` with `-allowProvisioningDeviceRegistration`), or run once from Xcode. |
| `Failed to register bundle identifier` | Someone else uses that ID: change `BUNDLE_ID_PREFIX`, then `xcodegen generate` again. |
| `This app cannot be installed because its integrity could not be verified` | With a free Apple ID, only 3 apps you've built yourself can be installed at once (other development apps count too). Delete one from the phone, then install again. |
| Sync: `needs permission to reach …` / `needs access to that server` | Click **Reconnect** (or **Save**) and accept Chrome's permission prompt. |
| Sync: `rejected the token (401)` | The token doesn't match `DREAMSCROLL_TOKEN` on **that** deployment (with Convex, the production one: see [sync/README.md](sync/README.md)). |
