import { isTransientHttpError, retryWithBackoff, type RetryOptions } from "./retry.ts";

export type ResilientSource =
  | "primary"
  | "fallback"
  | "cache-fresh"
  | "cache-stale";

export interface ResilientResult<T> {
  value: T;
  source: ResilientSource;
  /** Age in ms since the cache entry was created (only set for cache-stale). */
  staleAgeMs?: number;
  /** Errors collected from the primary/fallback tiers (in order). */
  errors: Error[];
}

export interface ResilientCache<T> {
  get(): T | null;
  getStale(): { value: T; createdAt: number } | null;
  put(value: T): void;
}

export interface ResilientTiers<T> {
  primary: () => Promise<T>;
  /** Optional secondary scraper (e.g., Playwright fallback for Apple Akamai blocks). */
  fallback?: () => Promise<T>;
  cache: ResilientCache<T>;
}

export interface ResilientOptions {
  retry?: RetryOptions;
  logger?: (
    level: "info" | "warn" | "error",
    msg: string,
    ctx?: Record<string, unknown>,
  ) => void;
  clock?: () => number;
}

const noopLogger: NonNullable<ResilientOptions["logger"]> = () => {};

/**
 * 3-tier resilience pattern: cache (fresh) → primary lib → fallback → cache (stale).
 *
 * - Returns immediately if the cache has a fresh entry.
 * - Otherwise calls primary with exponential backoff. Caches on success.
 * - If primary exhausts retries, calls fallback (if provided). Caches on success.
 * - If both fail and a stale cache exists, returns it with a warning.
 * - If everything fails, throws the last collected error.
 */
export async function resilient<T>(
  tiers: ResilientTiers<T>,
  opts: ResilientOptions = {},
): Promise<ResilientResult<T>> {
  const log = opts.logger ?? noopLogger;
  const clock = opts.clock ?? Date.now;
  const errors: Error[] = [];

  const cached = tiers.cache.get();
  if (cached !== null) {
    return { value: cached, source: "cache-fresh", errors };
  }

  try {
    const value = await retryWithBackoff(tiers.primary, {
      shouldRetry: isTransientHttpError,
      ...opts.retry,
    });
    tiers.cache.put(value);
    return { value, source: "primary", errors };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    errors.push(err);
    log("warn", "primary tier failed", { error: err.message });
  }

  if (tiers.fallback) {
    try {
      const value = await tiers.fallback();
      tiers.cache.put(value);
      return { value, source: "fallback", errors };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      errors.push(err);
      log("warn", "fallback tier failed", { error: err.message });
    }
  }

  const stale = tiers.cache.getStale();
  if (stale) {
    const ageMs = clock() - stale.createdAt;
    log("warn", "all tiers failed; serving stale cache", {
      staleAgeMs: ageMs,
      errors: errors.map((e) => e.message),
    });
    return {
      value: stale.value,
      source: "cache-stale",
      staleAgeMs: ageMs,
      errors,
    };
  }

  const last = errors[errors.length - 1] ?? new Error("resilient: all tiers failed");
  throw last;
}
