import type { Cache } from "../storage/cache.ts";
import type { RawAppData, Store } from "../types/raw-app-data.ts";
import { mapWithConcurrency } from "../util/concurrent.ts";
import type { RateLimiter } from "../util/rate-limit.ts";
import { type ResilientCache, resilient } from "../util/resilient.ts";
import type { AppDetails, ScraperLib } from "./api.ts";
import { mapToRawAppData } from "./api.ts";

export interface AppScrapeJob {
  store: Store;
  market: string;
  appId: string;
  rank?: number | null;
}

export interface AppScrapeOptions {
  cache: Cache;
  cacheTtlSeconds: number;
  clients: { apple: ScraperLib; google: ScraperLib };
  concurrency?: number;
  fallbacks?: { apple?: ScraperLib; google?: ScraperLib };
  /** Optional global rate limiter (shared with chart-scraper / review-scraper). */
  rateLimiter?: RateLimiter;
  logger?: (level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>) => void;
  scrapedAt?: () => string;
}

export interface AppScrapeOutcome {
  job: AppScrapeJob;
  app: RawAppData;
  source: "primary" | "fallback" | "cache-fresh" | "cache-stale";
}

import { buildCacheKey } from "../storage/cache-key.ts";

function appCacheKey(job: AppScrapeJob): string {
  return buildCacheKey("app", job.store, job.market.toLowerCase(), job.appId);
}

function cacheAdapter(cache: Cache, key: string, ttlSeconds: number): ResilientCache<AppDetails> {
  return {
    get: () => cache.get<AppDetails>(key),
    getStale: () => {
      const entry = cache.getStale<AppDetails>(key);
      return entry ? { value: entry.value, createdAt: entry.createdAt } : null;
    },
    put: (value) => cache.put(key, value, ttlSeconds),
  };
}

function rateLimited<T>(
  rl: RateLimiter | undefined,
  host: string,
  fn: () => Promise<T>,
): () => Promise<T> {
  if (!rl) return fn;
  return () => rl.withLimit(host, fn);
}

export async function scrapeApps(
  jobs: readonly AppScrapeJob[],
  opts: AppScrapeOptions,
): Promise<{
  outcomes: AppScrapeOutcome[];
  failures: Array<{ job: AppScrapeJob; error: Error }>;
}> {
  const concurrency = opts.concurrency ?? 8;
  const scrapedAt = opts.scrapedAt ?? (() => new Date().toISOString());

  const { results } = await mapWithConcurrency(jobs, concurrency, async (job) => {
    const client = opts.clients[job.store];
    const fallback = opts.fallbacks?.[job.store];
    const adapter = cacheAdapter(opts.cache, appCacheKey(job), opts.cacheTtlSeconds);
    const host = job.store;
    const out = await resilient<AppDetails>(
      {
        primary: rateLimited(opts.rateLimiter, host, () =>
          client.fetchApp({
            store: job.store,
            market: job.market,
            appId: job.appId,
          }),
        ),
        fallback: fallback
          ? rateLimited(opts.rateLimiter, host, () =>
              fallback.fetchApp({
                store: job.store,
                market: job.market,
                appId: job.appId,
              }),
            )
          : undefined,
        cache: adapter,
      },
      { logger: opts.logger },
    );
    const app = mapToRawAppData({
      store: job.store,
      market: job.market,
      rank: job.rank ?? null,
      entry: out.value,
      scrapedAtIso: scrapedAt(),
    });
    return { job, app, source: out.source } satisfies AppScrapeOutcome;
  });

  const outcomes: AppScrapeOutcome[] = [];
  const failures: Array<{ job: AppScrapeJob; error: Error }> = [];
  results.forEach((r, i) => {
    const job = jobs[i]!;
    if (r?.ok) outcomes.push(r.value);
    else if (r) failures.push({ job, error: r.error });
  });
  return { outcomes, failures };
}
