import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import pino from "pino";
import { bulkExtractCohort, createClient } from "../ground-truth/42matters-client.ts";
import { importDump } from "../ground-truth/appgoblin-import.ts";
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
  generateMechanicEvidence,
  type ImageFetcher,
  judgeAppVision,
  type VisionJudgeClient,
} from "../judges/vision-judge.ts";
import {
  type Opportunity,
  type OpportunityCategory,
  OpportunityCategorySchema,
  type OpportunityMarket,
  OpportunityMarketSchema,
  type SignalValues,
} from "../opportunities/schema.ts";
import { renderBrief, type ThesisLlmClient } from "../reporting/briefs.ts";
import { rank } from "../reporting/ranker.ts";
import { scoreComposite } from "../scoring/composite.ts";
import type { ScraperLib } from "../scrapers/api.ts";
import { type AppScrapeJob, scrapeApps } from "../scrapers/app-scraper.ts";
import { type ChartScrapeJob, scrapeCharts } from "../scrapers/chart-scraper.ts";
import type { ReviewSnippet } from "../scrapers/review-scraper.ts";
import { computeOpportunityScore, SCORING_VERSION } from "../signals/composer.ts";
import { computeCpiLtvProxy, persistCpiLtvProxySignal } from "../signals/cpi-ltv-proxy.ts";
import {
  computeIncumbentVulnerability,
  persistIncumbentVulnSignal,
} from "../signals/incumbent-vulnerability.ts";
import type { Cache } from "../storage/cache.ts";
import type { RawAppData, Store } from "../types/raw-app-data.ts";
import { RateLimiter } from "../util/rate-limit.ts";
import { getVelocityScore } from "../velocity/delta.ts";
import { type WriteSnapshotResult, writeSnapshot } from "../velocity/snapshot.ts";
import {
  computeVelocityScoreV1,
  persistVelocitySignal,
  VELOCITY_VERSION,
} from "../velocity/v1-score.ts";
import { type EnrichmentSource, makeKey, mergeEnrichments } from "./enrich.ts";
import type { FailedSlice, ScanResult, ScoredCandidate } from "./types.ts";

