import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../../src/storage/cache.ts";
import {
  scrapeCharts,
  type ChartScrapeJob,
} from "../../src/scrapers/chart-scraper.ts";
import type { ChartEntry, ScraperLib } from "../../src/scrapers/api.ts";

function makeStubClient(entries: ChartEntry[]): ScraperLib {
  return {
    fetchChart: async () => entries,
    fetchApp: async () => ({ appId: "x" }),
  };
}

describe("scrapeCharts", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("scrapes multiple jobs in parallel and assigns rank", async () => {
    const apple = makeStubClient([
      { appId: "com.a.first", title: "First" },
      { appId: "com.a.second", title: "Second" },
    ]);
    const google = makeStubClient([
      { appId: "com.g.first", title: "First G" },
    ]);
    const jobs: ChartScrapeJob[] = [
      { store: "apple", market: "US", collection: "top-grossing", limit: 10 },
      { store: "google", market: "BR", collection: "top-grossing", limit: 10 },
    ];
    const report = await scrapeCharts(jobs, {
      cache,
      cacheTtlSeconds: 60,
      clients: { apple, google },
      scrapedAt: () => "2026-04-29T00:00:00.000Z",
    });
    expect(report.outcomes.length).toBe(2);
    expect(report.failures.length).toBe(0);
    const apples = report.outcomes.find((o) => o.job.store === "apple")!;
    expect(apples.apps.map((a) => a.rank)).toEqual([1, 2]);
    expect(apples.source).toBe("primary");
    const googles = report.outcomes.find((o) => o.job.store === "google")!;
    expect(googles.apps[0]?.appId).toBe("com.g.first");
  });

  test("second call serves from cache (cache-fresh)", async () => {
    let calls = 0;
    const apple: ScraperLib = {
      fetchChart: async () => {
        calls++;
        return [{ appId: "com.a.x", title: "X" }];
      },
      fetchApp: async () => ({ appId: "x" }),
    };
    const job: ChartScrapeJob = {
      store: "apple",
      market: "US",
      collection: "top-grossing",
      limit: 5,
    };
    const opts = {
      cache,
      cacheTtlSeconds: 60,
      clients: { apple, google: apple },
    };
    await scrapeCharts([job], opts);
    expect(calls).toBe(1);
    const second = await scrapeCharts([job], opts);
    expect(calls).toBe(1);
    expect(second.outcomes[0]?.source).toBe("cache-fresh");
  });

  test("captures failure when client throws and no cache available", async () => {
    const apple: ScraperLib = {
      fetchChart: async () => {
        throw new Error("apple down");
      },
      fetchApp: async () => ({ appId: "x" }),
    };
    const report = await scrapeCharts(
      [
        {
          store: "apple",
          market: "US",
          collection: "top-grossing",
          limit: 5,
        },
      ],
      {
        cache,
        cacheTtlSeconds: 60,
        clients: { apple, google: apple },
      },
    );
    expect(report.outcomes.length).toBe(0);
    expect(report.failures[0]?.error.message).toBe("apple down");
  });
});
