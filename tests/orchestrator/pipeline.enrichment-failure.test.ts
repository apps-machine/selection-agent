import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CostBudget } from "../../src/judges/budget.ts";
import { runScan } from "../../src/orchestrator/pipeline.ts";
import { Cache } from "../../src/storage/cache.ts";
import { fakeImageFetcher, fakeScraperLib, fakeTextClient, fakeVisionClient } from "./fakes.ts";

describe("runScan — enrichment partial failure", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("1 of 3 enrichments fails → scan still returns 3 candidates, count=1, fallback to chart", async () => {
    // Chart returns 3 apps; enrichment is forced to fail for app2 (Akamai-style
    // 429 simulation). The pipeline must (a) still return 3 candidates,
    // (b) report enrichmentFailedCount === 1, (c) tag app2 chart-only and
    // app1/app3 enriched.
    const apps = {
      us: [
        { appId: "us.app1", ratings: 50_000, description: "Track calories with AI photos." },
        { appId: "us.app2", ratings: 80_000, description: "Best photo enhancer." },
        { appId: "us.app3", ratings: 25_000, description: "Mindful productivity timer." },
      ],
    };
    const result = await runScan({
      cache,
      markets: ["us"],
      stores: ["apple"],
      topN: 10,
      noLlm: true,
      scrapers: {
        apple: fakeScraperLib({
          appsByMarket: apps,
          chartStripped: true,
          appErrorForAppIds: new Set(["us.app2"]),
        }),
        google: fakeScraperLib({ appsByMarket: { us: [] } }),
      },
      textClient: fakeTextClient(),
      visionClient: fakeVisionClient(),
      fetchImage: fakeImageFetcher,
      budget: new CostBudget({ capUsd: 100 }),
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "enrichment-partial-fail",
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.enrichmentFailedCount).toBe(1);
    expect(result.enrichmentSkipped).toBe(false);

    const byId = new Map(result.candidates.map((c) => [c.app.appId, c]));
    expect(byId.get("us.app1")?.enrichmentSource).toBe("enriched");
    expect(byId.get("us.app2")?.enrichmentSource).toBe("chart-only");
    expect(byId.get("us.app3")?.enrichmentSource).toBe("enriched");

    // The chart-only candidate carries the (stripped) chart fallback — no
    // description, no ratings count.
    const fallback = byId.get("us.app2");
    expect(fallback?.app.description).toBe("");
    expect(fallback?.app.ratingsCount).toBeNull();

    // The enriched candidates carry the rich data.
    expect(byId.get("us.app1")?.app.description).toBe("Track calories with AI photos.");
    expect(byId.get("us.app1")?.app.ratingsCount).toBe(50_000);

    // Track B still wrote 3 rows (the chart-only fallback gets persisted too —
    // better degraded data than a missing day).
    expect(result.snapshotResult.written).toBe(3);
  });

  test("every enrichment fails → all chart-only, scan completes, count=N", async () => {
    const apps = {
      us: [
        { appId: "us.app1", ratings: 50_000, description: "rich a1" },
        { appId: "us.app2", ratings: 80_000, description: "rich a2" },
      ],
    };
    const result = await runScan({
      cache,
      markets: ["us"],
      stores: ["apple"],
      topN: 10,
      noLlm: true,
      scrapers: {
        apple: fakeScraperLib({
          appsByMarket: apps,
          chartStripped: true,
          appError: new Error("Akamai storm"),
        }),
        google: fakeScraperLib({ appsByMarket: { us: [] } }),
      },
      textClient: fakeTextClient(),
      visionClient: fakeVisionClient(),
      fetchImage: fakeImageFetcher,
      budget: new CostBudget({ capUsd: 100 }),
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "enrichment-total-fail",
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.enrichmentFailedCount).toBe(2);
    expect(result.enrichmentSkipped).toBe(false);
    expect(result.candidates.every((c) => c.enrichmentSource === "chart-only")).toBe(true);
  });
});
