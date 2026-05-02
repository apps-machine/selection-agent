/**
 * Wayback CDX storefront landing fetch — DEMOTED to optional enrichment.
 *
 * Per docs/planning/agent-v1-day1-audit.md, Wayback's crawler does NOT
 * follow links into individual app pages on tier-2 SEA storefronts (zero
 * captures across 3 markets × 3 years probed). 42matters is the primary
 * historical metadata source instead (see ./42matters-client.ts).
 *
 * What this module IS for:
 *   - Storefront landing-page snapshots (e.g., apps.apple.com/id/app or
 *     play.google.com/store/apps?country=ID at a historical t).
 *   - Best-effort enrichment when 42matters extraction misses something.
 *   - NOT load-bearing for v1 backtest. The whole module returns null
 *     gracefully when no snapshot is available, and the rest of the
 *     pipeline keeps going.
 *
 * Pattern: wraps fetch with `withExpBackoff(withCircuitBreaker(...))` from
 * src/util/rate-limit.ts. The persisted queue (also from rate-limit.ts)
 * is exposed so callers can enqueue (market, t) pairs and resume after
 * crash — though for the demoted use case, in-memory iteration is usually
 * fine.
 *
 * 429 handling: the rate-limit wrappers handle retry; if the breaker opens
 * we throw CircuitOpenError up to the caller (don't return null — circuit
 * open means "stop trying for now," distinct from "this snapshot doesn't
 * exist").
 *
 * Snapshot missing (404 from Wayback CDX): returns null. Fall-through
 * gracefully — the brief still renders, just without the wayback evidence.
 */

import pino from "pino";
import {
  type CircuitBreakerOptions,
  type ExpBackoffOptions,
  withCircuitBreaker,
  withExpBackoff,
} from "../util/rate-limit.ts";

const logger = pino({
  name: "wayback-fetch",
  level: process.env.LOG_LEVEL ?? "info",
});

export const WAYBACK_CDX_BASE_URL = "https://web.archive.org/cdx/search/cdx";
export const WAYBACK_SNAPSHOT_BASE_URL = "https://web.archive.org/web";

/** Wayback's published rate limit: 15 req/min ≈ 1 req per 4s. */
export const WAYBACK_DEFAULT_BASE_DELAY_MS = 4_000;

/**
 * Per the Wayback documentation, 5 consecutive 429s is the de facto cliff:
 * once you've been throttled five times in a row, archive.org's edge will
 * blocklist for several minutes. Open the breaker before then.
 */
export const WAYBACK_DEFAULT_BREAKER_THRESHOLD = 5;
export const WAYBACK_DEFAULT_HALF_OPEN_MS = 60_000;

export interface FetchStorefrontSnapshotOptions {
  /** Override fetch (for tests). */
  fetch?: typeof fetch;
  /** Override sleep used by exp backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Override clock used by circuit breaker. */
  clock?: () => number;
  /** Override base delay (default 4s; Wayback's 15/min == 1/4s). */
  expBackoff?: Partial<ExpBackoffOptions>;
  /** Override circuit-breaker options. */
  circuit?: Partial<CircuitBreakerOptions>;
}

export interface StorefrontSnapshot {
  /** Raw HTML body. */
  html: string;
  /** Snapshot capture timestamp (unix ms) per CDX. */
  captured_at: number;
  /** Wayback canonical URL the snapshot came from. */
  snapshot_url: string;
}

interface CdxEntry {
  /** Wayback "timestamp" string YYYYMMDDhhmmss. */
  timestamp: string;
  /** Original URL. */
  original: string;
  /** HTTP status of the captured snapshot. */
  status_code: string;
}

/**
 * Build the storefront landing URL for a given market.
 *
 * V1 only targets Apple's storefronts because Google Play country routing
 * is identity-bound (every country variant resolves to the same canonical
 * page from Wayback's perspective; you'd need cookies). Returning null for
 * unsupported markets lets fetchStorefrontSnapshot short-circuit cleanly.
 */
export function storefrontLandingUrl(market: string): string | null {
  const m = market.toLowerCase();
  // Tier-2 SEA + tier-1 anchor markets per the v1 OpportunityMarket enum.
  const supported = new Set([
    "us",
    "id",
    "vn",
    "th",
    "my",
    "ph",
    "bd",
    "br",
    "es",
    "de",
    "fr",
    "jp",
  ]);
  if (!supported.has(m)) return null;
  return `https://apps.apple.com/${m}/charts`;
}

/**
 * Fetch a storefront landing snapshot for `market` closest to time `t`.
 *
 * Returns null when Wayback has no snapshot for the URL within the
 * requested time. Throws CircuitOpenError when the breaker has tripped.
 * All other transient errors (429s, transient 5xx) are absorbed by exp
 * backoff up to maxAttempts.
 */
