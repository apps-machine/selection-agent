import type { Cache } from "../storage/cache.ts";
import type { Store } from "../types/raw-app-data.ts";
import type { RateLimiter } from "../util/rate-limit.ts";
import { type ResilientCache, resilient } from "../util/resilient.ts";

export interface ReviewSnippet {
  appId: string;
  market: string;
  store: Store;
  author: string;
  rating: number;
  text: string;
  postedAt: string | null;
}

export interface ReviewScraperLib {
  fetchReviews(opts: {
    store: Store;
    market: string;
    appId: string;
    page?: number;
  }): Promise<unknown[]>;
}

import { buildCacheKey } from "../storage/cache-key.ts";

function reviewCacheKey(store: Store, market: string, appId: string, page: number): string {
  return buildCacheKey("reviews", store, market.toLowerCase(), appId, `p${page}`);
}

function normalizeReview(raw: unknown, store: Store, market: string, appId: string): ReviewSnippet {
  const o = raw as Record<string, unknown>;
  return {
    appId,
    market,
    store,
    author:
      typeof o.userName === "string"
        ? o.userName
        : typeof o.author === "string"
          ? o.author
          : "anonymous",
    rating: typeof o.score === "number" ? o.score : typeof o.rating === "number" ? o.rating : 0,
    text: typeof o.text === "string" ? o.text : typeof o.title === "string" ? o.title : "",
    postedAt:
      typeof o.date === "string" ? o.date : typeof o.updated === "string" ? o.updated : null,
  };
}

export interface ReviewScrapeOptions {
  cache: Cache;
  cacheTtlSeconds: number;
  client: ReviewScraperLib;
  fallback?: ReviewScraperLib;
  /** Optional global rate limiter (shared with chart-scraper / app-scraper). */
  rateLimiter?: RateLimiter;
  logger?: (level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>) => void;
}

function rateLimited<T>(
  rl: RateLimiter | undefined,
  host: string,
  fn: () => Promise<T>,
): () => Promise<T> {
  if (!rl) return fn;
  return () => rl.withLimit(host, fn);
}

export async function scrapeReviewPage(
  store: Store,
  market: string,
  appId: string,
  page: number,
  opts: ReviewScrapeOptions,
): Promise<ReviewSnippet[]> {
  const key = reviewCacheKey(store, market, appId, page);
  const cache: ResilientCache<unknown[]> = {
    get: () => opts.cache.get<unknown[]>(key),
    getStale: () => {
      const e = opts.cache.getStale<unknown[]>(key);
      return e ? { value: e.value, createdAt: e.createdAt } : null;
    },
    put: (value) => opts.cache.put(key, value, opts.cacheTtlSeconds),
  };
  const out = await resilient<unknown[]>(
    {
      primary: rateLimited(opts.rateLimiter, store, () =>
        opts.client.fetchReviews({ store, market, appId, page }),
      ),
      fallback: opts.fallback
        ? rateLimited(opts.rateLimiter, store, () =>
            opts.fallback!.fetchReviews({ store, market, appId, page }),
          )
        : undefined,
      cache,
    },
    { logger: opts.logger },
  );
  return out.value.map((raw) => normalizeReview(raw, store, market, appId));
}
