import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../../src/storage/cache.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";
import { writeSnapshot } from "../../src/velocity/snapshot.ts";

function makeApp(overrides: Partial<RawAppData> = {}): RawAppData {
  return {
    store: "apple",
    appId: "com.test.calorie",
    market: "us",
    name: "Calorie Counter",
    developer: "Test Dev",
    category: "Health & Fitness",
    rank: 5,
    rating: 4.5,
    ratingsCount: 12_345,
    priceUsd: 0,
    iapPresent: true,
    description: "Track your meals and reach your goals.",
    screenshotUrls: [],
    iconUrl: null,
    releaseDate: null,
    lastUpdated: null,
    scrapedAt: "2026-04-29T12:00:00.000Z",
    ...overrides,
  };
}

describe("writeSnapshot", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("writes N rows on empty cache", () => {
    const apps = [makeApp({ appId: "a1" }), makeApp({ appId: "a2" }), makeApp({ appId: "a3" })];
    const result = writeSnapshot({ apps, cache, snapshotDay: "2026-04-29" });
    expect(result).toEqual({ written: 3, skipped: 0, day: "2026-04-29" });
  });

  test("re-writing same day same apps is idempotent", () => {
    const apps = [makeApp({ appId: "a1" }), makeApp({ appId: "a2" })];
    writeSnapshot({ apps, cache, snapshotDay: "2026-04-29" });
    const second = writeSnapshot({ apps, cache, snapshotDay: "2026-04-29" });
    expect(second).toEqual({ written: 0, skipped: 2, day: "2026-04-29" });
  });

  test("snapshotDay arg overrides clock", () => {
    const apps = [makeApp({ appId: "a1" })];
    const result = writeSnapshot({ apps, cache, snapshotDay: "2020-01-01" });
    expect(result.day).toBe("2020-01-01");
  });

  test("default snapshotDay is today UTC (YYYY-MM-DD)", () => {
    const apps = [makeApp({ appId: "a1" })];
    const result = writeSnapshot({ apps, cache });
    expect(result.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.day).toBe(new Date().toISOString().slice(0, 10));
  });

  test("malformed RawAppData throws (Zod parse rejects before insert)", () => {
    const bad = { ...makeApp(), market: "USA" } as RawAppData; // 3-letter, not ISO-2
    expect(() => writeSnapshot({ apps: [bad], cache, snapshotDay: "2026-04-29" })).toThrow();
  });

  test("missing rankByKey entry → rankOfDay = null in payload", () => {
    const app = makeApp({ appId: "a1" });
    writeSnapshot({
      apps: [app],
      cache,
      snapshotDay: "2026-04-29",
      rankByKey: new Map(), // empty
    });
    const rows = cache.snapshotStore().selectSnapshotRange({
      store: "apple",
      appId: "a1",
      market: "us",
      startDay: "2026-04-29",
      endDay: "2026-04-29",
    });
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload);
    expect(payload.rankOfDay).toBeNull();
  });

  test("rankByKey hit populates rankOfDay", () => {
    const app = makeApp({ appId: "a1" });
    writeSnapshot({
      apps: [app],
      cache,
      snapshotDay: "2026-04-29",
      rankByKey: new Map([["apple:a1:us", 7]]),
    });
    const rows = cache.snapshotStore().selectSnapshotRange({
      store: "apple",
      appId: "a1",
      market: "us",
      startDay: "2026-04-29",
      endDay: "2026-04-29",
    });
    expect(JSON.parse(rows[0]!.payload).rankOfDay).toBe(7);
  });

  test("partial conflict: some new, some duplicate", () => {
    writeSnapshot({
      apps: [makeApp({ appId: "a1" })],
      cache,
      snapshotDay: "2026-04-29",
    });
    const result = writeSnapshot({
      apps: [makeApp({ appId: "a1" }), makeApp({ appId: "a2" })],
      cache,
      snapshotDay: "2026-04-29",
    });
    expect(result).toEqual({ written: 1, skipped: 1, day: "2026-04-29" });
  });
});
