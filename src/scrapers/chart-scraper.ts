import { Cache } from "../storage/cache.ts";
import type { RawAppData, Store } from "../types/raw-app-data.ts";
import { mapWithConcurrency } from "../util/concurrent.ts";
import type { RateLimiter } from "../util/rate-limit.ts";
import { resilient, type ResilientCache } from "../util/resilient.ts";
import type { ChartEntry, Collection, ScraperLib } from "./api.ts";
import { mapToRawAppData } from "./api.ts";

export interface ChartScrapeJob {
  store: Store;
  market: string;
  collection: Collection;
  limit: number;
}

export interface ChartScrapeOptions {
  cache: Cache;
  cacheTtlSeconds: number;
  clients: { apple: ScraperLib; google: ScraperLib };
  concurrency?: number;
  fallbacks?: { apple?: ScraperLib; google?: ScraperLib };
  /**
   * Optional global rate limiter. Wraps every scraper call (primary + fallback)
   * so charts + apps + reviews scrapers share one bucket per host. Without it,
   * concurrency=6 (charts) + concurrency=8 (apps) can fire 14 calls at the same
   * host and trip Akamai/Google rate limits.
   */
  rateLimiter?: RateLimiter;
  logger?: (
    level: "info" | "warn" | "error",
    msg: string,
    ctx?: Record<string, unknown>,
  ) => void;
  scrapedAt?: () => string;
}

export interface ChartScrapeOutcome {
  job: ChartScrapeJob;
  apps: RawAppData[];
  source: "primary" | "fallback" | "cache-fresh" | "cache-stale";
  staleAgeMs?: number;
}

export interface ChartScrapeReport {
  outcomes: ChartScrapeOutcome[];
  failures: Array<{ job: ChartScrapeJob; error: Error }>;
}

import { buildCacheKey } from "../storage/cache-key.ts";

function chartCacheKey(job: ChartScrapeJob): string {
  return buildCacheKey(
    "chart",
    job.store,
    job.market.toLowerCase(),
    job.collection,
    job.limit,
  );
}

function cacheAdapter(
  cache: Cache,
  key: string,
  ttlSeconds: number,
): ResilientCache<ChartEntry[]> {
  return {
    get: () => cache.get<ChartEntry[]>(key),
    getStale: () => {
      const entry = cache.getStale<ChartEntry[]>(key);
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

export async function scrapeCharts(
  jobs: readonly ChartScrapeJob[],
  opts: ChartScrapeOptions,
): Promise<ChartScrapeReport> {
  const concurrency = opts.concurrency ?? 6;
  const scrapedAt = opts.scrapedAt ?? (() => new Date().toISOString());

  const { results } = await mapWithConcurrency(jobs, concurrency, async (job) => {
    const client = opts.clients[job.store];
    const fallback = opts.fallbacks?.[job.store];
    const key = chartCacheKey(job);
    const adapter = cacheAdapter(opts.cache, key, opts.cacheTtlSeconds);
    const host = job.store; // "apple" | "google" — bucket scope
    const out = await resilient<ChartEntry[]>(
      {
        primary: rateLimited(opts.rateLimiter, host, () => client.fetchChart(job)),
        fallback: fallback
          ? rateLimited(opts.rateLimiter, host, () => fallback.fetchChart(job))
          : undefined,
        cache: adapter,
      },
      { logger: opts.logger },
    );
    const apps = out.value.map((entry, i) =>
      mapToRawAppData({
        store: job.store,
        market: job.market,
        rank: i + 1,
        entry,
        scrapedAtIso: scrapedAt(),
      }),
    );
    return {
      job,
      apps,
      source: out.source,
      staleAgeMs: out.staleAgeMs,
    } satisfies ChartScrapeOutcome;
  });

  const outcomes: ChartScrapeOutcome[] = [];
  const failures: Array<{ job: ChartScrapeJob; error: Error }> = [];
  results.forEach((r, i) => {
    const job = jobs[i]!;
    if (r?.ok) outcomes.push(r.value);
    else if (r) failures.push({ job, error: r.error });
  });
  return { outcomes, failures };
}
