/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import componentSchema from "./dreamscroll/schema";
import { RULES, dayIn, isActive, openSnapshot, snapshotJson, spend } from "./dreamscroll/rules";

// The app (convex/http.ts) with the component mounted, as in a real deployment.
const appModules = import.meta.glob(["./*.ts", "./_generated/*.*s"]);
const componentModules = import.meta.glob("./dreamscroll/**/*.*s");
function setup() {
  const t = convexTest(undefined, appModules);
  t.registerComponent("dreamscroll", componentSchema, componentModules);
  return t;
}
const TOKEN = "t".repeat(48);
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

describe("rules", () => {
  const tweet = (id: string, handle = "ada") => ({ id, author: { handle, name: "Ada" }, segments: [{ text: "hi" }] });

  test("a snapshot opens a window once; the first snapshot of a window wins", () => {
    const first = openSnapshot(null, "[1]", 1_000);
    expect(first).toEqual({ startedAt: 1_000, endsAt: 1_000 + RULES.cooldownMs, tweets: "[1]" });
    expect(openSnapshot(first, "[2]", 2_000)).toBe(first);
    expect(openSnapshot(first, "[2]", first.endsAt).tweets).toBe("[2]");
  });

  test("snapshots are validated: ids, handles, at most a batch of tweets, size-limited", () => {
    expect(snapshotJson(null)).toBeNull();
    expect(snapshotJson([])).toBeNull();
    expect(snapshotJson([{ id: "x", author: { handle: "ada" } }, { id: "1", author: { handle: "bad handle" } }])).toBeNull();
    const many = Array.from({ length: 30 }, (_, i) => tweet(String(100 + i)));
    expect(JSON.parse(snapshotJson(many)!)).toHaveLength(RULES.batchSize);
    expect(snapshotJson([{ ...tweet("1"), segments: [{ text: "x".repeat(RULES.maxSnapshotBytes) }] }])).toBeNull();
  });

  test("the budget day comes from the server clock in the configured zone", () => {
    const t = Date.parse("2026-11-07T20:00:00Z");
    expect(dayIn("UTC", t)).toBe("2026-11-07");
    expect(dayIn("Asia/Seoul", t)).toBe("2026-11-08");
    expect(dayIn("America/Los_Angeles", t)).toBe("2026-11-07");
    expect(dayIn("Not/AZone", t)).toBe("2026-11-07");
  });

  test("setting the clock back doesn't end a window early", () => {
    const batch = openSnapshot(null, "[1]", 10_000);
    expect(isActive(batch, 5_000)).toBe(true);
    expect(openSnapshot(batch, "[2]", 5_000)).toBe(batch);
  });

  test("spending is bounded per report and per day, and ignores junk", () => {
    expect(spend(0, 10_000)).toBe(10_000);
    expect(spend(0, 10 * 60_000)).toBe(RULES.maxSpendPerReportMs);
    expect(spend(0, -5_000)).toBe(0);
    expect(spend(0, Number.NaN)).toBe(0);
    expect(spend(0, "30000")).toBe(0);
    expect(spend(RULES.dailyBudgetMs - 1_000, 30_000)).toBe(RULES.dailyBudgetMs);
  });
});

