import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CostBudget } from "../../src/judges/budget.ts";
import { runScan } from "../../src/orchestrator/pipeline.ts";
import { Cache } from "../../src/storage/cache.ts";
import { fakeImageFetcher, fakeScraperLib, fakeTextClient, fakeVisionClient } from "./fakes.ts";

describe("runScan — budget breach", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("$0.005 cap fails fast on the third judge call", async () => {
    // Each text-only judge call: 200*$3/MTok + 100*$15/MTok = $0.0021.
    // 1st call → $0.0021 (under). 2nd → $0.0042 (under). 3rd → $0.0063 (BREACH).
    // We force 5 distinct (appId, market) tuples so cache misses each time.
    const apps = {
      us: Array.from({ length: 5 }, (_, i) => ({
        appId: `us.app${i}`,
        screenshots: [],
      })),
    };
    await expect(
      runScan({
        cache,
        markets: ["us"],
        stores: ["apple"],
        topN: 30,
        scrapers: {
          apple: fakeScraperLib({ appsByMarket: apps }),
          google: fakeScraperLib({ appsByMarket: { us: [] } }),
        },
        textClient: fakeTextClient(),
        visionClient: fakeVisionClient(),
        fetchImage: fakeImageFetcher,
        budget: new CostBudget({ capUsd: 0.005 }),
        now: () => Date.parse("2026-04-29T12:00:00.000Z"),
        runIdSeed: "budget",
      }),
    ).rejects.toThrow(/exceeded cost budget/);
  });
});
