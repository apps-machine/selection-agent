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
import { type ChartScrapeJob, scrapeCharts } from "../scrapers/chart-scraper.ts";
import type { Cache } from "../storage/cache.ts";
import type { RawAppData, Store } from "../types/raw-app-data.ts";
import { getVelocityScore } from "../velocity/delta.ts";
import { type WriteSnapshotResult, writeSnapshot } from "../velocity/snapshot.ts";
import type { FailedSlice, ScanResult, ScoredCandidate } from "./types.ts";

export const PHASE_0_MARKETS = ["us", "jp", "de", "fr", "br", "es"] as const;
const PHASE_0_STORES: readonly Store[] = ["apple", "google"];
const SCRAPE_CACHE_TTL_SECONDS = 60 * 60;
const MARKET_CONCURRENCY = 6;

export interface ScanInput {
  cache: Cache;
  markets?: readonly string[];
  stores?: readonly Store[];
  topN?: number;
  noLlm?: boolean;
  scrapers: { apple: ScraperLib; google: ScraperLib };
  /** Required when `noLlm` is false. May be a stub when noLlm is true. */
  textClient: JudgeClient;
  visionClient: VisionJudgeClient;
  fetchImage: ImageFetcher;
  budget?: CostBudget;
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
 * parallel, write the M5 snapshot, compute heuristic + judge scores,
 * and rank the survivors.
 *
 * One blocked slice never kills the run — `Promise.allSettled` (inside
 * `scrapeCharts`) keeps the rest moving and the failed slice is
 * reported in `failedSlices`. The M5 snapshot write runs even when
 * judges fail, so Track B keeps accumulating during an LLM outage.
 */
export async function runScan(input: ScanInput): Promise<ScanResult> {
  const markets = (input.markets ?? PHASE_0_MARKETS).slice();
  const stores = (input.stores ?? PHASE_0_STORES).slice();
  const topN = input.topN ?? 30;
  const noLlm = input.noLlm ?? false;
  const now = (input.now ?? Date.now)();
  const runId = makeRunId(input.runIdSeed, now);
  const generatedAt = new Date(now).toISOString();
  const budget = input.budget ?? new CostBudget();
  const textModel = input.textModel ?? DEFAULT_TEXT_JUDGE_MODEL;
  const visionModel = input.visionModel ?? DEFAULT_VISION_JUDGE_MODEL;

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
  });

  const failedSlices: FailedSlice[] = chartReport.failures.map((f) => ({
    store: f.job.store,
    market: f.job.market,
    reason: f.error.message,
  }));

  const allApps: RawAppData[] = [];
  const rankByKey = new Map<string, number>();
  for (const outcome of chartReport.outcomes) {
    for (const app of outcome.apps) {
      allApps.push(app);
      if (app.rank !== null) {
        rankByKey.set(`${app.store}:${app.appId}:${app.market}`, app.rank);
      }
    }
  }

  // 2. Snapshot side-effect — runs even if judges fail later.
  let snapshotResult: WriteSnapshotResult;
  try {
    snapshotResult = writeSnapshot({
      apps: allApps,
      cache: input.cache,
      rankByKey,
      now: () => now,
    });
  } catch (e) {
    logger.warn(
      { err: (e as Error).message },
      "writeSnapshot threw — continuing without snapshot side-effect",
    );
    snapshotResult = { written: 0, skipped: 0, day: new Date(now).toISOString().slice(0, 10) };
  }

  // 3. Per-app: velocity + judges, then composite.
  const onTokenUsage = (usage: TokenUsage): void => {
    budget.recordAndAssert(usage);
  };

  const judgeResults: JudgeResult[] = [];
  const judgeStore = input.cache.judgeResultStore();
  const scored: ScoredCandidate[] = [];

  for (const app of allApps) {
    const velocity = getVelocityScore({
      cache: input.cache,
      store: app.store,
      appId: app.appId,
      market: app.market,
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
    scored.push({ app, composite, textJudge, visionJudge });
  }

  const ranked = rank(scored, topN);

  return {
    runId,
    generatedAt,
    markets,
    appsScanned: allApps.length,
    costUsd: budget.spentUsd(),
    candidates: ranked,
    judgeResults,
    snapshotResult,
    failedSlices,
  };
}
