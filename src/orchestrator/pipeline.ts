import { createHash } from "node:crypto";
import pino from "pino";
import { CostBudget } from "../judges/budget.ts";
import { JUDGE_CACHE_TTL_SECONDS, judgeCacheKey, withJudgeCache } from "../judges/cache.ts";
import {
  type JudgeResult,
  type TextJudgeResult,
  TextJudgeResultSchema,
  type VisionJudgeResult,
  VisionJudgeResultSchema,
} from "../judges/schemas.ts";
import {
  DEFAULT_TEXT_JUDGE_MODEL,
  type JudgeClient,
  judgeAppText,
  type TokenUsage,
} from "../judges/text-judge.ts";
import {
  DEFAULT_VISION_JUDGE_MODEL,
  type ImageFetcher,
  judgeAppVision,
  type VisionJudgeClient,
} from "../judges/vision-judge.ts";
import { rank } from "../reporting/ranker.ts";
import { scoreComposite } from "../scoring/composite.ts";
import type { ScraperLib } from "../scrapers/api.ts";
import { type AppScrapeJob, scrapeApps } from "../scrapers/app-scraper.ts";
import { type ChartScrapeJob, scrapeCharts } from "../scrapers/chart-scraper.ts";
import type { Cache } from "../storage/cache.ts";
import type { RawAppData, Store } from "../types/raw-app-data.ts";
import { RateLimiter } from "../util/rate-limit.ts";
import { getVelocityScore } from "../velocity/delta.ts";
import { type WriteSnapshotResult, writeSnapshot } from "../velocity/snapshot.ts";
import { type EnrichmentSource, makeKey, mergeEnrichments } from "./enrich.ts";
import type { FailedSlice, ScanResult, ScoredCandidate } from "./types.ts";

/**
 * Default scan markets for `runScan` when the caller doesn't override.
 *
 * v0.7.0 pivoted these from the original Phase-0 list `[us,jp,de,fr,br,es]`
 * to tier-2 SEA + Bangladesh. The rationale is empirical: M7.5's LLM-judged
 * scan (2026-04-30, $0.56 spend across 40 candidates) found the
 * localization-gap thesis is dead in tier-1 markets (avg locGap 1.0/10 in
 * BR, 1.4/10 in MX) but alive in tier-2 (BD 7.7/10, TH 7.0/10, VN 6.8/10,
 * MY 6.2/10, ID 5.8/10). Top-grossing apps in tier-1 are localized natively
 * by Google/OpenAI/ByteDance; tier-2 markets get default-English ports
 * 12-18 months late and indefinitely. PH was excluded because English is a
 * co-official language there (avg locGap 4.5/10).
 *
 * Full empirical write-up: docs/planning/m7.5-thesis-validation.md.
 *
 * Callers can still pass `markets: ["us", ...]` explicitly to override.
 */
export const DEFAULT_MARKETS = ["bd", "th", "vn", "my", "id"] as const;
const PHASE_0_STORES: readonly Store[] = ["apple", "google"];
const SCRAPE_CACHE_TTL_SECONDS = 60 * 60;
const MARKET_CONCURRENCY = 6;
const APP_ENRICHMENT_CONCURRENCY = 8;
// Shared per-host token bucket. Sized so charts(6) + apps(8) = 14 concurrent
// calls don't all land on apple.com or play.google.com at once. Capacity 8
// allows a small burst; refill 4/sec sustains under Akamai's tolerance band.
const RATE_LIMIT_CAPACITY = 8;
const RATE_LIMIT_REFILL_PER_SECOND = 4;

