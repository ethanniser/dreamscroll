# Changelog

Notable changes to Dreamscroll. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [semver](https://semver.org).

## [Unreleased]

### Added

- **Saved posts:** a Saved tile for X (Bookmarks, including folders) and Instagram (Saved, including collections), in the extension and the iPhone app.
- **Quotes:** "View quotes" on an X post opens that post's quotes.

### Changed

- Instagram Notifications and Saved open on a plain `instagram.com/` address, with no `?sf_personal=` marker for Instagram to see.

### Fixed

- A deleted post shows X's own "this page doesn't exist" message instead of Dreamscroll's "not available" cover.

## [1.0.0] - 2026-11-07

First public release.

### Added

- **Chrome extension** that redirects X and Instagram feeds to one main page and keeps the parts you came for: posts and threads, profiles, notifications, messages, the composer and typed searches.
- **For You batches:** the top 10 For You tweets, captured from X and shown on Dreamscroll's own page, at most once every two hours.
- **Swipe through the batch:** left (or ←) marks a tweet read, right (or →) opens it on X. Undo, and a list of read tweets.
- **One search box** for X searches, accounts on X or Instagram, and pasted links.
- **iPhone app** with the same rules, in-app sign-in, a share extension and an optional Safari blocker.
- **Optional sync** of the batch between devices through your own server: a [documented HTTP API](docs/sync-api.md) and a ready-made Convex component in `sync/`. Set up the phone by scanning a QR code from the extension.
