// Pure rules for Dreamscroll feed batches and the daily scroll budget.
// No Convex imports, so it unit-tests directly. Clients (extension/feed.js, ios/FeedStore.swift) apply the same rules offline.

export const RULES = {
  batchSize: 10, // tweets in a snapshot
  cooldownMs: 2 * 60 * 60 * 1000, // a snapshot lasts 2 hours from when it's taken
  maxSnapshotBytes: 200_000, // the stored JSON of one snapshot
  dailyBudgetMs: 15 * 60 * 1000, // unlocked scrolling per local day
  maxSpendPerReportMs: 30 * 1000, // one client report can't spend more than this
} as const;

export type Batch = { startedAt: number; endsAt: number; tweets: string };

const TWEET_ID = /^[0-9]{1,25}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** The budget day, decided by the server in a configured time zone (clients can't pick it). */
export function dayIn(timeZone: string | undefined, now: number): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

/** A window runs until it ends; a clock set back before its start doesn't end it early. */
export function isActive(batch: Batch | null, now: number): batch is Batch {
  return !!batch && now < batch.endsAt;
}

/**
 * Validates a client's snapshot: up to 10 tweets with numeric ids and valid handles,
 * within the size limit. Returns the JSON to store, or null. (Clients sanitize every
 * field again before rendering.)
 */
export function snapshotJson(tweets: unknown): string | null {
  if (!Array.isArray(tweets) || tweets.length === 0) return null;
  const kept = tweets.slice(0, RULES.batchSize).filter((t): t is { id: string; author: { handle: string } } => {
    if (!t || typeof t !== "object") return false;
    const tweet = t as { id?: unknown; author?: { handle?: unknown } };
    return typeof tweet.id === "string" && TWEET_ID.test(tweet.id) && typeof tweet.author?.handle === "string" && HANDLE.test(tweet.author.handle);
  });
  if (!kept.length) return null;
  const json = JSON.stringify(kept);
  return new TextEncoder().encode(json).length <= RULES.maxSnapshotBytes ? json : null;
}

/** The first snapshot of a window wins; a running window is never replaced. */
export function openSnapshot(existing: Batch | null, tweets: string, now: number): Batch {
  if (isActive(existing, now)) return existing;
  return { startedAt: now, endsAt: now + RULES.cooldownMs, tweets };
}

/** Adds unlocked time to a day's total, bounded per report and per day. */
export function spend(usedMs: number, ms: unknown): number {
  const amount = typeof ms === "number" && Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RULES.maxSpendPerReportMs) : 0;
  return Math.min(RULES.dailyBudgetMs, Math.max(0, usedMs) + amount);
}

export type PublicState = {
  now: number;
  batch: { active: boolean; startedAt: number | null; endsAt: number | null; tweets: unknown[]; size: number };
  budget: { day: string | null; usedMs: number; limitMs: number; remainingMs: number };
};

export function publicState(batch: Batch | null, day: string | null, usedMs: number, now: number): PublicState {
  const active = isActive(batch, now);
  return {
    now,
    batch: {
      active,
      startedAt: active ? batch.startedAt : null,
      endsAt: active ? batch.endsAt : null,
      tweets: active ? (JSON.parse(batch.tweets) as unknown[]) : [],
      size: RULES.batchSize,
    },
    budget: { day, usedMs, limitMs: RULES.dailyBudgetMs, remainingMs: Math.max(0, RULES.dailyBudgetMs - usedMs) },
  };
}
