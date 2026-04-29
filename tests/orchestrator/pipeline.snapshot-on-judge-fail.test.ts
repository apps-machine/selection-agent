import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CostBudget } from "../../src/judges/budget.ts";
import type { JudgeClient } from "../../src/judges/text-judge.ts";
import { runScan } from "../../src/orchestrator/pipeline.ts";
import { Cache } from "../../src/storage/cache.ts";
import { fakeImageFetcher, fakeScraperLib, fakeVisionClient } from "./fakes.ts";

describe("runScan — snapshot on judge fail", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("text judge throws → snapshot still written (Track B keeps accumulating)", async () => {
    const failingTextClient: JudgeClient = {
      messages: {
        async create() {
          throw new Error("fake text judge: 500 internal");
        },
      },
    };
    const apps = { us: [{ appId: "us.app1", screenshots: [] }] };
    const result = await runScan({
      cache,
      markets: ["us"],
      stores: ["apple"],
      topN: 5,
      scrapers: {
        apple: fakeScraperLib({ appsByMarket: apps }),
        google: fakeScraperLib({ appsByMarket: { us: [] } }),
      },
      textClient: failingTextClient,
      visionClient: fakeVisionClient(),
      fetchImage: fakeImageFetcher,
      budget: new CostBudget({ capUsd: 100 }),
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "snap-on-fail",
    });

    expect(result.snapshotResult.written).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.textJudge).toBeNull();
  });
});
