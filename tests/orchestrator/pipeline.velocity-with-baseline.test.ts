import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CostBudget } from "../../src/judges/budget.ts";
import { runScan } from "../../src/orchestrator/pipeline.ts";
import { Cache } from "../../src/storage/cache.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";
import { seedSnapshotHistory } from "../velocity/fixtures.ts";
import { fakeImageFetcher, fakeScraperLib } from "./fakes.ts";

describe("runScan — velocity activates with 14d baseline", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("with 14 prior snapshots, composite participates velocity (eligible + flag set)", async () => {
    const seedApp: RawAppData = {
      store: "apple",
      appId: "us.app1",
      trackId: null,
      market: "us",
      name: "us.app1",
      developer: "FakeDev",
      category: "Productivity",
      rank: 10,
      rating: 4.5,
      ratingsCount: 1_000,
      priceUsd: 0,
      iapPresent: true,
      description: "Fake description.",
      screenshotUrls: [],
      iconUrl: null,
      releaseDate: null,
      lastUpdated: null,
      scrapedAt: "2026-04-29T00:00:00.000Z",
    };
    seedSnapshotHistory({
      store: cache.snapshotStore(),
      apps: [seedApp],
      days: 14,
      endDay: "2026-04-29",
      startRank: 60,
      endRank: 10,
      ratingsPerDay: 100,
    });

    const result = await runScan({
      cache,
      markets: ["us"],
      stores: ["apple"],
      topN: 5,
      noLlm: true,
      scrapers: {
        apple: fakeScraperLib({ appsByMarket: { us: [{ appId: "us.app1" }] } }),
        google: fakeScraperLib({ appsByMarket: { us: [] } }),
      },
      textClient: {
        messages: {
          async create() {
            throw new Error("noLlm");
          },
        },
      },
      visionClient: {
        messages: {
          async create() {
            throw new Error("noLlm");
          },
        },
      },
      fetchImage: fakeImageFetcher,
      budget: new CostBudget({ capUsd: 100 }),
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "velocity",
    });

    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0];
    // v1: weights.velocity is now a participation flag (1 = velocity
    // contributed, 0 = absent), not the legacy 0.25 multiplier weight.
    expect(c?.composite.breakdown.velocity).not.toBeNull();
    expect(c?.composite.weights.velocity).toBe(1);
    expect(c?.composite.eligible).toBe(true);
  });
});
