---
name: iphone-device
description: Build the Dreamscroll iPhone app and install it on a real iPhone, inspect it there (logs, the debug probe, live page layouts) or drive it. Use when asked to put the latest build on the phone, "update the app", test on the iPhone, or debug something that only happens in the app.
---

# Dreamscroll on a real iPhone

The app runs the extension's own `policy.js` and `content.js` (bundled at build time), so **any change to `extension/` reaches the phone only through a new build.** After a filtering fix, reinstall.

## Setup (once per Mac)

- Xcode, `xcodegen`, and a signing team. Put `DEVELOPMENT_TEAM` and `BUNDLE_ID_PREFIX` in `ios/Local.xcconfig` (git-ignored; `ios/Config.xcconfig` explains). Don't edit `Config.xcconfig`.
- The iPhone in Developer Mode and paired with the Mac (connect it by cable once and trust the Mac).

## Build and install

```sh
xcrun devicectl list devices          # the phone's identifier; "available (paired)" is enough
cd ios && xcodegen generate
xcodebuild -project Dreamscroll.xcodeproj -scheme Dreamscroll -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath build/device -allowProvisioningUpdates build
xcrun devicectl device install app --device <identifier> \
  build/device/Build/Products/Debug-iphoneos/Dreamscroll.app
```

- **No cable needed.** A paired phone on the same network installs over Wi-Fi (its name in the device list ends in `.coredevice.local`). Say "installed over the network", not "over USB", unless it is plugged in.
- **The first install right after a build often fails** with `ControlChannelConnectionError` / `Connection reset by peer`. Retry once; it works. If the phone isn't listed as available, it's asleep or off the network: ask the person to wake or unlock it.
- **Free (personal) teams:** builds expire after **7 days** (then the app won't open: rebuild and reinstall), and only 3 of your apps may be installed at once. Updating keeps the app's data, sign-ins and Safari-extension setting.
- Reinstalling doesn't launch the app or need the screen; tell the person it's there.
- Before installing, make sure the build contains what you mean to ship: commit first, and name the commit.

## Simulator instead

`bun run media:ios` boots a Simulator with demo data (see `scripts/media/simulator.mjs`). Use it for UI changes that don't depend on live X or Instagram; it's how the README's iPhone screenshots are made.

## Inspecting the app on the phone

- **Logs:** the app logs `SF …` lines (navigation decisions, outcomes) with the `browser` category. URLs are logged `.private`, so they show as `<private>` unless the device has a logging profile. Use Console.app (select the phone, filter `SF`) or a phone-control tool's log command.
- **Debug probe** for live mobile layouts (how X/Instagram's mobile web differs from desktop): build with `SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG DREAMSCROLL_PROBE` in `ios/Local.xcconfig`, copy a `probe.js` into the app's `Documents/` (`xcrun devicectl device copy to --device <id> --domain-type appDataContainer --domain-identifier <bundle id> --source probe.js --destination Documents/probe.js`). It runs five seconds after each page load and logs its result as `SF probe`. Keep probes structural (test ids, roles, counts); never log message or notification text. Remove the probe and the flag when done.
- Debug builds allow Safari's Web Inspector (Develop menu → the phone → the page); release builds don't.

## Driving the phone

If a phone-control tool is available (for example Ghosthand), use its own instructions, plus:

- Confirm with the person that the phone is unlocked and free before any input; they may be using it.
- Screenshot before every tap; never repeat an input after an error without looking.
- **Never change system or security settings** (Settings toggles, permissions, Safari extensions): navigate there at most, then hand over. If the person says stop, stop at once and release the device.
- Never post, like, follow or send messages from the phone.

## The Safari blocker

It ships inside the app but iOS needs it switched on once: Settings › Apps › Safari › Extensions › Dreamscroll › Allow Extension (the person does this). Dreamscroll's own Settings screen then shows "Safari extension: On".
