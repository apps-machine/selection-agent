/**
 * Rank-stability primitives — pure helpers that quantify how stable an app's
 * chart-rank position has been over a trailing window. Originally lived in
 * src/ground-truth/winner-score.ts as the retention-proxy component;
 * extracted into its own module so the v1 incumbent-vulnerability fallback
 * (Task 5) can reuse the same math without depending on the winner-score
 * orchestration.
 *
 * Math:
 *   - `computeChartRankStdDev` reads chart_snapshots for one app over a
 *     trailing window, returns the population std-dev of the rank values
 *     (or null if <3 observations).
 *   - `normalizeStabilityRetention` maps that std-dev to a [0, 1] retention
 *     component for winner_score (sd=0 → 1; sd ≥ breakeven → 0; linear).
 *   - `computeRankStabilityVulnerability` maps the same std-dev to a [0, 10]
 *     vulnerability component for incumbent-vulnerability (sd=0 → 0,
 *     entrenched / unmovable; sd ≥ breakeven → 10, volatile / vulnerable).
 *
 * Why two normalizers: retention-proxy answers "is this incumbent retaining
 * users?" — high stability = high retention. Incumbent-vulnerability answers
 * "is this incumbent dislodgeable?" — high stability = low vulnerability.
 * Same input, opposite normalization.
 */

import type { Database } from "bun:sqlite";

const DAY_MS = 24 * 60 * 60 * 1000;
export const NINETY_DAYS_MS = 90 * DAY_MS;

/**
 * Std-dev breakeven for both normalizers. Calibrated so a stable top-100 app
 * (rank shifting by ~5-10 across 90 days) lands well above breakeven on the
 * retention side, and an app oscillating across the entire chart (sd=50)
 * lands at the floor.
 *
 * Bumping this constant retunes both normalizers in lockstep — keep them
 * sharing one calibration so a v2 retention bump implicitly retunes v2
 * incumbent-vulnerability.
 */
export const STABILITY_SD_BREAKEVEN = 50;

/**
 * Population std-dev of the app's rank in chart_snapshots over the trailing
 * `windowDays` ending at `t`. Returns null when fewer than 3 observations
 * exist in the window — std-dev from 2 points is meaningless and 0 obs
 * means we have no signal.
 *
 * Cross-store note: this query DOES NOT filter by store. An app present in
 * both Apple and Google charts will see its observations pooled, which is
 * fine for the v1 use case (retention proxy + dislodgeability proxy both
 * benefit from more data). Callers that need store separation should query
 * directly with WHERE store = ? rather than calling this helper.
 */
export function computeChartRankStdDev(
  db: Database,
  app_id: string,
  t: number,
  windowDays = 90,
): number | null {
  const fromT = t - windowDays * DAY_MS;
  const rows = db
    .prepare<{ rank: number }, [string, number, number]>(
      `SELECT rank FROM chart_snapshots
       WHERE app_id = ? AND captured_at <= ? AND captured_at >= ?`,
    )
    .all(app_id, t, fromT);
  if (rows.length < 3) return null;
  const ranks = rows.map((r) => r.rank);
  const mean = ranks.reduce((a, b) => a + b, 0) / ranks.length;
  const variance = ranks.reduce((acc, r) => acc + (r - mean) ** 2, 0) / ranks.length;
  return Math.sqrt(variance);
}

/**
 * Retention-proxy normalizer. sd=0 → 1.0 (perfectly stable rank => high
 * retention); sd ≥ STABILITY_SD_BREAKEVEN → 0; linear in between. Null input
 * maps to 0 (no data ⇒ no retention credit).
 */
export function normalizeStabilityRetention(sd: number | null): number {
  if (sd === null || !Number.isFinite(sd)) return 0;
  if (sd <= 0) return 1;
  if (sd >= STABILITY_SD_BREAKEVEN) return 0;
  return 1 - sd / STABILITY_SD_BREAKEVEN;
}

/**
 * Incumbent-vulnerability normalizer. sd=0 → 0 (entrenched / unmovable rank
 * = invulnerable); sd ≥ STABILITY_SD_BREAKEVEN → 10 (volatile / dislodgeable);
 * linear in between. Null input maps to null (no data ⇒ unknown, not "we
 * know it's invulnerable" — null lets the composer treat it as missing).
 */
export function computeRankStabilityVulnerability(sd: number | null): number | null {
  if (sd === null || !Number.isFinite(sd)) return null;
  if (sd <= 0) return 0;
  if (sd >= STABILITY_SD_BREAKEVEN) return 10;
  return (sd / STABILITY_SD_BREAKEVEN) * 10;
}
