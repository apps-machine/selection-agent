/**
 * 42matters API client — primary historical metadata source for v1.
 *
 * Per docs/planning/agent-v1-foundation.md (revised 2026-05-02 post Day-1
 * audit), 42matters replaces Wayback as the primary historical metadata
 * source. Wayback is demoted to optional storefront-landing enrichment
 * because the Wayback crawler doesn't follow links into individual app
 * pages on tier-2 SEA storefronts (zero captures across 3 markets × 3
 * years, see agent-v1-day1-audit.md).
 *
 * 42matters offers a 14-day commercial trial. The trial signup is GATED
 * to user authorization — the client builds a skeleton with mocked tests
 * (no live API calls) here. Real API key activation is at integration
 * time, NOT in this module's tests. We READ the key from the
 * `FORTYTWO_MATTERS_API_KEY` env var; if unset, the client throws a clear
 * error pointing to docs/planning/agent-v1-foundation.md.
 *
 * Trial-window awareness: each call logs `days_remaining` from the
 * configured `trialExpiresAt`. When days_remaining < 5 the log level is
 * elevated to warn (extraction sprint must complete before expiry).
 *
 * The bulkExtractCohort function is the extraction-sprint pattern:
 * fetches metadata + reviews + ranks for an entire cohort, persists to
 * `app_metadata_snapshots` and `signal_snapshots` (LLM provenance NULL
 * since these are deterministic API responses), and returns extraction
 * stats. Idempotent on storage primary keys — re-running the same cohort
 * is safe (no duplicate-row errors).
 *
 * The interface `FortyTwoMattersClient` mirrors the abstraction used by
 * `appgoblin-import.ts` so v2 can swap implementations (e.g., a polite
 * long-tail crawler) without touching the rest of the ground-truth pipeline.
 */

import type { Database } from "bun:sqlite";
import pino from "pino";

const logger = pino({
  name: "42matters-client",
  level: process.env.LOG_LEVEL ?? "info",
});

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_WARN_THRESHOLD_DAYS = 5;

const DOCS_URL = "docs/planning/agent-v1-foundation.md";
const ENV_VAR_NAME = "FORTYTWO_MATTERS_API_KEY";

/** Default base URL — overridable for tests. */
export const FORTYTWO_MATTERS_BASE_URL = "https://data.42matters.com";

export interface AppMetadata {
  app_id: string;
  market: string;
  /** Snapshot timestamp — unix milliseconds. */
  captured_at: number;
  /** Display name at this t. */
  name: string;
  /** Developer / publisher at this t. */
  developer: string | null;
  /** App-store category at this t. */
  category: string | null;
  /** Description (full text). */
  description: string | null;
  /** Average review score 0-5. */
  rating: number | null;
  /** Total review count. */
  ratings_count: number | null;
  /** Whether IAP is offered. */
  iap_present: boolean | null;
  /** Localized icon URL. */
  icon_url: string | null;
  /** Last app-bundle update date (ISO 8601 string) per the store. */
  last_updated: string | null;
}

export interface Review {
  app_id: string;
  market: string;
  review_id: string;
  /** Reviewer-supplied rating 1-5. */
  rating: number;
  /** Submission date (ISO 8601). */
  posted_at: string;
  body: string;
}

export interface Rank {
  app_id: string;
  market: string;
  /** Apple/Google chart key (e.g., "top-grossing", "top-free"). */
  chart: string;
  /** Store category (e.g., "productivity"). */
  category: string;
  /** Snapshot timestamp — unix milliseconds. */
  captured_at: number;
  rank: number;
}

export interface FortyTwoMattersClient {
  /**
   * Fetch metadata for a specific app at a specific market and time.
   * Returns null if 42matters has no record at that t.
   */
  fetchAppMetadata(app_id: string, market: string, t: number): Promise<AppMetadata | null>;
  /**
   * Fetch reviews for an app since `since_t`. Returns array (possibly empty).
   * Caller is responsible for paginating; the client returns all pages
   * concatenated. The 14-day trial limits total request volume — bulk
   * callers should use bulkExtractCohort which batches calls.
   */
  fetchAppReviews(app_id: string, market: string, since: number): Promise<Review[]>;
  /**
   * Fetch historical chart ranks for an app over [from, to].
   */
  fetchHistoricalRanks(app_id: string, market: string, from: number, to: number): Promise<Rank[]>;
}

export interface CreateClientOptions {
  /** API key. If undefined, falls back to env var; if neither, throws. */
  apiKey?: string;
  /**
   * Trial expiration timestamp in unix milliseconds. Used to log
   * days_remaining warnings on each API call. Optional — when not set, the
   * client doesn't surface trial expiry warnings (assumes commercial license).
   */
  trialExpiresAt?: number;
  /** Override base URL for tests. */
  baseUrl?: string;
  /** Override fetch for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Override clock for tests. Defaults to Date.now. */
  clock?: () => number;
}

