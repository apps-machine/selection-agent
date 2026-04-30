import { describe, expect, test } from "bun:test";
import { makeKey, mergeEnrichments } from "../../src/orchestrator/enrich.ts";
import type { AppScrapeJob, AppScrapeOutcome } from "../../src/scrapers/app-scraper.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";

function mkApp(args: {
  store?: "apple" | "google";
  appId: string;
  market?: string;
  description?: string;
  ratingsCount?: number | null;
  rank?: number | null;
}): RawAppData {
  return {
    store: args.store ?? "apple",
    appId: args.appId,
    trackId: null,
    market: args.market ?? "us",
    name: args.appId,
    developer: "Dev",
    category: "Productivity",
    rank: args.rank ?? null,
    rating: 4.5,
    ratingsCount: args.ratingsCount ?? null,
    priceUsd: 0,
    iapPresent: true,
    description: args.description ?? "",
    screenshotUrls: [],
    iconUrl: null,
    releaseDate: null,
    lastUpdated: null,
    scrapedAt: "2026-04-29T12:00:00.000Z",
  };
}

function mkOutcome(app: RawAppData, jobOverride?: Partial<AppScrapeJob>): AppScrapeOutcome {
  return {
    job: {
      store: jobOverride?.store ?? app.store,
      appId: jobOverride?.appId ?? app.appId,
      market: jobOverride?.market ?? app.market,
      rank: jobOverride?.rank ?? app.rank,
    },
    app,
    source: "primary",
  };
}

