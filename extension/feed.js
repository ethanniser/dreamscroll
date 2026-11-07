// Feed snapshots and the daily scroll budget: the same rules a sync server applies
// (docs/sync-api.md), so the extension enforces them offline; when sync is
// configured the server's state is authoritative.
(() => {
  const RULES = Object.freeze({
    batchSize: 10, // tweets in a snapshot
    cooldownMs: 2 * 60 * 60 * 1000, // a snapshot lasts 2 hours from when it's taken
    dailyBudgetMs: 15 * 60 * 1000,
    maxSpendPerReportMs: 30 * 1000,
  });
  // A window runs until it ends; a clock set back before its start doesn't end it early.
  const isActive = (snapshot, now) => !!snapshot && now < snapshot.endsAt;
  /** The first snapshot of a window wins; a running window is never replaced. */
  function openSnapshot(existing, tweets, now) {
    if (isActive(existing, now)) return existing;
    return {startedAt: now, endsAt: now + RULES.cooldownMs, tweets: (Array.isArray(tweets) ? tweets : []).slice(0, RULES.batchSize)};
  }
  function spend(usedMs, ms) {
    const amount = typeof ms === 'number' && Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RULES.maxSpendPerReportMs) : 0;
    return Math.min(RULES.dailyBudgetMs, Math.max(0, usedMs) + amount);
  }
  function localDay(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  /** Same shape as the sync server's state, so local and remote state are interchangeable. */
  function publicState(snapshot, day, usedMs, now) {
    const active = isActive(snapshot, now);
    return {
      now,
      batch: {active, startedAt: active ? snapshot.startedAt : null, endsAt: active ? snapshot.endsAt : null, tweets: active ? snapshot.tweets : [], size: RULES.batchSize},
      budget: {day, usedMs, limitMs: RULES.dailyBudgetMs, remainingMs: Math.max(0, RULES.dailyBudgetMs - usedMs)},
    };
  }
  globalThis.SocialFeed = {RULES, isActive, openSnapshot, spend, localDay, publicState};
})();