export async function fetchStorefrontSnapshot(
  market: string,
  t: number,
  opts: FetchStorefrontSnapshotOptions = {},
): Promise<StorefrontSnapshot | null> {
  const maybeUrl = storefrontLandingUrl(market);
  if (maybeUrl === null) {
    logger.debug({ market }, "wayback-fetch: market not in storefront support list");
    return null;
  }
  const url: string = maybeUrl;

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep;
  const clock = opts.clock;

  const expBackoffOpts: ExpBackoffOptions = {
    maxAttempts: opts.expBackoff?.maxAttempts ?? 3,
    baseDelayMs: opts.expBackoff?.baseDelayMs ?? WAYBACK_DEFAULT_BASE_DELAY_MS,
    sleep,
  };
  const circuitOpts: CircuitBreakerOptions = {
    threshold: opts.circuit?.threshold ?? WAYBACK_DEFAULT_BREAKER_THRESHOLD,
    halfOpenAfterMs: opts.circuit?.halfOpenAfterMs ?? WAYBACK_DEFAULT_HALF_OPEN_MS,
    clock,
  };

  // Compose: circuit -> backoff -> raw call. Outer-most wrapper runs first
  // so the breaker can short-circuit BEFORE backoff burns time on a
  // known-down upstream.
  async function rawCall(): Promise<{ status: number; text: string }> {
    const r = await fetchImpl(buildCdxUrl(url, t));
    const text = await r.text();
    if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
      throw new Error(`wayback CDX ${r.status}`);
    }
    return { status: r.status, text };
  }
  const guarded = withCircuitBreaker(withExpBackoff(rawCall, expBackoffOpts), circuitOpts);

  // CDX call: returns the closest snapshot's metadata (or empty).
  const cdxResp = await guarded();
  if (cdxResp.status === 404) {
    logger.info({ market, t }, "wayback-fetch: no CDX entries");
    return null;
  }
  const entry = parseClosestCdx(cdxResp.text, t);
  if (entry === null) {
    return null;
  }

  // Build snapshot URL and fetch the HTML. Same wrapper composition.
  const snapshotUrl = `${WAYBACK_SNAPSHOT_BASE_URL}/${entry.timestamp}/${entry.original}`;
  async function rawHtml(): Promise<{ status: number; text: string }> {
    const r = await fetchImpl(snapshotUrl);
    const text = await r.text();
    if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
      throw new Error(`wayback snapshot ${r.status}`);
    }
    return { status: r.status, text };
  }
  const guardedHtml = withCircuitBreaker(withExpBackoff(rawHtml, expBackoffOpts), circuitOpts);

  const htmlResp = await guardedHtml();
  if (htmlResp.status === 404) {
    return null;
  }

  return {
    html: htmlResp.text,
    captured_at: parseWaybackTimestamp(entry.timestamp),
    snapshot_url: snapshotUrl,
  };
}

function buildCdxUrl(url: string, t: number): string {
  const date = new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
  // Use the JSON output for easy parsing.
  return (
    `${WAYBACK_CDX_BASE_URL}?url=${encodeURIComponent(url)}` +
    `&output=json&limit=1&closest=${date}&filter=statuscode:200`
  );
}

/**
 * Parse Wayback CDX JSON: array-of-arrays format. First row is the header
 * (["urlkey", "timestamp", "original", ...]); subsequent rows are entries.
 * Returns null if no entries found or the JSON shape is unexpected.
 *
 * NOTE: we don't currently use `t` to pick the closest entry — we ask the
 * CDX API to return a single closest entry via &limit=1. The arg is
 * preserved for future expansion (e.g., requesting multiple candidates
 * and picking the actual closest by absolute time delta).
 */
export function parseClosestCdx(json: string, _t: number): CdxEntry | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 2) return null;
    const header = parsed[0] as string[];
    const tsIdx = header.indexOf("timestamp");
    const origIdx = header.indexOf("original");
    const statusIdx = header.indexOf("statuscode");
    if (tsIdx < 0 || origIdx < 0) return null;
    const row = parsed[1] as string[];
    const timestamp = row[tsIdx];
    const original = row[origIdx];
    if (timestamp === undefined || original === undefined) return null;
    const statusCode = statusIdx >= 0 ? row[statusIdx] : undefined;
    return {
      timestamp,
      original,
      status_code: statusCode ?? "200",
    };
  } catch {
    return null;
  }
}

/** "20240115123045" → unix ms. */
export function parseWaybackTimestamp(ts: string): number {
  if (ts.length < 8) return 0;
  const year = ts.slice(0, 4);
  const month = ts.slice(4, 6);
  const day = ts.slice(6, 8);
  const hour = ts.slice(8, 10) || "00";
  const min = ts.slice(10, 12) || "00";
  const sec = ts.slice(12, 14) || "00";
  return Date.parse(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`);
}
