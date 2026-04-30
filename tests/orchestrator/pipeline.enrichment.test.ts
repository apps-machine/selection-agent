import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CostBudget } from "../../src/judges/budget.ts";
import { runScan } from "../../src/orchestrator/pipeline.ts";
import { Cache } from "../../src/storage/cache.ts";
import { fakeImageFetcher, fakeScraperLib, fakeTextClient, fakeVisionClient } from "./fakes.ts";

describe("runScan — enrichment happy path", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("chart-stripped charts get enriched; composite > 0 for every candidate", async () => {
    // Chart fetch returns NO ratings + NO description (mimicking real Apple
    // chart endpoints). Without enrichment, composite would compute ~0/10
    // because revenue + locGap scorers feed off ratings + description.
    // Enrichment populates them, so composite must be > 0.
    const apps = {
      us: [
        { appId: "us.app1", ratings: 50_000, description: "Track calories with AI photos." },
        { appId: "us.app2", ratings: 100_000, description: "Best photo enhancer." },
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
        apple: fakeScraperLib({ appsByMarket: apps, chartStripped: true }),
        google: fakeScraperLib({ appsByMarket: { us: [] } }),
      },
      textClient: fakeTextClient(),
      visionClient: fakeVisionClient(),
      fetchImage: fakeImageFetcher,
      budget: new CostBudget({ capUsd: 100 }),
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "enrichment-happy",
    });

    expect(result.candidates.length).toBe(3);
    expect(result.enrichmentSkipped).toBe(false);
    expect(result.enrichmentFailedCount).toBe(0);
    // Every candidate had its chart entry replaced with enriched data, so
    // ratingsCount + description are populated and composite is non-zero.
    for (const c of result.candidates) {
      expect(c.app.ratingsCount).not.toBeNull();
      expect(c.app.description.length).toBeGreaterThan(0);
      expect(c.composite.composite).toBeGreaterThan(0);
      expect(c.enrichmentSource).toBe("enriched");
    }
  });

  test("Track B receives enriched rows when enrichment succeeds (regression: 0.5.1)", async () => {
    // 0.5.1 lesson: writeSnapshot was silently dead in production because
    // chart entries failed RawAppDataSchema; M7 makes writeSnapshot run on
    // enriched data. Pin that the snapshot was written AND that the persisted
    // row reflects the enriched description, not the chart placeholder.
    const apps = {
      us: [{ appId: "us.app1", ratings: 50_000, description: "Track calories with AI photos." }],
    };
    const result = await runScan({
      cache,
      markets: ["us"],
      stores: ["apple"],
      topN: 5,
      noLlm: true,
      scrapers: {
        apple: fakeScraperLib({ appsByMarket: apps, chartStripped: true }),
        google: fakeScraperLib({ appsByMarket: { us: [] } }),
      },
      textClient: fakeTextClient(),
      visionClient: fakeVisionClient(),
      fetchImage: fakeImageFetcher,
      budget: new CostBudget({ capUsd: 100 }),
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "enrichment-track-b",
    });

    expect(result.snapshotResult.written).toBe(1);
    const rows = cache.snapshotStore().selectSnapshotRange({
      store: "apple",
      appId: "us.app1",
      market: "us",
      startDay: "2026-04-29",
      endDay: "2026-04-29",
    });
    expect(rows).toHaveLength(1);
    // The persisted payload must carry the enriched description, not the
    // (stripped) chart placeholder.
    const payload = JSON.parse(rows[0]?.payload ?? "{}");
    expect(payload.raw.description).toBe("Track calories with AI photos.");
    expect(payload.raw.ratingsCount).toBe(50_000);
  });
});
