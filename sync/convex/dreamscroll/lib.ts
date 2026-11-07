import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { dayIn, openSnapshot, publicState, snapshotJson, spend, type Batch, type PublicState } from "./rules";

// The For You batch window and the daily budget, shared across devices. Called by the
// app's HTTP routes (./routes.ts), which check the token and pass the time and zone in:
// components don't read the app's environment variables.

const SITE = "x" as const;

async function currentBatch(ctx: QueryCtx) {
  return await ctx.db.query("dreamscrollBatches").withIndex("by_site", (q) => q.eq("site", SITE)).unique();
}

async function budgetDay(ctx: QueryCtx, day: string) {
  return await ctx.db
    .query("dreamscrollBudgetDays")
    .withIndex("by_site_and_day", (q) => q.eq("site", SITE).eq("day", day))
    .unique();
}

const asBatch = (doc: { startedAt: number; endsAt: number; tweets: string } | null): Batch | null =>
  doc ? { startedAt: doc.startedAt, endsAt: doc.endsAt, tweets: doc.tweets } : null;

async function readState(ctx: QueryCtx, now: number, timeZone: string | undefined): Promise<PublicState> {
  const day = dayIn(timeZone, now);
  const batch = asBatch(await currentBatch(ctx));
  return publicState(batch, day, (await budgetDay(ctx, day))?.usedMs ?? 0, now);
}

/** One batch row, replaced by the next batch (old batches are not kept). */
async function saveBatch(ctx: MutationCtx, next: Batch) {
  const row = { site: SITE, ...next, count: (JSON.parse(next.tweets) as unknown[]).length };
  const existing = await currentBatch(ctx);
  if (existing) await ctx.db.replace("dreamscrollBatches", existing._id, row);
  else await ctx.db.insert("dreamscrollBatches", row);
}

export const state = query({
  args: { now: v.number(), timeZone: v.optional(v.string()) },
  handler: async (ctx, { now, timeZone }) => readState(ctx, now, timeZone),
});

export const apply = mutation({
  args: {
    now: v.number(),
    timeZone: v.optional(v.string()),
    op: v.union(v.literal("snapshot"), v.literal("spend")),
    // The client's tweets, already serialized by the HTTP route (validated again here).
    tweets: v.optional(v.string()),
    ms: v.optional(v.number()),
  },
  handler: async (ctx, { op, now, timeZone, tweets, ms }) => {
    const day = dayIn(timeZone, now);
    const existing = asBatch(await currentBatch(ctx));
    if (op === "snapshot") {
      let parsed: unknown = null;
      try { parsed = tweets ? JSON.parse(tweets) : null; } catch { parsed = null; }
      const json = snapshotJson(parsed);
      if (json) {
        const next = openSnapshot(existing, json, now);
        if (next !== existing) await saveBatch(ctx, next);
      }
    } else if (op === "spend") {
      const row = await budgetDay(ctx, day);
      const usedMs = spend(row?.usedMs ?? 0, ms);
      if (row) await ctx.db.patch("dreamscrollBudgetDays", row._id, { usedMs });
      else await ctx.db.insert("dreamscrollBudgetDays", { site: SITE, day, usedMs });
    }
    return await readState(ctx, now, timeZone);
  },
});
