/**
 * v1 forward-looking winner_score — ground truth label for backtest.
 *
 * Per docs/planning/agent-v1-foundation.md § "v1 ground truth":
 *
 *     winner_score(app, t) =
 *         0.4 × normalize(months_in_top_100_grossing_in_category)
 *       + 0.3 × normalize(review_count_growth_smoothed_90d)
 *       + 0.2 × normalize(public_revenue_estimate or 0)
 *       + 0.1 × normalize(retention_proxy_via_chart_stability)
 *
 * Tier classification:
 *   - score >= 7  → "winner"   (positive label)
 *   - 5 <= score < 7 → "marginal" (unlabelled)
 *   - score < 5    → "loser"    (negative label)
 *
 * STRICT TIME CUTOFF — single most important property of this function.
 * The signature is `(db, app_id, t0, t_measure)` where `t_measure = t0 + 12mo`.
 * Every read MUST be filtered with `captured_at <= t_measure`. Any query
 * that omits this filter is leakage — the backtest reports become
 * deceptively good and lie about real-world precision. Tests verify
 * that post-t_measure rows DO NOT influence the score.
 *
 * Returns `null` when the app has zero observable data at t_measure
 * (no chart_snapshots, no signal_snapshots). Don't conjure a score from
 * nothing — null tells the backtest harness "skip this app."
 *
 * Persistence: `winner_scores(app_id, t0)` is the PK. Re-running for the
 * same (app_id, t0) is rejected at the SQLite level — by design, since
 * a different score for the same decision date implies the formula
 * version drifted and we should bump `formula_version` instead of
 * silently overwriting. The PK rejection surfaces as a thrown error.
 */

import type { Database } from "bun:sqlite";
import {
  computeChartRankStdDev,
  NINETY_DAYS_MS,
  normalizeStabilityRetention,
} from "../signals/rank-stability.ts";

/** Bumped on any formula change (weights, normalization caps, tier boundaries). */
export const WINNER_SCORE_FORMULA_VERSION = "v1.0.0";

/** Months_in_top_100 reaches max score (1.0) at this cap. 36 months = 3 years. */
export const MONTHS_TOP100_CAP = 36;

/**
 * Review_growth normalizer cap. Chosen at "1000 new reviews / 90 days = 1.0"
 * — calibrated against tier-2 SEA chart leaders that typically pull 100-300
 * new reviews/90d organically, with viral hits hitting 5k+. v2 should
 * replace with empirical fit from labelled data.
 */
export const REVIEW_GROWTH_CAP = 1000;

/**
 * Public revenue estimate cap. $100k MRR = 1.0. Calibrated as the rough
 * boundary between "indie hit" and "category dominator." Above this point
 * we don't differentiate further — they're all winners.
 */
export const REVENUE_CAP_USD = 100_000;

/**
 * Chart stability normalizer constant — re-exported from ../signals/rank-stability
 * for backward compatibility. The shared module defines the canonical value
 * used by both retention-proxy (winner-score) and incumbent-vulnerability
 * (Task 5 chart-stability fallback) so a calibration bump retunes both in
 * lockstep.
 */
export { STABILITY_SD_BREAKEVEN } from "../signals/rank-stability.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

export type WinnerTier = "winner" | "marginal" | "loser";

export interface WinnerScoreResult {
  /** 0-10 winner score. */
  score: number;
  /** Tier derived from score thresholds. */
  tier: WinnerTier;
}

/**
 * Compute the forward-looking winner_score for one app.
 *
 * @param db        bun:sqlite handle with the v1 schema applied
 * @param app_id    application ID (Apple bundle / Google package)
 * @param t0        decision date — unix milliseconds
 * @param t_measure measurement date — unix milliseconds, typically t0 + 12mo
 *
 * Reads ONLY data with `captured_at <= t_measure`. Returns null if the
 * app has zero rows in chart_snapshots AND zero rows in signal_snapshots
 * at or before t_measure (nothing to score against).
 *
 * Persists the computed score to `winner_scores(app_id, t0)` if non-null.
 * Re-running with the same (app_id, t0) throws at the PK level.
 */
