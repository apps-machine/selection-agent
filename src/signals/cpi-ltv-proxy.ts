/**
 * v1 cpi_ltv_proxy signal — public-estimates lookup for tier-2 SEA markets.
 *
 * The signal answers: "Given the category × market this opportunity targets,
 * how favorable is the LTV/CPI ratio for paid acquisition?" It's a proxy
 * because we don't have measured numbers yet — the table holds public
 * benchmarks (Liftoff, AppsFlyer, Adjust, Sensor Tower) seeded by the
 * founder. Once first-app revenue numbers exist, the seed gets calibrated
 * with empirical ranges per category × market.
 *
 * Formula (per docs/planning/agent-v1-foundation.md task 4 part B):
 *
 *   1. Look up (category, market) → cpi_low/high, ltv_low/high estimates.
 *   2. Compute the LTV/CPI ratio at midpoint: mid(ltv_low, ltv_high) /
 *      mid(cpi_low, cpi_high).
 *   3. Map the ratio to a 0-10 score band:
 *        ratio > 15      → 8-10
 *        10 ≤ ratio ≤ 15 → 5-7
 *        5  ≤ ratio < 10 → 2-4
 *        ratio < 5       → 0-1
 *
 * Returns null when:
 *   - The market isn't in the seed (unknown territory — emit null, not 0).
 *
 * Returns a category-family fallback when:
 *   - The market exists but the specific category has no seed row. We pick
 *     the nearest sibling category in the same market via CATEGORY_FAMILY
 *     (e.g., "education" falls back to "productivity"). If no sibling has
 *     a row either, returns null.
 *
 * The seed file (`cpi-ltv-seed.json`) is the source of truth. The function
 * reads it once at module load via `import` (Bun resolves JSON imports as
 * data) — no I/O at compute time. Replacing the seed is a one-line edit.
 */

import seedData from "./cpi-ltv-seed.json" with { type: "json" };

/**
 * Bumped on any formula or seed-shape change. Persisted in signal_snapshots
 * so backtest replay can pin to a specific generation. The seed file's own
 * `version` is independent and tracks data-set changes; the formula
 * version here tracks code changes (e.g., the band boundaries).
 */
export const CPI_LTV_PROXY_VERSION = "v1.0.0";

/** Fixed identifier used in signal_snapshots.signal_name. */
export const SIGNAL_NAME = "cpi_ltv_proxy";

/**
 * Category family map — categories grouped by behavior similarity for
 * fallback. Each row reads "if asked for KEY, fall back to VALUES in
 * order." Keys are categories the agent might query but that aren't in the
 * seed yet; values are seeded categories whose CPI/LTV pattern is the
 * closest available match.
 *
 * Subscription/utility apps cluster differently from games and shopping;
 * the family chains keep fallbacks inside the same monetization shape.
 */
const CATEGORY_FAMILY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // Primary categories pull from themselves first, then nearest sibling.
  health: ["health", "lifestyle", "productivity"],
  productivity: ["productivity", "health"],
  finance: ["finance", "productivity"],
  lifestyle: ["lifestyle", "health"],
  social: ["social", "lifestyle"],

  // Categories not directly seeded — fall back to the closest seeded sibling.
  utilities: ["productivity", "lifestyle"],
  education: ["productivity", "health"],
  entertainment: ["lifestyle", "social"],
  shopping: ["lifestyle", "finance"],
  games: ["social", "lifestyle"], // games behave differently; v2 should add a games preset
});

/**
 * Single estimate row, mirrors the seed JSON shape. Markets are
 * lowercased ISO 3166-1 alpha-2 codes; categories are the lower-case
 * Opportunity category enum values.
 */
export interface CpiLtvEstimate {
  market: string;
  category: string;
  cpi_low: number;
  cpi_high: number;
  ltv_low: number;
  ltv_high: number;
}

interface SeedFile {
  version: string;
  estimates: CpiLtvEstimate[];
}

const seed = seedData as unknown as SeedFile;

/** Exposed so tests can verify the seed loads + parses. */
export const CPI_LTV_SEED_VERSION: string = seed.version;
export const CPI_LTV_ESTIMATES: readonly CpiLtvEstimate[] = Object.freeze([...seed.estimates]);

/**
 * Index for O(1) lookups by (market, category). Built once at module load.
 * Markets and categories are normalized to lower-case here so callers can
 * pass any case without surprises.
 */
const ESTIMATE_INDEX: Readonly<Map<string, CpiLtvEstimate>> = (() => {
  const map = new Map<string, CpiLtvEstimate>();
  for (const e of seed.estimates) {
    const key = `${e.market.toLowerCase()}|${e.category.toLowerCase()}`;
    map.set(key, e);
  }
  return map;
})();

/**
 * Returns the set of markets that have at least one seeded category.
 * Used to distinguish "unknown market entirely" (return null) from
 * "known market, unknown category" (try category-family fallback).
 */
const KNOWN_MARKETS: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const e of seed.estimates) set.add(e.market.toLowerCase());
  return set;
})();

/** Midpoint of a low/high range. */
function mid(low: number, high: number): number {
  return (low + high) / 2;
}

/**
 * Map an LTV/CPI ratio to a 0-10 score. Within each band, the score
 * scales linearly so a tiny improvement in ratio shows up as a tiny
 * improvement in score (no flat plateaus inside a band).
 *
 * Boundaries (per spec):
 *   ratio > 15      → [8, 10]   (linear from 8@15 to 10@25+)
 *   ratio in [10,15]→ [5, 7]    (linear from 5@10 to 7@15)
 *   ratio in [5,10) → [2, 4]    (linear from 2@5 to 4@10)
 *   ratio < 5       → [0, 1]    (linear from 0@0 to 1@5)
 *
 * Negative or non-finite ratios → 0 (defensive; should never occur given
 * positive cpi/ltv ranges).
 */