/**
 * Construct a 42matters client. Reads API key from `apiKey` opt or the
 * `FORTYTWO_MATTERS_API_KEY` env var. Throws a clear error pointing to
 * `docs/planning/agent-v1-foundation.md` if neither is set.
 *
 * Tests inject `fetch` and `clock` to bypass the real API; production code
 * relies on globalThis.fetch.
 */
export function createClient(opts: CreateClientOptions = {}): FortyTwoMattersClient {
  const apiKey = opts.apiKey ?? process.env[ENV_VAR_NAME];
  if (!apiKey) {
    throw new Error(
      `42matters client: API key not set. Either pass opts.apiKey or set ${ENV_VAR_NAME}. ` +
        `Trial signup is gated — see ${DOCS_URL} for details.`,
    );
  }

  const baseUrl = opts.baseUrl ?? FORTYTWO_MATTERS_BASE_URL;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const clock = opts.clock ?? Date.now;

  function logTrialState(): void {
    if (opts.trialExpiresAt === undefined) return;
    const remainingMs = opts.trialExpiresAt - clock();
    const remainingDays = Math.floor(remainingMs / DAY_MS);
    if (remainingDays < 0) {
      logger.error({ remainingDays }, "42matters trial EXPIRED — extraction will fail");
    } else if (remainingDays < TRIAL_WARN_THRESHOLD_DAYS) {
      logger.warn(
        { remainingDays },
        "42matters trial expiring soon — finalize extraction before window closes",
      );
    } else {
      logger.debug({ remainingDays }, "42matters trial days remaining");
    }
  }

  async function callApi<T>(path: string, params: Record<string, string>): Promise<T> {
    logTrialState();
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    // 42matters uses a Bearer token in the Authorization header (per their
    // public docs, https://42matters.com/docs/app-market-data-api). Tests
    // assert this header is set.
    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`42matters API ${response.status}: ${path}`);
    }
    return (await response.json()) as T;
  }

  return {
    async fetchAppMetadata(app_id, market, t) {
      // 42matters historical-app endpoint returns the snapshot closest to
      // `date` (ISO YYYY-MM-DD). We round our unix-ms `t` to the calendar day.
      const date = new Date(t).toISOString().slice(0, 10);
      try {
        const raw = await callApi<{ app: Record<string, unknown> } | null>(
          "/v3.0/apps/lookup_history.json",
          { app_id, market, date },
        );
        if (!raw?.app) return null;
        return parseMetadata(raw.app, app_id, market, t);
      } catch (e) {
        // 404 means "no snapshot at that t" — return null, don't throw.
        if (e instanceof Error && /404/.test(e.message)) return null;
        throw e;
      }
    },

    async fetchAppReviews(app_id, market, since) {
      const sinceDate = new Date(since).toISOString();
      const raw = await callApi<{ reviews?: Array<Record<string, unknown>> }>(
        "/v3.0/apps/reviews.json",
        { app_id, market, since: sinceDate },
      );
      if (!raw.reviews) return [];
      return raw.reviews.map((r) => parseReview(r, app_id, market));
    },

    async fetchHistoricalRanks(app_id, market, from, to) {
      const fromDate = new Date(from).toISOString().slice(0, 10);
      const toDate = new Date(to).toISOString().slice(0, 10);
      const raw = await callApi<{ ranks?: Array<Record<string, unknown>> }>(
        "/v3.0/apps/rankings_history.json",
        { app_id, market, from: fromDate, to: toDate },
      );
      if (!raw.ranks) return [];
      return raw.ranks.map((r) => parseRank(r, app_id, market));
    },
  };
}

function parseMetadata(
  raw: Record<string, unknown>,
  app_id: string,
  market: string,
  t: number,
): AppMetadata {
  return {
    app_id,
    market,
    captured_at: t,
    name: typeof raw.title === "string" ? raw.title : "",
    developer: typeof raw.developer === "string" ? raw.developer : null,
    category: typeof raw.category === "string" ? raw.category : null,
    description: typeof raw.description === "string" ? raw.description : null,
    rating: typeof raw.rating === "number" ? raw.rating : null,
    ratings_count: typeof raw.ratings_count === "number" ? raw.ratings_count : null,
    iap_present: typeof raw.iap === "boolean" ? raw.iap : null,
    icon_url: typeof raw.icon === "string" ? raw.icon : null,
    last_updated: typeof raw.last_updated === "string" ? raw.last_updated : null,
  };
}

function parseReview(raw: Record<string, unknown>, app_id: string, market: string): Review {
  return {
    app_id,
    market,
    review_id: typeof raw.review_id === "string" ? raw.review_id : "",
    rating: typeof raw.rating === "number" ? raw.rating : 0,
    posted_at: typeof raw.posted_at === "string" ? raw.posted_at : "",
    body: typeof raw.body === "string" ? raw.body : "",
  };
}

