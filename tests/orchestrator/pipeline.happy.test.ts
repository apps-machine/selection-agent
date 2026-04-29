import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CostBudget } from "../../src/judges/budget.ts";
import { runScan } from "../../src/orchestrator/pipeline.ts";
import { Cache } from "../../src/storage/cache.ts";
import { fakeImageFetcher, fakeScraperLib, fakeTextClient, fakeVisionClient } from "./fakes.ts";

describe("runScan — happy path", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("returns ranked candidates, writes snapshot, persists judge_result rows", async () => {
    const apps = {
      us: [
        { appId: "us.app1", screenshots: ["https://x/1"] },
        { appId: "us.app2", screenshots: ["https://x/2"] },
      ],
      jp: [{ appId: "jp.app1", screenshots: ["https://x/3"] }],
    };
    const result = await runScan({
      cache,
      markets: ["us", "jp"],
      stores: ["apple", "google"],
      topN: 5,
      scrapers: {
        apple: fakeScraperLib({ appsByMarket: apps }),
        google: fakeScraperLib({ appsByMarket: apps }),
      },
      textClient: fakeTextClient(),
      visionClient: fakeVisionClient(),
      fetchImage: fakeImageFetcher,
      budget: new CostBudget({ capUsd: 100 }),
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "happy",
    });

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeLessThanOrEqual(5);
    expect(result.candidates.every((c) => c.rank > 0)).toBe(true);
    // 2 markets × 2 stores: us has 2 apps, jp has 1 → 6 raw apps total.
    expect(result.snapshotResult.written).toBe(6);
    expect(result.appsScanned).toBe(6);
    expect(result.candidates.every((c) => c.textJudge !== null)).toBe(true);
    expect(result.candidates.every((c) => c.visionJudge !== null)).toBe(true);

    // Judge cache (content-addressed) dedupes across stores: same appId +
    // market + description on apple+google produce one cache hit, so
    // judge_result rows == unique(appId, market) × 2 kinds = 3 × 2 = 6.
    const rows = cache.judgeResultStore().selectByRunId(result.runId);
    expect(rows.length).toBe(6);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.failedSlices).toEqual([]);
  });
});