export interface ScanInput {
  cache: Cache;
  markets?: readonly string[];
  stores?: readonly Store[];
  topN?: number;
  noLlm?: boolean;
  /**
   * When true (default), the pipeline runs an app-detail enrichment pass
   * (`scrapeApps`) between the chart scrape and the snapshot write so the
   * heuristic scorers receive full description + ratings. When false, the
   * pipeline short-circuits enrichment and the snapshot/judges run on
   * chart-quality data only — composite scores will be heavily degraded
   * (chart entries have no description / ratings on most upstream libs).
   * The CLI maps `--no-enrich` to false.
   */
  enrich?: boolean;
  scrapers: { apple: ScraperLib; google: ScraperLib };
  /** Required when `noLlm` is false. May be a stub when noLlm is true. */
  textClient: JudgeClient;
  visionClient: VisionJudgeClient;
  fetchImage: ImageFetcher;
  budget?: CostBudget;
  /**
   * Optional override of the shared per-host RateLimiter. Defaults to one
   * `RateLimiter` (capacity 8, refill 4/sec) constructed inside `runScan`,
   * which is shared between `scrapeCharts` and `scrapeApps` so charts(6) +
   * apps(8) = 14 concurrent calls don't all land on apple.com or
   * play.google.com at once and trip Akamai/Google rate limits. Tests can
   * pass a no-op or a custom-tuned limiter.
   */
  rateLimiter?: RateLimiter;
  /** Override clock for tests. */
  now?: () => number;
  /** Seed for `runId`. Defaults to ISO timestamp; tests pin a string. */
  runIdSeed?: string;
  textModel?: string;
  visionModel?: string;
}

const logger = pino({ name: "orchestrator", level: process.env.LOG_LEVEL ?? "info" });

function makeRunId(seed: string | undefined, nowMs: number): string {
  if (seed) return `run-${seed}`;
  return `run-${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}`;
}

function contentDigestText(app: RawAppData, model: string): string {
  const h = createHash("sha256");
  h.update(model);
  h.update("|");
  h.update(app.description.slice(0, 1500));
  h.update("|");
  h.update(`${app.name}|${app.developer}|${app.category}|${app.market}`);
  return h.digest("hex");
}