function parseRank(raw: Record<string, unknown>, app_id: string, market: string): Rank {
  return {
    app_id,
    market,
    chart: typeof raw.chart === "string" ? raw.chart : "top-grossing",
    category: typeof raw.category === "string" ? raw.category : "all",
    captured_at: typeof raw.date === "string" ? Date.parse(raw.date) : 0,
    rank: typeof raw.rank === "number" ? raw.rank : 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// bulkExtractCohort — the extraction-sprint pattern
// ──────────────────────────────────────────────────────────────────────

export interface BulkExtractCohortInput {
  /** App IDs to extract for. */
  app_ids: readonly string[];
  /** Markets to extract for each app. */
  markets: readonly string[];
  /** Range of historical decision dates [from, to] in unix-ms. */
  t0_range: { from: number; to: number };
}

export interface ExtractionStats {
  /** Number of metadata snapshots persisted. */
  metadataRows: number;
  /** Number of review rows persisted. */
  reviewRows: number;
  /** Number of rank rows persisted. */
  rankRows: number;
  /** Number of (app, market, t) tuples that returned null/error. */
  errors: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/**
 * Bulk-extract a cohort. Iterates every (app, market, t) tuple in the
 * input range and persists results to bun:sqlite. Idempotent — re-running
 * the same cohort is safe because every row's PK is `(app_id, market,
 * captured_at, source)` and we use INSERT OR IGNORE.
 *
 * The function does NOT enforce a request-rate limit; callers are
 * responsible for wrapping the client with `withExpBackoff` /
 * `withCircuitBreaker` from `src/util/rate-limit.ts` if running near
 * 42matters' burst limits.
 *
 * On individual fetch failure, logs at warn and increments errors counter.
 * Does NOT throw — partial completion is acceptable since the trial window
 * is finite.
 */
export async function bulkExtractCohort(
  client: FortyTwoMattersClient,
  db: Database,
  cohort: BulkExtractCohortInput,
): Promise<ExtractionStats> {
  const startMs = Date.now();
  const stats: ExtractionStats = {
    metadataRows: 0,
    reviewRows: 0,
    rankRows: 0,
    errors: 0,
    durationMs: 0,
  };

  // We sample a small set of historical t0 dates from the range — picking
  // the endpoints + the midpoint. Three samples per app/market is enough
  // for v1 backtest; more would burn the trial quota.
  const samples = sampleT0Range(cohort.t0_range);

  // Insert OR IGNORE for idempotence. PK on app_metadata_snapshots is
  // (app_id, market, captured_at, source) so re-running the same cohort
  // doesn't error.
  const insertMetadata = db.prepare(
    `INSERT OR IGNORE INTO app_metadata_snapshots
     (app_id, market, captured_at, source, parsed_json)
     VALUES (?, ?, ?, '42matters', ?)`,
  );
  const insertChart = db.prepare(
    `INSERT OR IGNORE INTO chart_snapshots
     (market, category, captured_at, rank, app_id, source)
     VALUES (?, ?, ?, ?, ?, '42matters')`,
  );
  // Reviews aren't a dedicated v1 table; we persist the count delta as a
  // signal_snapshots row tagged 'review_count' so winner-score's review
  // growth path can read them. Per CLAUDE.md the LLM provenance columns
  // are NULL since this data is deterministic API output, not LLM-derived.
  const insertSignal = db.prepare(
    `INSERT OR IGNORE INTO signal_snapshots
     (app_id, signal_name, t, value, llm_model, llm_prompt_version,
      llm_request_hash, llm_response_hash, llm_response_archived,
      source_urls_json, computed_at)
     VALUES (?, 'review_count', ?, ?, NULL, '', NULL, NULL, NULL, NULL, ?)`,
  );

  for (const app_id of cohort.app_ids) {
    for (const market of cohort.markets) {
      for (const t of samples) {
        try {
          const meta = await client.fetchAppMetadata(app_id, market, t);
          if (meta !== null) {
            insertMetadata.run(app_id, market, t, JSON.stringify(meta));
            stats.metadataRows += 1;
          }
        } catch (e) {
          stats.errors += 1;
          logger.warn({ err: String(e), app_id, market, t }, "fetchAppMetadata error");
        }

        try {
          const reviews = await client.fetchAppReviews(app_id, market, t);
          if (reviews.length > 0) {
            // Persist as a single review_count signal at this t.
            insertSignal.run(app_id, t, reviews.length, Date.now());
            stats.reviewRows += reviews.length;
          }
        } catch (e) {
          stats.errors += 1;
          logger.warn({ err: String(e), app_id, market, t }, "fetchAppReviews error");
        }
      }

      // Ranks are pulled across the full t0_range once per (app, market).
      try {
        const ranks = await client.fetchHistoricalRanks(
          app_id,
          market,
          cohort.t0_range.from,
          cohort.t0_range.to,
        );
        for (const r of ranks) {
          insertChart.run(market, r.category, r.captured_at, r.rank, app_id);
          stats.rankRows += 1;
        }
      } catch (e) {
        stats.errors += 1;
        logger.warn({ err: String(e), app_id, market }, "fetchHistoricalRanks error");
      }
    }
  }

  stats.durationMs = Date.now() - startMs;
  return stats;
}

function sampleT0Range(range: { from: number; to: number }): number[] {
  if (range.to <= range.from) return [range.from];
  const mid = range.from + (range.to - range.from) / 2;
  return [range.from, mid, range.to];
}
