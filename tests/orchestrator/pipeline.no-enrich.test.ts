import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CostBudget } from "../../src/judges/budget.ts";
import { runScan } from "../../src/orchestrator/pipeline.ts";
import type { AppQuery, ScraperLib } from "../../src/scrapers/api.ts";
import { Cache } from "../../src/storage/cache.ts";
import { fakeImageFetcher, fakeScraperLib, fakeTextClient, fakeVisionClient } from "./fakes.ts";

/** Wraps a ScraperLib and counts every fetchApp invocation in a shared state object. */
function countingScraperLib(inner: ScraperLib): { lib: ScraperLib; state: { appCalls: number } } {
  const state = { appCalls: 0 };
  const lib: ScraperLib = {
    async fetchChart(q) {
      return inner.fetchChart(q);
    },
    async fetchApp(q: AppQuery) {
      state.appCalls += 1;
      return inner.fetchApp(q);
    },
  };
  return { lib, state };
}

describe("runScan — enrich:false short-circuit", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("enrich:false → scrapeApps never called, enrichmentSkipped=true", async () => {
    const apps = {
      us: [
        { appId: "us.app1", ratings: 50_000, description: "rich a1" },
        { appId: "us.app2", ratings: 80_000, description: "rich a2" },
      ],
    };
    const wrapped = countingScraperLib(fakeScraperLib({ appsByMarket: apps }));
    const result = await runScan({
      cache,
      markets: ["us"],
      stores: ["apple"],
      topN: 10,
      noLlm: true,
      enrich: false,
      scrapers: {
        apple: wrapped.lib,
        google: fakeScraperLib({ appsByMarket: { us: [] } }),
      },
      textClient: fakeTextClient(),
      visionClient: fakeVisionClient(),
      fetchImage: fakeImageFetcher,
      budget: new CostBudget({ capUsd: 100 }),
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "no-enrich",
    });

    // The contract: --no-enrich means scrapeApps is never invoked. Any non-zero
    // count here means the pipeline silently re-enabled enrichment.
    expect(wrapped.state.appCalls).toBe(0);
    expect(result.enrichmentSkipped).toBe(true);
    expect(result.enrichmentFailedCount).toBe(0);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((c) => c.enrichmentSource === "skipped")).toBe(true);
  });

  test("enrich:true (default) → scrapeApps IS called", async () => {
    // Negative control: pin the default behavior so a flipped default is loud.
    const apps = {
      us: [{ appId: "us.app1", ratings: 50_000, description: "rich a1" }],
    };
    const wrapped = countingScraperLib(fakeScraperLib({ appsByMarket: apps }));
    await runScan({
      cache,
      markets: ["us"],
      stores: ["apple"],
      topN: 10,
      noLlm: true,
      // enrich omitted on purpose — default must be true.
      scrapers: {
        apple: wrapped.lib,
        google: fakeScraperLib({ appsByMarket: { us: [] } }),
      },
      textClient: fakeTextClient(),
      visionClient: fakeVisionClient(),
      fetchImage: fakeImageFetcher,
      budget: new CostBudget({ capUsd: 100 }),
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "default-enrich",
    });

    expect(wrapped.state.appCalls).toBeGreaterThan(0);
  });
});