describe("mergeEnrichments", () => {
  test("happy path: every chart entry has a matching enrichment", () => {
    const charts = [
      mkApp({ appId: "a1", description: "" }),
      mkApp({ appId: "a2", description: "" }),
      mkApp({ appId: "a3", description: "" }),
    ];
    const outcomes = [
      mkOutcome(mkApp({ appId: "a1", description: "rich a1", ratingsCount: 10_000 })),
      mkOutcome(mkApp({ appId: "a2", description: "rich a2", ratingsCount: 20_000 })),
      mkOutcome(mkApp({ appId: "a3", description: "rich a3", ratingsCount: 30_000 })),
    ];

    const out = mergeEnrichments({ chartApps: charts, outcomes, failures: [] });

    expect(out.enrichmentFailedCount).toBe(0);
    expect(out.apps.map((a) => a.description)).toEqual(["rich a1", "rich a2", "rich a3"]);
    expect(out.apps.map((a) => a.ratingsCount)).toEqual([10_000, 20_000, 30_000]);
    expect(out.sources.get(makeKey("apple", "a1", "us"))).toBe("enriched");
    expect(out.sources.get(makeKey("apple", "a2", "us"))).toBe("enriched");
    expect(out.sources.get(makeKey("apple", "a3", "us"))).toBe("enriched");
  });

  test("partial failure: 2 enriched + 1 failed → fallback to chart, count=1", () => {
    const charts = [
      mkApp({ appId: "a1", description: "chart a1" }),
      mkApp({ appId: "a2", description: "chart a2" }),
      mkApp({ appId: "a3", description: "chart a3" }),
    ];
    const outcomes = [
      mkOutcome(mkApp({ appId: "a1", description: "rich a1", ratingsCount: 10_000 })),
      mkOutcome(mkApp({ appId: "a3", description: "rich a3", ratingsCount: 30_000 })),
    ];
    const failures = [
      {
        job: { store: "apple" as const, appId: "a2", market: "us", rank: null },
        error: new Error("Akamai 429"),
      },
    ];
    const logs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];

    const out = mergeEnrichments({
      chartApps: charts,
      outcomes,
      failures,
      logger: (msg, ctx) => logs.push({ msg, ctx }),
    });

    expect(out.enrichmentFailedCount).toBe(1);
    expect(out.apps.map((a) => a.description)).toEqual(["rich a1", "chart a2", "rich a3"]);
    expect(out.sources.get(makeKey("apple", "a1", "us"))).toBe("enriched");
    expect(out.sources.get(makeKey("apple", "a2", "us"))).toBe("chart-only");
    expect(out.sources.get(makeKey("apple", "a3", "us"))).toBe("enriched");
    // The failure must have been logged at warn level for ops visibility.
    expect(logs.some((l) => l.msg.includes("enrichment failed for chart entry"))).toBe(true);
  });

  test("total failure: zero outcomes + every job failed → all chart-only", () => {
    const charts = [
      mkApp({ appId: "a1", description: "chart a1" }),
      mkApp({ appId: "a2", description: "chart a2" }),
    ];
    const failures = charts.map((a) => ({
      job: { store: a.store, appId: a.appId, market: a.market, rank: a.rank },
      error: new Error("akamai storm"),
    }));

    const out = mergeEnrichments({ chartApps: charts, outcomes: [], failures });

    expect(out.enrichmentFailedCount).toBe(2);
    expect(out.apps.map((a) => a.description)).toEqual(["chart a1", "chart a2"]);
    expect([...out.sources.values()]).toEqual(["chart-only", "chart-only"]);
  });

  test("empty charts → empty merged, count=0", () => {
    const out = mergeEnrichments({ chartApps: [], outcomes: [], failures: [] });
    expect(out.apps).toEqual([]);
    expect(out.enrichmentFailedCount).toBe(0);
    expect(out.sources.size).toBe(0);
  });

  test("outcome appId mismatch (upstream redirect) → uses chart key, logs warn", () => {
    // Chart entry says "a1"; enrichment outcome's app.appId says "a1-redirected"
    // (the upstream lib followed a redirect and reported the canonical id). The
    // pipeline keys by the chart-job inputs, not the response, so we still
    // associate the redirected outcome with the original chart entry.
    const charts = [mkApp({ appId: "a1", description: "chart a1" })];
    const outcomes: AppScrapeOutcome[] = [
      {
        job: { store: "apple", appId: "a1", market: "us", rank: null },
        app: mkApp({ appId: "a1-redirected", description: "rich post-redirect" }),
        source: "primary",
      },
    ];
    const logs: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];

    const out = mergeEnrichments({
      chartApps: charts,
      outcomes,
      failures: [],
      logger: (msg, ctx) => logs.push({ msg, ctx }),
    });

    expect(out.enrichmentFailedCount).toBe(0);
    expect(out.apps[0]?.description).toBe("rich post-redirect");
    expect(out.sources.get(makeKey("apple", "a1", "us"))).toBe("enriched");
    expect(logs.some((l) => l.msg.includes("key mismatch"))).toBe(true);
  });

  test("merged app is the enrichment outcome (replaces chart entry by reference)", () => {
    // Contract: when enrichment succeeds for a chart key, the merged entry
    // IS the enriched app verbatim — not a deep merge of chart + enrichment.
    // The pipeline relies on this: it populates AppScrapeJob.rank from the
    // chart entry upstream, so the enriched app's rank already reflects chart
    // rank in production. This test pins the "merged === outcome.app" half;
    // the chart-rank-population half is verified at the pipeline level by
    // pipeline.enrichment.test.ts (snapshotResult uses chart ranks).
    const enrichedApp = mkApp({ appId: "a1", rank: 7, description: "rich a1" });
    const charts = [mkApp({ appId: "a1", rank: 7, description: "chart a1" })];
    const outcomes = [mkOutcome(enrichedApp)];

    const out = mergeEnrichments({ chartApps: charts, outcomes, failures: [] });

    expect(out.apps[0]).toBe(enrichedApp); // exact reference equality
    expect(out.apps[0]?.description).toBe("rich a1");
    expect(out.apps[0]?.rank).toBe(7);
  });

  test("makeKey produces stable strings", () => {
    expect(makeKey("apple", "1234", "us")).toBe("apple|1234|us");
    expect(makeKey("google", "com.x.y", "jp")).toBe("google|com.x.y|jp");
  });
});