describe("http api", () => {
  beforeEach(() => {
    vi.stubEnv("DREAMSCROLL_TOKEN", TOKEN);
    vi.stubEnv("DREAMSCROLL_TIMEZONE", "UTC");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-07T10:00:00Z"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("rejects missing, wrong, or unconfigured tokens", async () => {
    const t = setup();
    expect((await t.fetch("/dreamscroll/state", { method: "GET" })).status).toBe(401);
    expect((await t.fetch("/dreamscroll/state", { headers: { authorization: `Bearer ${"x".repeat(48)}` } })).status).toBe(401);
    expect((await t.fetch("/dreamscroll/snapshot", { method: "POST", headers: { authorization: `Bearer ${TOKEN}x` } })).status).toBe(401);
    vi.stubEnv("DREAMSCROLL_TOKEN", "short");
    expect((await t.fetch("/dreamscroll/state", { headers: { authorization: "Bearer short" } })).status).toBe(401);
  });

  test("snapshot and spend are shared state across devices", async () => {
    const t = setup();
    const post = async (op: string, body: object) =>
      (await t.fetch(`/dreamscroll/${op}`, { method: "POST", headers: auth, body: JSON.stringify(body) })).json();
    const tweets = (from: number, n = 20) => Array.from({ length: n }, (_, i) => ({ id: String(from + i), author: { handle: "ada" }, segments: [{ text: "t" }] }));

    const before = await (await t.fetch("/dreamscroll/state", { headers: auth })).json();
    expect(before.batch).toMatchObject({ active: false, tweets: [], size: RULES.batchSize });
    expect(before.budget).toMatchObject({ day: "2026-11-07", usedMs: 0, remainingMs: RULES.dailyBudgetMs });

    // The laptop captures first; the phone's later snapshot doesn't replace it.
    const laptop = await post("snapshot", { tweets: tweets(100) });
    expect(laptop.batch.active).toBe(true);
    expect(laptop.batch.endsAt - laptop.batch.startedAt).toBe(RULES.cooldownMs);
    expect(laptop.batch.tweets).toHaveLength(RULES.batchSize);
    const phone = await post("snapshot", { tweets: tweets(900) });
    expect(phone.batch.tweets[0].id).toBe("100");
    expect(phone.batch.startedAt).toBe(laptop.batch.startedAt);

    await post("spend", { ms: 20_000 });
    const spent = await post("spend", { ms: 999_999 });
    expect(spent.budget.usedMs).toBe(20_000 + RULES.maxSpendPerReportMs);
    // A client can't pick the day: a future date still spends today's budget.
    const future = await post("spend", { day: "2099-01-01", ms: 10_000 });
    expect(future.budget).toMatchObject({ day: "2026-11-07", usedMs: 60_000 });

    // After two hours the next snapshot opens a new window.
    vi.setSystemTime(new Date(Date.now() + RULES.cooldownMs + 1));
    const later = await (await t.fetch("/dreamscroll/state", { headers: auth })).json();
    expect(later.batch.active).toBe(false);
    const next = await post("snapshot", { tweets: tweets(500, 5) });
    expect(next.batch).toMatchObject({ active: true });
    expect(next.batch.tweets.map((x: { id: string }) => x.id)).toEqual(["500", "501", "502", "503", "504"]);
  });

  test("bad bodies are rejected or ignored, never stored", async () => {
    const t = setup();
    expect((await t.fetch("/dreamscroll/snapshot", { method: "POST", headers: auth, body: "{nope" })).status).toBe(400);
    const huge = [{ id: "1", author: { handle: "ada" }, segments: [{ text: "x".repeat(RULES.maxSnapshotBytes) }] }];
    for (const body of [{ tweets: "123" }, { tweets: [{ id: "<b>", author: { handle: "x" } }] }, {}, { tweets: huge }]) {
      const res = await t.fetch("/dreamscroll/snapshot", { method: "POST", headers: auth, body: JSON.stringify(body) });
      expect(res.status).toBe(422);
    }
    const state = await (await t.fetch("/dreamscroll/state", { headers: auth })).json();
    expect(state.batch.active).toBe(false);
  });
});

test("the budget resets at midnight in the configured zone", async () => {
  vi.stubEnv("DREAMSCROLL_TOKEN", TOKEN);
  vi.stubEnv("DREAMSCROLL_TIMEZONE", "Asia/Seoul");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const t = setup();
    const spendNow = async () => (await t.fetch("/dreamscroll/spend", { method: "POST", headers: auth, body: JSON.stringify({ ms: 30_000 }) })).json();
    vi.setSystemTime(new Date("2026-11-07T14:59:00Z")); // 23:59 in Seoul
    expect((await spendNow()).budget).toMatchObject({ day: "2026-11-07", usedMs: 30_000 });
    vi.setSystemTime(new Date("2026-11-07T15:01:00Z")); // 00:01 next day in Seoul
    expect((await spendNow()).budget).toMatchObject({ day: "2026-11-08", usedMs: 30_000 });
  } finally {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});