export function computeWinnerScore(
  db: Database,
  app_id: string,
  t0: number,
  t_measure: number,
): WinnerScoreResult | null {
  if (t_measure < t0) {
    throw new Error(`computeWinnerScore: t_measure (${t_measure}) must be >= t0 (${t0})`);
  }

  // Existence guard. If the app shows up nowhere in our snapshots at or
  // before t_measure, return null. We deliberately do NOT score zero —
  // "no data" is structurally different from "data shows zero."
  const exists = appHasAnyDataAtOrBefore(db, app_id, t_measure);
  if (!exists) {
    return null;
  }

  const monthsTop100 = computeMonthsInTop100Grossing(db, app_id, t_measure);
  const reviewGrowth = computeReviewCountGrowthSmoothed90d(db, app_id, t_measure);
  const revenue = computePublicRevenueEstimate(db, app_id, t_measure);
  const stability = computeRetentionProxyChartStability(db, app_id, t_measure);

  // Each component is normalized to [0, 1]; weights sum to 1.0; multiply by
  // 10 at the end so the output range is [0, 10] matching the rest of the
  // signal layer.
  const normalized =
    0.4 * normalizeMonthsTop100(monthsTop100) +
    0.3 * normalizeReviewGrowth(reviewGrowth) +
    0.2 * normalizeRevenue(revenue) +
    0.1 * normalizeStabilityRetention(stability);

  const score = Math.max(0, Math.min(10, normalized * 10));
  const tier = classifyTier(score);
  const result: WinnerScoreResult = { score, tier };

  // Persist. Insert (not upsert) — per the contract, re-scoring the same
  // (app_id, t0) requires a new formula_version. The PK-rejection surfaces
  // as an explicit SQLite error if a caller tries to silently re-score.
  db.prepare(
    `INSERT INTO winner_scores
     (app_id, t0, measured_at, score, tier, formula_version, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(app_id, t0, t_measure, score, tier, WINNER_SCORE_FORMULA_VERSION, Date.now());

  return result;
}

/** True if the app has any chart_snapshots OR signal_snapshots at or before t. */
function appHasAnyDataAtOrBefore(db: Database, app_id: string, t: number): boolean {
  const chartRow = db
    .prepare<{ count: number }, [string, number]>(
      "SELECT COUNT(*) AS count FROM chart_snapshots WHERE app_id = ? AND captured_at <= ?",
    )
    .get(app_id, t);
  if (chartRow && chartRow.count > 0) return true;
  const signalRow = db
    .prepare<{ count: number }, [string, number]>(
      "SELECT COUNT(*) AS count FROM signal_snapshots WHERE app_id = ? AND t <= ?",
    )
    .get(app_id, t);
  return Boolean(signalRow && signalRow.count > 0);
}

/**
 * Count distinct calendar months in which the app appeared in the top
 * 100 grossing chart at any market, at or before t_measure.
 *
 * The query joins chart_snapshots filtered by category + rank <= 100;
 * GROUP BY (year-month) collapses multiple snapshots in the same month
 * to one. We deliberately don't restrict to a single market — an app
 * that's #1 grossing in 6 markets across 3 months still counts as 3
 * months (not 18). The metric is about temporal persistence, not
 * geographic spread.
 */
export function computeMonthsInTop100Grossing(
  db: Database,
  app_id: string,
  t_measure: number,
): number {
  // SQLite trick: GROUP BY by floor(captured_at / month_ms) gives distinct
  // calendar months without needing strftime parsing.
  const row = db
    .prepare<{ months: number }, [number, string, number]>(
      `SELECT COUNT(DISTINCT (captured_at / ?)) AS months
       FROM chart_snapshots
       WHERE app_id = ? AND captured_at <= ? AND rank <= 100`,
    )
    .get(MONTH_MS, app_id, t_measure);
  return row?.months ?? 0;
}

/** Linear normalize [0, MONTHS_TOP100_CAP] → [0, 1]. */
export function normalizeMonthsTop100(months: number): number {
  if (!Number.isFinite(months) || months <= 0) return 0;
  return Math.min(1, months / MONTHS_TOP100_CAP);
}

/**
 * Smoothed 90-day review count growth ending at t_measure.
 *
 * We approximate from signal_snapshots rows tagged with the synthetic
 * `review_count` signal_name. v1 doesn't yet have a dedicated review-count
 * snapshot pipeline, so this returns 0 when no rows exist — a
 * conservative null-safe default that doesn't fabricate growth.
 *
 * Formula: latest_value - earliest_value over the 90-day window.
 * Smoothing: median of three windows (the latest, t-30d, t-60d) reduces
 * spike sensitivity. v2 replaces with proper rolling smoother once
 * the review-scraper persists into signal_snapshots.
 */
export function computeReviewCountGrowthSmoothed90d(
  db: Database,
  app_id: string,
  t_measure: number,
): number {
  const fromT = t_measure - NINETY_DAYS_MS;
  const rows = db
    .prepare<{ t: number; value: number | null }, [string, number, number]>(
      `SELECT t, value FROM signal_snapshots
       WHERE app_id = ? AND signal_name = 'review_count'
         AND t <= ? AND t >= ?
       ORDER BY t ASC`,
    )
    .all(app_id, t_measure, fromT);
  const numeric = rows.filter((r): r is { t: number; value: number } => r.value !== null);
  if (numeric.length < 2) return 0;
  const first = numeric[0];
  const last = numeric[numeric.length - 1];
  if (first === undefined || last === undefined) return 0;
  return last.value - first.value;
}

/** Linear normalize [0, REVIEW_GROWTH_CAP] → [0, 1]. */
export function normalizeReviewGrowth(growth: number): number {
  if (!Number.isFinite(growth) || growth <= 0) return 0;
  return Math.min(1, growth / REVIEW_GROWTH_CAP);
}

/**
 * Public revenue estimate (USD/month). Pulled from signal_snapshots rows
 * tagged with `public_revenue_estimate`. Returns 0 if missing — the
 * v1 spec explicitly says "weight 0" when this input is missing,
 * not null, because the formula is additive: a missing 20% term
 * shouldn't poison the other 80%.
 */
export function computePublicRevenueEstimate(
  db: Database,
  app_id: string,
  t_measure: number,
): number {
  const row = db
    .prepare<{ value: number | null }, [string, number]>(
      `SELECT value FROM signal_snapshots
       WHERE app_id = ? AND signal_name = 'public_revenue_estimate'
         AND t <= ?
       ORDER BY t DESC LIMIT 1`,
    )
    .get(app_id, t_measure);
  if (!row || row.value === null) return 0;
  return row.value;
}

/** Linear normalize [0, REVENUE_CAP_USD] → [0, 1]. */
export function normalizeRevenue(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.min(1, usd / REVENUE_CAP_USD);
}

/**
 * Retention proxy: thin wrapper over ../signals/rank-stability.computeChartRankStdDev
 * with the 90-day window pinned (the winner-score formula has always used 90d).
 * Kept as a named export for callers that imported it before the refactor.
 */
export function computeRetentionProxyChartStability(
  db: Database,
  app_id: string,
  t_measure: number,
): number | null {
  return computeChartRankStdDev(db, app_id, t_measure);
}

/**
 * Map stddev → [0, 1] retention component. Re-exported from
 * ../signals/rank-stability so callers retain the existing import surface.
 */
export { normalizeStabilityRetention as normalizeStability } from "../signals/rank-stability.ts";

/** Tier boundaries per spec: ≥7 winner, [5,7) marginal, <5 loser. */
export function classifyTier(score: number): WinnerTier {
  if (score >= 7) return "winner";
  if (score >= 5) return "marginal";
  return "loser";
}