export function scoreFromRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio < 5) {
    // 0 → 0, 5 → 1
    return (ratio / 5) * 1;
  }
  if (ratio < 10) {
    // 5 → 2, 10 → 4 (5-unit span maps to 2 points)
    return 2 + ((ratio - 5) / 5) * 2;
  }
  if (ratio <= 15) {
    // 10 → 5, 15 → 7 (5-unit span maps to 2 points)
    return 5 + ((ratio - 10) / 5) * 2;
  }
  // ratio > 15 — score in [8, 10] band
  // 15 → 8, 25+ → 10 (10-unit span maps to 2 points; cap at 10)
  const above = Math.min(ratio - 15, 10);
  return 8 + (above / 10) * 2;
}

/**
 * Resolve the seed entry for `(category, market)`, applying the family
 * fallback when the exact pair is missing.
 *
 * Returns null when:
 *   - The market isn't in the seed at all (unknown territory).
 *   - The market is known but no seeded category matches in the family chain.
 */
export function lookupCpiLtvEstimate(category: string, market: string): CpiLtvEstimate | null {
  const m = market.toLowerCase();
  const c = category.toLowerCase();
  if (!KNOWN_MARKETS.has(m)) return null;

  // Direct hit first.
  const direct = ESTIMATE_INDEX.get(`${m}|${c}`);
  if (direct !== undefined) return direct;

  // Family chain (skip the first element if it's the same category we just
  // tried — keeps the loop tight).
  const family = CATEGORY_FAMILY[c] ?? [];
  for (const sibling of family) {
    const sib = sibling.toLowerCase();
    if (sib === c) continue;
    const hit = ESTIMATE_INDEX.get(`${m}|${sib}`);
    if (hit !== undefined) return hit;
  }
  return null;
}

export interface ComputeCpiLtvProxyResult {
  /** 0-10 normalized score, or null when no usable seed entry was found. */
  score: number | null;
  /** Underlying estimate row used (for diagnostics + brief evidence). */
  estimate: CpiLtvEstimate | null;
  /** Computed LTV/CPI ratio (midpoint), exposed so tests / briefs can show it. */
  ratio: number | null;
  /** True iff the entry was a family fallback (category swap). */
  fallback: boolean;
}

/**
 * Compute the cpi_ltv_proxy score for a (category, market) pair.
 *
 * Returns `score: null` when the market is unknown entirely. Returns a
 * score with `fallback: true` when the exact category was missing but a
 * sibling category in the same market was used.
 */
export function computeCpiLtvProxy(category: string, market: string): ComputeCpiLtvProxyResult {
  const estimate = lookupCpiLtvEstimate(category, market);
  if (estimate === null) {
    return { score: null, estimate: null, ratio: null, fallback: false };
  }
  const cpiMid = mid(estimate.cpi_low, estimate.cpi_high);
  const ltvMid = mid(estimate.ltv_low, estimate.ltv_high);
  if (!Number.isFinite(cpiMid) || cpiMid <= 0 || !Number.isFinite(ltvMid)) {
    // Defensive: a malformed seed row shouldn't crash callers.
    return { score: null, estimate, ratio: null, fallback: false };
  }
  const ratio = ltvMid / cpiMid;
  const score = scoreFromRatio(ratio);
  const fallback = estimate.category.toLowerCase() !== category.toLowerCase();
  return { score, estimate, ratio, fallback };
}

import type { Database } from "bun:sqlite";

/**
 * Persist a cpi_ltv_proxy score to signal_snapshots.
 *
 * Deterministic — no LLM is involved — so all LLM provenance columns are
 * NULL except the prompt_version sentinel (which carries the formula
 * version so a bump creates a new row instead of overwriting). The
 * `app_id` is the source app the opportunity is derived from; signals
 * persist per source app even though the cpi_ltv estimate itself is per
 * (category, market) — this lets the opportunity assembler join uniformly.
 */
export function persistCpiLtvProxySignal(
  db: Database,
  app_id: string,
  value: number | null,
  t: number,
  opts: { clock?: () => number; version?: string } = {},
): void {
  const computed_at = (opts.clock ?? Date.now)();
  const version = opts.version ?? CPI_LTV_PROXY_VERSION;
  db.prepare(
    `INSERT INTO signal_snapshots (
       app_id, signal_name, t, value,
       llm_model, llm_prompt_version, llm_request_hash,
       llm_response_hash, llm_response_archived, source_urls_json,
       computed_at
     ) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(app_id, SIGNAL_NAME, t, value, version, "[]", computed_at);
}

/**
 * Compute + persist convenience helper. Keeps composition with the source
 * app id explicit; (category, market) is the input the formula needs but
 * `app_id` is the persistence key downstream consumers JOIN against.
 */
export function computeAndPersistCpiLtvProxy(
  db: Database,
  args: {
    app_id: string;
    category: string;
    market: string;
    t: number;
    clock?: () => number;
    version?: string;
  },
): ComputeCpiLtvProxyResult {
  const result = computeCpiLtvProxy(args.category, args.market);
  persistCpiLtvProxySignal(db, args.app_id, result.score, args.t, {
    clock: args.clock,
    version: args.version,
  });
  return result;
}
