import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../../src/storage/cache.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";
import { seedSnapshotHistory } from "./fixtures.ts";

function makeApp(overrides: Partial<RawAppData> = {}): RawAppData {
  return {
    store: "apple",
    appId: "com.test.app",
    market: "us",
    name: "Test",
    developer: "Dev",
    category: "Productivity",
    rank: null,
    rating: 4.5,
    ratingsCount: 5_000,
    priceUsd: 0,
    iapPresent: true,
    description: "...",
    screenshotUrls: [],
    iconUrl: null,
    releaseDate: null,
    lastUpdated: null,
    scrapedAt: "2026-04-29T12:00:00.000Z",
    ...overrides,
  };
}

describe("seedSnapshotHistory", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("seeds N consecutive UTC days ending at endDay", () => {
    const app = makeApp({ appId: "a1" });
    seedSnapshotHistory({
      store: cache.snapshotStore(),
      apps: [app],
      days: 5,
      endDay: "2026-04-29",
    });
    const rows = cache.snapshotStore().selectSnapshotRange({
      store: "apple",
      appId: "a1",
      market: "us",
      startDay: "2026-04-25",
      endDay: "2026-04-29",
    });
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.snapshot_day)).toEqual([
      "2026-04-25",
      "2026-04-26",
      "2026-04-27",
      "2026-04-28",
      "2026-04-29",
    ]);
  });

  test("interpolates rankOfDay linearly from startRank to endRank", () => {
    const app = makeApp({ appId: "a1" });
    seedSnapshotHistory({
      store: cache.snapshotStore(),
      apps: [app],
      days: 5,
      endDay: "2026-04-29",
      startRank: 60,
      endRank: 10,
    });
    const rows = cache.snapshotStore().selectSnapshotRange({
      store: "apple",
      appId: "a1",
      market: "us",
      startDay: "2026-04-25",
      endDay: "2026-04-29",
    });
    const ranks = rows.map((r) => JSON.parse(r.payload).rankOfDay);
    expect(ranks[0]).toBe(60);
    expect(ranks[ranks.length - 1]).toBe(10);
    // Strictly decreasing
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeLessThan(ranks[i - 1]);
    }
  });

  test("ratingsCount climbs by ratingsPerDay starting from oldest seed", () => {
    const app = makeApp({ appId: "a1", ratingsCount: 1_000 });
    seedSnapshotHistory({
      store: cache.snapshotStore(),
      apps: [app],
      days: 5,
      endDay: "2026-04-29",
      ratingsPerDay: 100,
    });
    const rows = cache.snapshotStore().selectSnapshotRange({
      store: "apple",
      appId: "a1",
      market: "us",
      startDay: "2026-04-25",
      endDay: "2026-04-29",
    });
    const ratings = rows.map((r) => JSON.parse(r.payload).raw.ratingsCount);
    expect(ratings).toEqual([1_000, 1_100, 1_200, 1_300, 1_400]);
  });

  test("preserves null ratingsCount when seed is null", () => {
    const app = makeApp({ appId: "a1", ratingsCount: null });
    seedSnapshotHistory({
      store: cache.snapshotStore(),
      apps: [app],
      days: 3,
      endDay: "2026-04-29",
      ratingsPerDay: 50,
    });
    const rows = cache.snapshotStore().selectSnapshotRange({
      store: "apple",
      appId: "a1",
      market: "us",
      startDay: "2026-04-27",
      endDay: "2026-04-29",
    });
    for (const row of rows) {
      expect(JSON.parse(row.payload).raw.ratingsCount).toBeNull();
    }
  });

  test("seeds multiple apps independently per day", () => {
    seedSnapshotHistory({
      store: cache.snapshotStore(),
      apps: [makeApp({ appId: "a1" }), makeApp({ appId: "a2" })],
      days: 3,
      endDay: "2026-04-29",
    });
    const a1 = cache.snapshotStore().selectSnapshotRange({
      store: "apple",
      appId: "a1",
      market: "us",
      startDay: "2026-04-27",
      endDay: "2026-04-29",
    });
    const a2 = cache.snapshotStore().selectSnapshotRange({
      store: "apple",
      appId: "a2",
      market: "us",
      startDay: "2026-04-27",
      endDay: "2026-04-29",
    });
    expect(a1).toHaveLength(3);
    expect(a2).toHaveLength(3);
  });

  test("days <= 0 throws", () => {
    expect(() =>
      seedSnapshotHistory({
        store: cache.snapshotStore(),
        apps: [makeApp()],
        days: 0,
      }),
    ).toThrow();
  });
});
