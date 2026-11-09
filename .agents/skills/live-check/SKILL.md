---
name: live-check
description: Diagnose and verify Dreamscroll against the real x.com and instagram.com — when a page "doesn't load", shows the "not available" cover, shows too much, or a button/menu does nothing, and after any change to filtering (policy.js, content.js, content.css). Covers reproducing with fixtures, inspecting live pages safely, and the manual checks.
---

# Checking Dreamscroll against the live sites

X and Instagram change their markup without notice, and the tests use fixtures. So a filtering bug is usually "the live page no longer looks like our fixture", and a fix is only done when the fixture matches the live page again.

## When something doesn't work on a page

1. **Is the URL a destination?** Ask the rules before looking at the page:
   ```sh
   node -e "require('./extension/policy.js'); const P=globalThis.SocialPolicy; const u=process.argv[1];
     console.log(P.view(u), P.staticRules().filter(r=>r.action.type==='allow'&&r.condition.regexFilter&&new RegExp(r.condition.regexFilter).test(u)).map(r=>r.id))" '<url>'
   ```
   `view` null or `home` with no allow rule → the network rules send it to the main page. That's a `policy.js` change (new kind or pattern), then `bun run build:rules`.
2. **Allowed but blank, covered, or wrong?** Then `content.js` didn't find what it expected. Look at the live page's structure (below) and compare with what the matching branch of `isolate()` looks for.
3. **A control does nothing?** On X, pop-ups render in `#layers`, which is hidden except for the `VIEW_POPOVER` allowlist in `content.js`.

## Inspecting a live page

Use a browser the person is signed into (a browser-automation tool attached to their own browser, or their phone's app with the debug probe; see the `iphone-device` skill).

- Query **structure only**: `data-testid`s, roles, `aria-label`s, element counts, the ancestor chain of one element, whether Dreamscroll's attributes are present (`data-sf-view` on `<html>`, `[data-sf-target]`, `#sf-empty` = our "not available" cover). Don't read out DMs, notifications, or other people's content beyond what you need.
- If that browser runs Dreamscroll, gated URLs redirect there too, so you can only inspect pages that are already allowed. For a new destination, add it first and inspect after the person reloads.
- Look, don't act: opening a menu or the composer is fine; posting, liking, reposting, following, bookmarking or sending isn't, ever.
- Close any tabs you opened.

## Fixing

- Write the fixture from what you saw (keep the test ids, roles and nesting that matter, with a dated comment like `// Live x.com (2026-11): …`), add the test, and **check it fails without the fix**.
- Prefer X's/Instagram's own messages over our cover when they're showing something (a deleted post's "doesn't exist", a suspended account's notice).
- `bun run test` and `bun run check` must pass (the regex check guards Chrome's RE2 budget).
- Add a CHANGELOG line under [Unreleased].

## Verifying for real

Agents can't reload the unpacked extension. After pushing, tell the person which commit to load (Reload on Dreamscroll in `chrome://extensions`) and what to look at. For the iPhone app, rebuild and reinstall (`iphone-device` skill).

After filtering changes, go through the **Manual checks** at the end of `docs/how-it-works.md`, and add a line there when a new destination or behavior deserves one.
