/**
 * Simple boolean winner_score — Path B' backtest variant.
 *
 * Why this exists separately from `winner-score.ts`:
 *   The v1 production formula (0.4 × months_top_100 + 0.3 × review_growth +
 *   0.2 × revenue + 0.1 × chart_stability) was designed assuming
 *   review_count + public_revenue_estimate scrapers existed. AppTweak data,
 *   the source for the Path B' backtest, has neither — so on the 48,511
 *   (app, t0) pairs in the cohort, only weights 0.4 + 0.1 = 0.5 contribute
 *   and observed max score = 2.42. Every row gets tier=`loser`, which
 *   makes precision@K trivially undefined.
 *
 * What this does:
 *   Boolean classification. tier = "winner" if the app appears in
 *   chart_snapshots with rank ≤ 100 at any time within t_measure ± 7 days,
 *   else tier = "loser". Score is 10/0 to keep the field populated.
 *
 *   This matches the plain-English thesis question:
 *     "of the apps the algo predicted, how many were still in the actual
 *      top-100 N months later?"
 *
 *   Returns null when the app has zero chart_snapshots rows at or before
 *   t_measure — same null-when-no-data contract as `computeWinnerScore`.
 *   Don't conjure a label from nothing.
 *
 * Persistence: Same `winner_scores(app_id, t0)` PK as the v1 formula,
 * with formula_version="v1.0.0-simple" so a single DB can hold both
 * variants if needed (same app/t0 with different formula_version still
 * collides at the PK level — callers must DELETE existing rows first).
 *
 * NOT a replacement for the v1 production formula in `winner-score.ts`.
 * This is a scoped backtest tool. The production pipeline keeps using
 * `computeWinnerScore` once review/revenue scrapers ship.
 */

import type { Database } from "bun:sqlite";
import type { WinnerScoreResult } from "./winner-score.ts";

/** Bumped on any boolean-formula change (window size, top-N threshold). */
export const SIMPLE_WINNER_FORMULA_VERSION = "v1.0.0-simple";

/** Half-window: a chart appearance within ±7 days of t_measure counts. */
export const WINNER_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the simple boolean winner_score for one app.
 *
 * @param db        bun:sqlite handle with the v1 schema applied
 * @param app_id    application ID (Apple bundle / Google package)
 * @param t0        decision date — unix milliseconds (persisted as PK)
 * @param t_measure measurement date — unix milliseconds, typically t0 + 12mo
 *
 * Returns:
 *   - `{ score: 10, tier: "winner" }` if any chart_snapshots row exists
 *     with `app_id=?, captured_at BETWEEN t_measure-7d AND t_measure+7d,
 *     rank<=100`
 *   - `{ score: 0, tier: "loser" }` if the app has any chart_snapshots data
 *     at or before t_measure but NOT in the winner window
 *   - `null` if the app has zero chart_snapshots rows at or before t_measure
 *
 * Persists on non-null result with formula_version="v1.0.0-simple". The
 * `(app_id, t0)` PK rejects collisions; callers should DELETE FROM
 * winner_scores first if rerunning over an existing dataset.
 */
export function computeSimpleWinnerScore(
  db: Database,
  app_id: string,
  t0: number,
  t_measure: number,
): WinnerScoreResult | null {
  if (t_measure < t0) {
    throw new Error(`computeSimpleWinnerScore: t_measure (${t_measure}) must be >= t0 (${t0})`);
  }

  // Existence guard. Match the v1 contract: if there's no observable data
  // at or before t_measure, return null. We deliberately do NOT label "no
  // data" as loser — structurally different from "data shows the app
  // wasn't in top-100."
  const existsRow = db
    .prepare<{ count: number }, [string, number]>(
      "SELECT COUNT(*) AS count FROM chart_snapshots WHERE app_id = ? AND captured_at <= ?",
    )
    .get(app_id, t_measure);
  if (!existsRow || existsRow.count === 0) {
    return null;
  }

  const windowMs = WINNER_WINDOW_DAYS * DAY_MS;
  const winnerRow = db
    .prepare<{ one: number }, [string, number, number]>(
      `SELECT 1 AS one FROM chart_snapshots
       WHERE app_id = ?
         AND captured_at BETWEEN ? AND ?
         AND rank <= 100
       LIMIT 1`,
    )
    .get(app_id, t_measure - windowMs, t_measure + windowMs);

  const result: WinnerScoreResult = winnerRow
    ? { score: 10, tier: "winner" }
    : { score: 0, tier: "loser" };

  // Persist. INSERT (not upsert) — caller is responsible for DELETE before
  // rerun. The PK collision surfaces as a thrown SQLite error so we don't
  // silently mask drift between formula versions.
  db.prepare(
    `INSERT INTO winner_scores
     (app_id, t0, measured_at, score, tier, formula_version, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    app_id,
    t0,
    t_measure,
    result.score,
    result.tier,
    SIMPLE_WINNER_FORMULA_VERSION,
    Date.now(),
  );

  return result;
}
