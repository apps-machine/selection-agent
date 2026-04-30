#!/usr/bin/env bun
/**
 * Refresh the bundled demo dataset (`src/demo/snapshot-data.json`) from
 * a real Anthropic-backed scan. The dataset shipped pre-M7 was
 * hand-curated with imagined USD revenue numbers; M7's enrichment +
 * trackId fix means a real scan now produces composite scores worth
 * actually showing.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun scripts/refresh-demo.ts
 *
 * What it does:
 *  1. Live scan — top 5, markets us+jp, store apple, $0.50 budget cap.
 *  2. Transforms `ScanResult` → `DemoSnapshot` (the smaller shape that
 *     `src/demo/run-demo.ts` consumes).
 *  3. Estimates `estimatedRevenueUsd` from `ratingsCount` via a rough
 *     industry heuristic (≈ $50/rating/year). The number is a
 *     ballpark for the demo brief, not a metric.
 *  4. Writes the result to `src/demo/snapshot-data.json`.
 *
 * Costs ~$0.30 of Anthropic credits when run end-to-end (text + vision
 * judges across ~10 candidates). The hard cap is $0.50.
 *
 * Why a script and not a one-shot bash redirect: the M7 prompt suggested
 * `bun ... scan ... > snapshot-data.json` + hand-edit. That produced a
 * `ScanResult`-shaped file, which `run-demo.ts` cannot consume — its
 * `DemoSnapshot` shape is intentionally smaller. A reproducible script
 * is the right tool: it makes the next demo refresh a one-liner.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CostBudget } from "../src/judges/budget.ts";
import { runScan } from "../src/orchestrator/pipeline.ts";
import { generateBrief } from "../src/reporting/briefs.ts";
import { loadDefaultAppleClient } from "../src/scrapers/apple-store-client.ts";
import { loadDefaultGoogleClient } from "../src/scrapers/google-play-client.ts";
import { Cache } from "../src/storage/cache.ts";

const SNAPSHOT_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "src",
  "demo",
  "snapshot-data.json",
);

const MARKETS = ["us", "jp"] as const;
const STORES = ["apple"] as const;
const TOP_N = 5;
const BUDGET_USD = 0.5;

// Industry rule of thumb: an app with N ratings on the App Store earns
// roughly N × $50/year in subscription revenue. Wildly imprecise for
// freemium / one-time-purchase apps, but the demo brief shows it as a
// rough opportunity-sizing signal, not a forecast. Founders interpret
// these numbers as orders of magnitude.
const REVENUE_PER_RATING_USD = 50;

interface DemoCandidate {
  rank: number;
  appName: string;
  store: "apple" | "google";
  market: string;
  category: string;
  estimatedRevenueUsd: number;
  localizationGap: number;
  paywallComplexity: number;
  compositeScore: number;
  reasoning: string;
}

interface DemoSnapshot {
  generatedAt: string;
  marketsScanned: number;
  candidatesEvaluated: number;
  topCandidates: DemoCandidate[];
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is required for demo refresh.");
  console.error("Run: ANTHROPIC_API_KEY=sk-ant-... bun scripts/refresh-demo.ts");
  process.exit(2);
}

const Anthropic = (await import("@anthropic-ai/sdk")).default;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const cache = Cache.open(":memory:");
try {
  const [apple, google] = await Promise.all([loadDefaultAppleClient(), loadDefaultGoogleClient()]);

  console.log(
    `Refreshing demo dataset — scan top ${TOP_N} on ${MARKETS.join(",")} × ${STORES.join(",")} (budget $${BUDGET_USD})`,
  );
  const started = Date.now();
  const result = await runScan({
    cache,
    markets: MARKETS,
    stores: STORES,
    topN: TOP_N,
    enrich: true,
    scrapers: { apple, google },
    // biome-ignore lint/suspicious/noExplicitAny: Anthropic SDK shape adapter
    textClient: client as any,
    // biome-ignore lint/suspicious/noExplicitAny: Anthropic SDK shape adapter
    visionClient: client as any,
    fetchImage: async (url, opts) => {
      const res = await fetch(url, { signal: opts?.signal });
      if (!res.ok) throw new Error(`fetchImage: ${res.status} ${res.statusText} for ${url}`);
      const ct = res.headers.get("content-type") ?? "image/png";
      const buf = Buffer.from(await res.arrayBuffer());
      return { mediaType: ct, base64: buf.toString("base64") };
    },
    budget: new CostBudget({ capUsd: BUDGET_USD }),
  });
  const durationMs = Date.now() - started;

  console.log(
    `Scan complete: ${result.candidates.length} candidates ranked, ${result.appsScanned} apps scanned, $${result.costUsd.toFixed(3)} spent, ${durationMs}ms wall.`,
  );

  // Render the brief once so the user sees what they're shipping in the
  // demo. Stored alongside the JSON for reference / sanity check.
  console.log("\n--- Brief preview ---\n");
  console.log(generateBrief(result));
  console.log("\n--- End preview ---\n");

  const top = result.candidates.slice(0, TOP_N);
  const demo: DemoSnapshot = {
    generatedAt: result.generatedAt,
    marketsScanned: result.markets.length,
    candidatesEvaluated: result.appsScanned,
    topCandidates: top.map((c): DemoCandidate => {
      const ratingsCount = c.app.ratingsCount ?? 0;
      const revenueEstimate = Math.round(ratingsCount * REVENUE_PER_RATING_USD);
      const reasoning =
        c.textJudge?.reasoning ??
        `Composite ${c.composite.composite.toFixed(1)}/10 from heuristic scoring (loc gap ${c.composite.breakdown.locGap.toFixed(1)}, paywall ${c.composite.breakdown.paywall.toFixed(1)}, revenue ${c.composite.breakdown.revenue.toFixed(1)}).`;
      return {
        rank: c.rank,
        appName: c.app.name,
        store: c.app.store,
        market: c.app.market.toUpperCase(),
        category: c.app.category,
        estimatedRevenueUsd: revenueEstimate,
        localizationGap: Number(c.composite.breakdown.locGap.toFixed(1)),
        paywallComplexity: Number(c.composite.breakdown.paywall.toFixed(1)),
        compositeScore: Number(c.composite.composite.toFixed(2)),
        reasoning,
      };
    }),
  };

  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(demo, null, 2)}\n`, "utf-8");
  console.log(`Wrote ${top.length} candidates to ${SNAPSHOT_PATH}`);
  console.log(`Verify: bun src/cli/index.ts demo`);
} finally {
  cache.close();
}
