import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The component's own tables (isolated from the app that mounts it).
export default defineSchema({
  // The current X feed snapshot: up to 10 For You tweets (JSON, ≤ 200 KB) shown
  // on both devices until `endsAt`. One row per site, replaced by the next snapshot.
  dreamscrollBatches: defineTable({
    site: v.literal("x"),
    startedAt: v.number(),
    endsAt: v.number(),
    tweets: v.string(),
    count: v.number(),
  }).index("by_site", ["site"]),

  // Unlocked-scrolling time spent per day (YYYY-MM-DD in the configured time zone, decided by the server).
  dreamscrollBudgetDays: defineTable({
    site: v.literal("x"),
    day: v.string(),
    usedMs: v.number(),
  }).index("by_site_and_day", ["site", "day"]),
});
