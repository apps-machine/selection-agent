import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CostBudget } from "../../src/judges/budget.ts";
import { runScan } from "../../src/orchestrator/pipeline.ts";
import { Cache } from "../../src/storage/cache.ts";
import {
  blockedScraperLib,
  fakeImageFetcher,
  fakeScraperLib,
  fakeTextClient,
  fakeVisionClient,
} from "./fakes.ts";

describe("runScan — Apple blocked", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("Apple chart throws → Google candidates still ranked, failedSlices populated", async () => {
    const apps = { us: [{ appId: "g.us.app1", screenshots: ["https://x/1"] }] };
    const result = await runScan({
      cache,
      markets: ["us"],
      stores: ["apple", "google"],
      topN: 5,
      scrapers: {
        apple: blockedScraperLib("Akamai 429"),
        google: fakeScraperLib({ appsByMarket: apps }),
      },
      textClient: fakeTextClient(),
      visionClient: fakeVisionClient(),
      fetchImage: fakeImageFetcher,
      budget: new CostBudget({ capUsd: 10 }),
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "blocked",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.app.store).toBe("google");
    expect(result.failedSlices).toHaveLength(1);
    expect(result.failedSlices[0]?.store).toBe("apple");
    expect(result.failedSlices[0]?.market).toBe("us");
    expect(result.failedSlices[0]?.reason).toContain("Akamai 429");
    expect(result.snapshotResult.written).toBe(1);
  });

  test("ALL slices blocked → returns empty candidates with all failedSlices reported", async () => {
    const result = await runScan({
      cache,
      markets: ["us", "fr"],
      stores: ["apple", "google"],
      topN: 5,
      scrapers: {
        apple: blockedScraperLib("blocked-apple"),
        google: blockedScraperLib("blocked-google"),
      },
      textClient: fakeTextClient(),
      visionClient: fakeVisionClient(),
      fetchImage: fakeImageFetcher,
      budget: new CostBudget({ capUsd: 10 }),
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "all-blocked",
    });
    expect(result.candidates).toEqual([]);
    expect(result.failedSlices).toHaveLength(4);
    expect(result.snapshotResult.written).toBe(0);
  });
});