function contentDigestVision(app: RawAppData, model: string): string {
  const h = createHash("sha256");
  h.update(model);
  h.update("|");
  for (const url of app.screenshotUrls) {
    h.update(url);
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * Top-level scan: scrape charts for every (store × market) slice in
 * parallel, enrich each chart entry with the app-detail endpoint
 * (description + ratings), write the M5 snapshot, compute heuristic +
 * judge scores, and rank the survivors.
 *
 * Pipeline:
 *
 *   scrapeCharts (concurrency=6, shared rate limiter)
 *        │  outcomes: chart-quality RawAppData[]   failures: FailedSlice[]
 *        ▼
 *   scrapeApps   (concurrency=8, shared rate limiter, opt-out via enrich:false)
 *        │  outcomes: full AppDetails               failures: per-app errors
 *        ▼
 *   mergeEnrichments
 *        │  enriched-or-chart-fallback RawAppData[] + per-app source
 *        ▼
 *   writeSnapshot                       (Track B — now sees enriched rows)
 *        ▼
 *   per-app: velocity + judges → composite → rank
 *
 * Resilience invariants:
 *  - One blocked chart slice never kills the run: scrapeCharts catches
 *    per-job errors into `failures`, the rest of the run continues.
 *  - One failed enrichment never kills the run: scrapeApps reports failures
 *    per-app, mergeEnrichments uses the chart entry as fallback, and
 *    `enrichmentFailedCount` surfaces the count to the brief.
 *  - Track B snapshot runs even when judges fail later — keeps accumulating
 *    during an LLM outage. After M7 it sees enriched rows when enrichment
 *    succeeded, which improves baseline quality going forward.
 *  - One shared `RateLimiter` across charts + apps caps host concurrency so
 *    14 concurrent calls (6 charts + 8 apps) don't trip Akamai/Google.
 */
export async function runScan(input: ScanInput): Promise<ScanResult> {
  const markets = (input.markets ?? DEFAULT_MARKETS).slice();
  const stores = (input.stores ?? PHASE_0_STORES).slice();
  const topN = input.topN ?? 30;
  const noLlm = input.noLlm ?? false;
  const enrich = input.enrich ?? true;
  const now = (input.now ?? Date.now)();
  const runId = makeRunId(input.runIdSeed, now);
  const generatedAt = new Date(now).toISOString();
  const budget = input.budget ?? new CostBudget();
  const textModel = input.textModel ?? DEFAULT_TEXT_JUDGE_MODEL;
  const visionModel = input.visionModel ?? DEFAULT_VISION_JUDGE_MODEL;
  const rateLimiter =
    input.rateLimiter ??
    new RateLimiter({
      capacity: RATE_LIMIT_CAPACITY,
      refillPerSecond: RATE_LIMIT_REFILL_PER_SECOND,
    });

  // 1. Scrape charts for every (store × market) slice. scrapeCharts uses
  //    mapWithConcurrency which catches per-job errors → failures array.
  const jobs: ChartScrapeJob[] = [];
  for (const store of stores) {
    for (const market of markets) {
      jobs.push({ store, market, collection: "top-grossing", limit: topN });
    }
  }
  const chartReport = await scrapeCharts(jobs, {
    cache: input.cache,
    cacheTtlSeconds: SCRAPE_CACHE_TTL_SECONDS,
    clients: input.scrapers,
    concurrency: MARKET_CONCURRENCY,
    rateLimiter,
  });

  const failedSlices: FailedSlice[] = chartReport.failures.map((f) => ({
    store: f.job.store,
    market: f.job.market,
    reason: f.error.message,
  }));

  const chartApps: RawAppData[] = [];
  for (const outcome of chartReport.outcomes) {
    for (const app of outcome.apps) {
      chartApps.push(app);
    }
  }

  // 2. Enrich each chart entry with app-detail (opt-out via --no-enrich).
  //    Failures fall back to the chart entry; the count surfaces in the
  //    brief so the founder knows which scores were computed on thin data.
  let enrichedApps: RawAppData[];
  let enrichmentSourceByKey: Map<string, EnrichmentSource>;
  let enrichmentFailedCount: number;
  if (enrich && chartApps.length > 0) {
    const enrichJobs: AppScrapeJob[] = chartApps.map((app) => ({
      store: app.store,
      market: app.market,
      appId: app.appId,
      rank: app.rank,
    }));
    const enrichReport = await scrapeApps(enrichJobs, {
      cache: input.cache,
      cacheTtlSeconds: SCRAPE_CACHE_TTL_SECONDS,
      clients: input.scrapers,
      concurrency: APP_ENRICHMENT_CONCURRENCY,
      rateLimiter,
    });
    const merged = mergeEnrichments({
      chartApps,
      outcomes: enrichReport.outcomes,
      failures: enrichReport.failures,
      logger: (msg, ctx) => logger.warn(ctx, msg),
    });
    enrichedApps = merged.apps;
    enrichmentSourceByKey = merged.sources;
    enrichmentFailedCount = merged.enrichmentFailedCount;
  } else {
    enrichedApps = chartApps;
    enrichmentSourceByKey = new Map();
    enrichmentFailedCount = 0;
  }
  const enrichmentSkipped = !enrich;

  const rankByKey = new Map<string, number>();
  for (const app of enrichedApps) {
    if (app.rank !== null) {
      rankByKey.set(`${app.store}:${app.appId}:${app.market}`, app.rank);
    }
  }

  const snapshotDayIso = new Date(now).toISOString().slice(0, 10);

  // 3. Snapshot side-effect — runs on enriched rows, even if judges fail later.
  let snapshotResult: WriteSnapshotResult;
  try {
    snapshotResult = writeSnapshot({
      apps: enrichedApps,
      cache: input.cache,
      rankByKey,
      now: () => now,
      // Pin the snapshot day from the orchestrator's `now` so tests with a
      // fixed clock get deterministic snapshot rows. In production
      // `input.now` defaults to `Date.now`, so this resolves to today UTC.
      snapshotDay: snapshotDayIso,
    });
  } catch (e) {
    logger.warn(
      { err: (e as Error).message },
      "writeSnapshot threw — continuing without snapshot side-effect",
    );
    snapshotResult = { written: 0, skipped: 0, day: new Date(now).toISOString().slice(0, 10) };
  }

  // 4. Per-app: velocity + judges, then composite.
  const onTokenUsage = (usage: TokenUsage): void => {
    budget.recordAndAssert(usage);
  };

  const judgeResults: JudgeResult[] = [];
  const judgeStore = input.cache.judgeResultStore();
  const scored: ScoredCandidate[] = [];

  for (const app of enrichedApps) {
    const velocity = getVelocityScore({
      cache: input.cache,
      store: app.store,
      appId: app.appId,
      market: app.market,
      // Pin the velocity asOf day to the orchestrator clock so tests with
      // a fixed `now` get deterministic baselines. In production this
      // resolves to today UTC (same as the previous implicit default).
      asOf: snapshotDayIso,
    });

    let textJudge: TextJudgeResult | null = null;
    let visionJudge: VisionJudgeResult | null = null;

    if (!noLlm) {
      const textKey = judgeCacheKey({
        kind: "text",
        model: textModel,
        appId: app.appId,
        market: app.market,
        contentDigest: contentDigestText(app, textModel),
      });

      const textCached = await withJudgeCache({
        cache: input.cache,
        key: textKey,
        schema: TextJudgeResultSchema,
        factory: () =>
          judgeAppText({ app, client: input.textClient, model: textModel, onTokenUsage }),
        ttlSeconds: JUDGE_CACHE_TTL_SECONDS,
      });

      if (textCached.ok) {
        textJudge = textCached.value;
        judgeResults.push(textCached.value);
        judgeStore.insertJudgeResult({ runId, result: textCached.value, createdAt: now });
      } else {
        logger.warn({ appId: app.appId, err: textCached.error.message }, "text-judge errored");
      }

      if (app.screenshotUrls.length > 0) {
        const visionKey = judgeCacheKey({
          kind: "vision",
          model: visionModel,
          appId: app.appId,
          market: app.market,
          contentDigest: contentDigestVision(app, visionModel),
        });
        const visionCached = await withJudgeCache({
          cache: input.cache,
          key: visionKey,
          schema: VisionJudgeResultSchema,
          factory: () =>
            judgeAppVision({
              app,
              client: input.visionClient,
              fetchImage: input.fetchImage,
              model: visionModel,
              onTokenUsage,
            }),
          ttlSeconds: JUDGE_CACHE_TTL_SECONDS,
        });
        if (visionCached.ok) {
          visionJudge = visionCached.value;
          judgeResults.push(visionCached.value);
          judgeStore.insertJudgeResult({ runId, result: visionCached.value, createdAt: now });
        } else {
          logger.warn(
            { appId: app.appId, err: visionCached.error.message },
            "vision-judge errored",
          );
        }
      }
    }

    const composite = scoreComposite({ app, velocity });
    const key = makeKey(app.store, app.appId, app.market);
    const enrichmentSource: ScoredCandidate["enrichmentSource"] = enrichmentSkipped
      ? "skipped"
      : (enrichmentSourceByKey.get(key) ?? "chart-only");
    scored.push({ app, composite, textJudge, visionJudge, enrichmentSource });
  }

  const ranked = rank(scored, topN);

  return {
    runId,
    generatedAt,
    markets,
    appsScanned: enrichedApps.length,
    costUsd: budget.spentUsd(),
    candidates: ranked,
    judgeResults,
    snapshotResult,
    failedSlices,
    enrichmentFailedCount,
    enrichmentSkipped,
  };
}