const v1Logger = pino({
  name: "orchestrator:v1",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Bumped on any v1 pipeline shape change (signal set, persistence layout). */
export const SIGNAL_PIPELINE_VERSION = "v1.0.0";

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

// ──────────────────────────────────────────────────────────────────────
// v1 — runV1Pipeline (Opportunity-emitting)
// ──────────────────────────────────────────────────────────────────────
//
// The v1 surface produces ONE Opportunity record from a (source_app,
// source_market, target_market, category) tuple. Composes the four v1
// signals (locGap, velocity, incumbent_vulnerability, cpi_ltv_proxy)
// + mechanic_evidence (text-only, not scored) + the LLM-rendered
// thesis brief, persists the row to the `opportunities` table, and
// returns the Opportunity for downstream consumers (CLI, tests).
//
// Design notes:
//
//  - Optional ingestion phase: when `ingest.appgoblinDumpPath` is set we
//    run the AppGoblin import (chart_snapshots populated). When the env
//    var FORTYTWO_MATTERS_API_KEY is set AND `ingest.fortyTwoMatters` is
//    truthy we run the bulk-extract sprint. Both gates are optional —
//    callers running against pre-seeded DBs (tests, scripts/run-first-
//    backtest) skip both. A missing 42matters key logs a warn + continues
//    rather than throwing; the v1 spec explicitly allows running without
//    the commercial trial when test fixtures or AppGoblin alone are
//    sufficient.
//
//  - Signals are read from existing scrapers when fresh data is in `db`,
//    otherwise the underlying `compute*` functions return null and the
//    composer applies the N≥3 eligibility rule. The pipeline NEVER
//    raises on a missing signal — null cascades cleanly.
//
//  - mechanic_evidence is rendered as a `metadata.mechanic_evidence`
//    string. v1 explicitly does not score it (per Codex Round 2 #5 —
//    inter-rater reliability eval gates v2 promotion).
//
//  - The brief is rendered with `dryRun: true` by default to avoid
//    Anthropic API dependency in tests/scripts. Production calls pass
//    `briefOptions.client` + `briefOptions.dryRun = false` to invoke the
//    real thesis-generation prompt.

export interface RunV1PipelineInput {
  /** bun:sqlite handle with v1 migrations applied (via Cache.open OR runMigrations). */
  db: Database;
  /** Source app the opportunity is derived from. */
  source_app_id: string;
  /** Origin market for the source app. */
  source_market: OpportunityMarket;
  /** Destination market the opportunity targets. */
  target_market: OpportunityMarket;
  /** App-store category — drives cpi_ltv_proxy lookup. */
  category: OpportunityCategory;
  /**
   * Kill metric for the validation plan. Required so every Opportunity
   * carries an explicit abort condition (no implicit thresholds).
   */
  kill_metric: { metric: string; threshold: number; direction: "below" | "above" };
  /** Optional in-memory app snapshot used to compute incumbent_vulnerability. */
  app?: RawAppData;
  /** Optional reviews used to compute incumbent_vulnerability. */
  reviews?: readonly ReviewSnippet[];
  /**
   * Optional ingestion sub-phase. When omitted, no ingestion runs and the
   * pipeline operates on whatever is already in `db`.
   */
  ingest?: {
    /** Local .tsv.xz path. When set, `importDump()` runs first. */
    appgoblinDumpPath?: string;
    /**
     * 42matters bulk-extract config. Skipped when env var
     * FORTYTWO_MATTERS_API_KEY is absent (logged warn, not throw).
     */
    fortyTwoMatters?: {
      app_ids: readonly string[];
      markets: readonly string[];
      t0_range: { from: number; to: number };
      /** Trial expiration timestamp ms; surfaces a warn at <5 days remaining. */
      trialExpiresAt?: number;
    };
  };
  /**
   * Optional Anthropic SDK clients for the brief renderer + mechanic evidence.
   * When omitted, the pipeline runs in dryRun mode (placeholder thesis,
   * no LLM calls). Tests + the synthetic backtest use this path.
   */
  brief?: {
    /** Anthropic SDK client for thesis generation. */
    thesisClient?: ThesisLlmClient;
    /** Vision client for mechanic_evidence (only used when app has screenshots). */
    visionClient?: VisionJudgeClient;
    fetchImage?: ImageFetcher;
    /** When true (default), render with placeholder thesis + skip mechanic LLM call. */
    dryRun?: boolean;
  };
  /** Override clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * v1 orchestration entrypoint. Produces ONE Opportunity record per call.
 *
 * Pipeline:
 *   1. Optional ingestion (AppGoblin dump + 42matters bulk-extract).
 *   2. Compute the 4 v1 signals from data already in `db` (or pass-through
 *      from `app` + `reviews` for incumbent_vulnerability).
 *   3. Compute mechanic_evidence (text-only metadata; null when LLM
 *      unavailable / dryRun=true).
 *   4. Assemble SignalValues + computeOpportunityScore.
 *   5. Build Opportunity record per the v1 contract.
 *   6. Render brief (LLM-generated thesis or placeholder when dryRun).
 *   7. Persist to `opportunities` table.
 *
 * Throws when:
 *   - The ingestion sub-phase throws (AppGoblin file missing / xz error).
 *   - The Opportunity assembly fails Zod validation (defensive — assembled
 *     in-house from typed inputs, should never trigger in practice).
 *
 * Does NOT throw when:
 *   - 42matters key missing (warn + skip).
 *   - Individual signals return null (composer handles eligibility).
 *   - LLM thesis fails (renderBrief falls back to opportunity.thesis seed).
 */
export async function runV1Pipeline(input: RunV1PipelineInput): Promise<Opportunity> {
  const now = (input.now ?? Date.now)();
  const dryRun = input.brief?.dryRun ?? true;

  // Validate market + category up front; the inputs were typed but a Zod
  // pass guarantees the persisted row matches the contract on read.
  OpportunityMarketSchema.parse(input.source_market);
  OpportunityMarketSchema.parse(input.target_market);
  OpportunityCategorySchema.parse(input.category);

  // ─── 1. Optional ingestion ─────────────────────────────────────────
  if (input.ingest?.appgoblinDumpPath) {
    v1Logger.info(
      { path: input.ingest.appgoblinDumpPath },
      "runV1Pipeline: importing AppGoblin dump",
    );
    await importDump(input.ingest.appgoblinDumpPath, input.db);
  }
  if (input.ingest?.fortyTwoMatters) {
    const apiKey = process.env.FORTYTWO_MATTERS_API_KEY;
    if (!apiKey) {
      v1Logger.warn(
        "runV1Pipeline: FORTYTWO_MATTERS_API_KEY not set — skipping bulk extraction (see docs/planning/agent-v1-real-backtest-checklist.md)",
      );
    } else {
      v1Logger.info("runV1Pipeline: running 42matters bulk extraction sprint");
      const client = createClient({
        apiKey,
        trialExpiresAt: input.ingest.fortyTwoMatters.trialExpiresAt,
      });
      await bulkExtractCohort(client, input.db, {
        app_ids: input.ingest.fortyTwoMatters.app_ids,
        markets: input.ingest.fortyTwoMatters.markets,
        t0_range: input.ingest.fortyTwoMatters.t0_range,
      });
    }
  }

  // ─── 2. Compute signals ────────────────────────────────────────────
  const signal_values: SignalValues = {};

  // velocity — reads chart_snapshots populated by ingestion or seeded by tests
  const velocityResult = computeVelocityScoreV1(input.db, input.source_app_id, {
    clock: () => now,
  });
  if (velocityResult.score !== null) {
    signal_values.velocity = velocityResult.score;
  }
  persistVelocitySignal(input.db, input.source_app_id, velocityResult.score, now);

  // incumbent_vulnerability — needs `app` + `reviews` (if absent, signal = null)
  if (input.app && input.reviews !== undefined) {
    const vulnResult = computeIncumbentVulnerability({
      app: input.app,
      reviews: input.reviews,
      clock: () => now,
    });
    if (vulnResult.score !== null) {
      signal_values.incumbent_vulnerability = vulnResult.score;
    }
    persistIncumbentVulnSignal(input.db, input.source_app_id, vulnResult.score, now);
  }

  // cpi_ltv_proxy — deterministic lookup; never null when category+market are seeded
  const cpiLtvResult = computeCpiLtvProxy(input.category, input.target_market);
  if (cpiLtvResult.score !== null) {
    signal_values.cpi_ltv_proxy = cpiLtvResult.score;
  }
  persistCpiLtvProxySignal(input.db, input.source_app_id, cpiLtvResult.score, now);

  // locGap — read latest text-judge result from signal_snapshots if present
  // (the M4 text-judge writes per-app rows; v1 reads them through
  // signal_snapshots once a future Task wires that bridge). For v1 we
  // accept null when no row exists; the composer's N≥3 rule handles it.
  const locGapValue = readLatestLocGapFromSignals(input.db, input.source_app_id, now);
  if (locGapValue !== null) {
    signal_values.locGap = locGapValue;
  }

  // ─── 3. mechanic_evidence (text-only, no score) ────────────────────
  let mechanicEvidence: string | null = null;
  if (
    !dryRun &&
    input.brief?.visionClient &&
    input.brief?.fetchImage &&
    input.app &&
    input.app.screenshotUrls.length >= 3
  ) {
    try {
      const result = await generateMechanicEvidence(
        {
          appId: input.app.appId,
          name: input.app.name,
          description: input.app.description,
          screenshotUrls: input.app.screenshotUrls,
        },
        {
          client: input.brief.visionClient,
          fetchImage: input.brief.fetchImage,
          persist: { db: input.db, t: now },
        },
      );
      mechanicEvidence = result.evidence;
    } catch (e) {
      v1Logger.warn(
        { err: String(e), app_id: input.source_app_id },
        "runV1Pipeline: mechanic_evidence failed, continuing with null",
      );
    }
  }

  // ─── 4. Assemble SignalValues + score ──────────────────────────────
  const composer = computeOpportunityScore(signal_values);

  // ─── 5. Build Opportunity ──────────────────────────────────────────
  const opportunity: Opportunity = {
    id: randomUUID(),
    generated_at: new Date(now).toISOString(),
    source_app_id: input.source_app_id,
    source_market: input.source_market,
    target_market: input.target_market,
    category: input.category,
    signal_values,
    predicted: {
      validation_budget_usd: 500,
      ...(cpiLtvResult.estimate !== null
        ? {
            cpi_low: cpiLtvResult.estimate.cpi_low,
            cpi_high: cpiLtvResult.estimate.cpi_high,
            ltv_low: cpiLtvResult.estimate.ltv_low,
            ltv_high: cpiLtvResult.estimate.ltv_high,
          }
        : {}),
    },
    kill_metric: input.kill_metric,
    score: composer.score,
    eligible: composer.eligible,
    thesis:
      composer.eligible && composer.score !== null
        ? `Opportunity score ${composer.score.toFixed(2)}/10 for ${input.source_app_id} → ${input.target_market} (${input.category}). v1 pipeline assembled this thesis from ${Object.keys(signal_values).length} signals; the brief renderer will polish it via LLM when not in dry-run.`
        : `Opportunity ineligible (N<3 non-null signals). Source: ${input.source_app_id}; target: ${input.target_market}.`,
    evidence: [
      {
        url: `https://internal.local/${input.source_app_id}`,
        claim: "Internal v1 pipeline-built opportunity (no external citations).",
      },
    ],
    metadata: {
      signal_pipeline_version: SIGNAL_PIPELINE_VERSION,
      scoring_version: SCORING_VERSION,
      velocity_version: VELOCITY_VERSION,
      built_via: "runV1Pipeline",
      ...(mechanicEvidence !== null ? { mechanic_evidence: mechanicEvidence } : {}),
    },
  };

  // ─── 6. Render brief (LLM thesis or placeholder) ───────────────────
  const briefText = await renderBrief(opportunity, {
    dryRun,
    client: input.brief?.thesisClient,
    persist: dryRun ? undefined : { db: input.db, t: now },
  });
  // Replace the seed thesis with the LLM-polished version when not dry-run
  // (renderBrief returns a fully-formed prose paragraph; the seed lives in
  // the contract for offline replay / fallback).
  if (!dryRun) {
    const thesisParagraph = extractThesisParagraph(briefText);
    if (thesisParagraph !== null) {
      opportunity.thesis = thesisParagraph;
    }
  }

  // ─── 7. Persist to opportunities ───────────────────────────────────
  persistOpportunity(input.db, opportunity, now);

  return opportunity;
}

/**
 * Read the latest locGap value from signal_snapshots for the source app.
 * Returns null when no rows exist — the composer's N≥3 rule handles it
 * without coercing null to zero.
 */
function readLatestLocGapFromSignals(db: Database, app_id: string, t: number): number | null {
  const row = db
    .prepare<{ value: number | null }, [string, number]>(
      `SELECT value FROM signal_snapshots
       WHERE app_id = ? AND signal_name = 'locGap' AND t <= ?
       ORDER BY t DESC LIMIT 1`,
    )
    .get(app_id, t);
  return row?.value ?? null;
}

/**
 * Extract the thesis paragraph from a rendered brief. The brief format is
 * `**Thesis**\n<paragraph>\n\n**Signals**\n...`, so we slice between the
 * Thesis header and the next blank-line + ** marker.
 */
function extractThesisParagraph(brief: string): string | null {
  const match = /\*\*Thesis\*\*\n([\s\S]*?)\n\n\*\*/.exec(brief);
  return match?.[1]?.trim() ?? null;
}

function persistOpportunity(db: Database, opp: Opportunity, generated_at_ms: number): void {
  db.prepare(
    `INSERT INTO opportunities (
       id, generated_at, source_app_id, source_market, target_market, category,
       sig_loc_gap, sig_velocity, sig_incumbent_vuln, sig_cpi_ltv_proxy,
       pred_cpi_low, pred_cpi_high, pred_ltv_low, pred_ltv_high, pred_validation_budget,
       kill_metric_name, kill_metric_threshold, kill_metric_direction,
       outcome_measured_at, outcome_metric_value, outcome_label, outcome_revenue_proven,
       score, eligible, thesis, evidence_json, metadata_json,
       signal_pipeline_version, scoring_version
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?
     )`,
  ).run(
    opp.id,
    generated_at_ms,
    opp.source_app_id,
    opp.source_market,
    opp.target_market,
    opp.category,
    opp.signal_values.locGap ?? null,
    opp.signal_values.velocity ?? null,
    opp.signal_values.incumbent_vulnerability ?? null,
    opp.signal_values.cpi_ltv_proxy ?? null,
    opp.predicted.cpi_low ?? null,
    opp.predicted.cpi_high ?? null,
    opp.predicted.ltv_low ?? null,
    opp.predicted.ltv_high ?? null,
    opp.predicted.validation_budget_usd ?? null,
    opp.kill_metric.metric,
    opp.kill_metric.threshold,
    opp.kill_metric.direction,
    null, // outcome_measured_at — populated post-validation
    null,
    null,
    null,
    opp.score,
    opp.eligible ? 1 : 0,
    opp.thesis,
    JSON.stringify(opp.evidence),
    JSON.stringify(opp.metadata),
    SIGNAL_PIPELINE_VERSION,
    SCORING_VERSION,
  );
}
