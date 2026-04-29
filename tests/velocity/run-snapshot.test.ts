import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChartEntry, ChartQuery, ScraperLib } from "../../src/scrapers/api.ts";
import { Cache } from "../../src/storage/cache.ts";
import { runSnapshot } from "../../src/velocity/run-snapshot.ts";

function fakeChartEntry(appId: string): ChartEntry {
  return {
    appId,
    title: appId,
    developer: "FakeDev",
    primaryGenre: "Productivity",
    score: 4.5,
    ratings: 1_000,
    description: "Fake description for snapshot smoke test.",
  };
}

function fakeClient(prefix: string): ScraperLib {
  return {
    async fetchChart(q: ChartQuery): Promise<ChartEntry[]> {
      return [
        fakeChartEntry(`${prefix}.${q.market}.app1`),
        fakeChartEntry(`${prefix}.${q.market}.app2`),
      ];
    },
    async fetchApp(): Promise<ChartEntry> {
      throw new Error("fetchApp not used by snapshot command");
    },
  };
}

describe("runSnapshot (smoke)", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("scrapes 2 markets x 2 stores, writes 8 rows, reports 0 failures", async () => {
    const result = await runSnapshot({
      dbPath: ":memory:",
      limit: 5,
      cache,
      clients: { apple: fakeClient("a"), google: fakeClient("g") },
      markets: ["us", "fr"],
      snapshotDay: "2026-04-29",
    });
    // 2 markets * 2 stores * 2 apps each = 8
    expect(result).toEqual({
      day: "2026-04-29",
      written: 8,
      skipped: 0,
      failures: 0,
      failedMarkets: [],
    });
  });

  test("re-running same day is idempotent (skipped == 8, written == 0)", async () => {
    const opts = {
      dbPath: ":memory:",
      limit: 5,
      cache,
      clients: { apple: fakeClient("a"), google: fakeClient("g") },
      markets: ["us", "fr"],
      snapshotDay: "2026-04-29",
    };
    await runSnapshot(opts);
    const second = await runSnapshot(opts);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(8);
  });

  test("rankByKey is populated from chart-scraper rank (1-based)", async () => {
    await runSnapshot({
      dbPath: ":memory:",
      limit: 5,
      cache,
      clients: { apple: fakeClient("a"), google: fakeClient("g") },
      markets: ["us"],
      snapshotDay: "2026-04-29",
    });
    const rows = cache.snapshotStore().selectSnapshotRange({
      store: "apple",
      appId: "a.us.app1",
      market: "us",
      startDay: "2026-04-29",
      endDay: "2026-04-29",
    });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload).rankOfDay).toBe(1);
  });

  test("failing client surfaces as failure entry, doesn't abort", async () => {
    const failing: ScraperLib = {
      async fetchChart(): Promise<ChartEntry[]> {
        throw new Error("boom");
      },
      async fetchApp(): Promise<ChartEntry> {
        throw new Error("boom");
      },
    };
    const result = await runSnapshot({
      dbPath: ":memory:",
      limit: 5,
      cache,
      clients: { apple: fakeClient("a"), google: failing },
      markets: ["us"],
      snapshotDay: "2026-04-29",
    });
    // apple succeeded (2 apps), google failed
    expect(result.written).toBe(2);
    expect(result.failures).toBe(1);
    expect(result.failedMarkets).toEqual(["google:us"]);
  });
});
