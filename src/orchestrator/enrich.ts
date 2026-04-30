import type { AppScrapeJob, AppScrapeOutcome } from "../scrapers/app-scraper.ts";
import type { RawAppData } from "../types/raw-app-data.ts";

export type EnrichmentSource = "enriched" | "chart-only";

export interface EnrichmentMergeInput {
  /** Chart-scrape RawAppData (one per ranked chart entry). */
  chartApps: readonly RawAppData[];
  /** Outcomes from `scrapeApps`. */
  outcomes: readonly AppScrapeOutcome[];
  /** Per-job failures from `scrapeApps`. Used to count + log warnings. */
  failures: ReadonlyArray<{ job: AppScrapeJob; error: Error }>;
  /** Optional warn-level logger. */
  logger?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface EnrichmentMergeOutput {
  /**
   * One RawAppData per chart entry. When enrichment succeeded the
   * chart entry is replaced with the enriched version (rank preserved
   * from the chart). When enrichment failed, the chart entry passes
   * through unchanged.
   */
  apps: RawAppData[];
  /**
   * Per-app source map keyed by `(store|appId|market)`. The pipeline reads
   * this when building `ScoredCandidate.enrichmentSource` so the brief can
   * tag each fallback candidate `(chart-only)`.
   */
  sources: Map<string, EnrichmentSource>;
  /** Number of chart entries that fell back to chart-quality data. */
  enrichmentFailedCount: number;
}

/**
 * Merge enrichment outcomes into the chart-scrape RawAppData[]. Pure function
 * with no side effects beyond the optional warn logger.
 *
 *   chartApps[i]              + scrapeApps outcomes/failures
 *        │                              │
 *        ▼                              ▼
 *   key = store|appId|market    enriched index
 *        │                              │
 *        └──── joined by key ───────────┘
 *                    │
 *                    ▼
 *   merged[i]: enriched if available, else chart-only
 *
 * Edge cases:
 *  - enrichment outcome reports a different appId than the chart key
 *    (e.g., upstream redirect): we use the chart key for matching and
 *    fall back. A warn log is emitted so this is visible.
 *  - same key appears twice in chartApps: both slots get the same enriched
 *    record. (No dedupe — that is M2's responsibility upstream.)
 *  - rank is preserved from the chart (the enriched record carries
 *    whatever rank was passed via AppScrapeJob, which the pipeline always
 *    sets to the chart rank).
 */
export function mergeEnrichments(input: EnrichmentMergeInput): EnrichmentMergeOutput {
  const { chartApps, outcomes, failures, logger } = input;

  const enrichedByKey = new Map<string, RawAppData>();
  for (const outcome of outcomes) {
    const expectedKey = makeKey(outcome.job.store, outcome.job.appId, outcome.job.market);
    const actualKey = makeKey(outcome.app.store, outcome.app.appId, outcome.app.market);
    if (expectedKey !== actualKey && logger) {
      logger("enrichment outcome key mismatch (upstream redirect?) — using chart key", {
        expectedKey,
        actualKey,
      });
    }
    enrichedByKey.set(expectedKey, outcome.app);
  }

  const apps: RawAppData[] = [];
  const sources = new Map<string, EnrichmentSource>();
  let enrichmentFailedCount = 0;

  for (const chartApp of chartApps) {
    const key = makeKey(chartApp.store, chartApp.appId, chartApp.market);
    const enriched = enrichedByKey.get(key);
    if (enriched) {
      apps.push(enriched);
      sources.set(key, "enriched");
    } else {
      apps.push(chartApp);
      sources.set(key, "chart-only");
      enrichmentFailedCount += 1;
    }
  }

  if (failures.length > 0 && logger) {
    for (const f of failures) {
      logger("enrichment failed for chart entry — using chart fallback", {
        store: f.job.store,
        appId: f.job.appId,
        market: f.job.market,
        error: f.error.message,
      });
    }
  }

  return { apps, sources, enrichmentFailedCount };
}

export function makeKey(store: string, appId: string, market: string): string {
  return `${store}|${appId}|${market}`;
}
