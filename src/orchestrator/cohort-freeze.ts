/**
 * Cohort-freeze sequencing primitive — the v1 backtest leakage guard.
 *
 * The pattern (Codex Round 2 #9 fix):
 *
 *   1. Ingest immutable snapshots into chart_snapshots / signal_snapshots
 *      / app_metadata_snapshots etc. These rows are append-only and carry
 *      the timestamp `t` of the underlying observation.
 *   2. `freezeCohort(db, market, t0, candidate_app_ids)` captures the
 *      list of apps eligible at the historical decision date `t0`. The
 *      list is stored once in `cohort_freezes` so every backtest re-run
 *      against the same (market, t0) operates on the same apps.
 *   3. `getFrozenCohortFeatures(db, freeze)` returns ONLY signal_snapshots
 *      whose timestamp is `<= freeze.t0`. Post-t0 rows are leakage and
 *      surface as a thrown error, not silently filtered — silent filtering
 *      would let bugs in time-window code hide successful precision
 *      numbers behind data-from-the-future.
 *   4. Compute signals from the frozen feature set.
 *   5. Compute labels (winner_score) at `t0 + 12mo`. Labels NEVER feed
 *      back into features — they are the held-out target.
 *
 * Why this matters: any feature derived from data observed AFTER `t0` is
 * leakage. A backtest with leakage looks great in the report and lies
 * about real-world precision. Freeze + post-t0 detection is the
 * one-and-only line of defense at this layer.
 */

import type { Database } from "bun:sqlite";
import type { OpportunityMarket } from "../opportunities/schema.ts";

export type CohortFreeze = {
  /** Historical decision date — unix milliseconds. */
  t0: number;
  /** Market the cohort was frozen for. */
  market: OpportunityMarket;
  /** App IDs frozen at t0; the cohort is immutable after freeze. */
  app_ids: string[];
  /** Wall-clock timestamp the freeze was performed — unix milliseconds. */
  frozen_at: number;
};

export type SignalSnapshotRow = {
  app_id: string;
  signal_name: string;
  /** Snapshot observation timestamp — unix milliseconds. Must be <= freeze.t0. */
  t: number;
  value: number | null;
  llm_model: string | null;
  llm_prompt_version: string;
  llm_request_hash: string | null;
  llm_response_hash: string | null;
  llm_response_archived: string | null;
  source_urls_json: string | null;
  computed_at: number;
};

export type FreezeCohortOptions = {
  /** Override clock for tests. Defaults to Date.now. */
  clock?: () => number;
};

/**
 * Freeze a cohort at `t0`.
 *
 * Verifies every candidate app appeared in `chart_snapshots` at or before
 * `t0` (otherwise it cannot have been knowable at the decision date).
 * Persists `(market, t0, app_ids_json, frozen_at)` to `cohort_freezes`.
 *
 * Throws if:
 *  - `candidate_app_ids` is empty (a freeze of zero apps is meaningless).
 *  - Any candidate has no chart_snapshots row with `captured_at <= t0`.
 *  - A freeze for `(market, t0)` already exists with a different app set
 *    (composite-PK insert collides; surfaced as a clear error).
 */
export function freezeCohort(
  db: Database,
  market: OpportunityMarket,
  t0: number,
  candidate_app_ids: readonly string[],
  opts: FreezeCohortOptions = {},
): CohortFreeze {
  if (candidate_app_ids.length === 0) {
    throw new Error("freezeCohort: candidate_app_ids is empty; refusing to freeze 0-app cohort");
  }

  const clock = opts.clock ?? Date.now;

  // Verify every app appeared in chart_snapshots at or before t0.
  const checkStmt = db.prepare<{ count: number }, [string, number]>(
    "SELECT COUNT(*) AS count FROM chart_snapshots WHERE app_id = ? AND captured_at <= ?",
  );
  const missing: string[] = [];
  for (const id of candidate_app_ids) {
    const row = checkStmt.get(id, t0);
    if (!row || row.count === 0) {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `freezeCohort: ${missing.length} app(s) missing from chart_snapshots at or before t0=${t0}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? `, +${missing.length - 5} more` : ""}`,
    );
  }

  const frozen_at = clock();
  const app_ids = [...candidate_app_ids];
  db.prepare(
    "INSERT INTO cohort_freezes (market, t0, app_ids_json, frozen_at) VALUES (?, ?, ?, ?)",
  ).run(market, t0, JSON.stringify(app_ids), frozen_at);

  return { t0, market, app_ids, frozen_at };
}

/**
 * Options for getFrozenCohortFeatures. Reserved for opt-outs that should
 * be deliberate, not defaults — like skipping the leakage detection in
 * batch-precomputed multi-cohort runs.
 */
export type GetFrozenCohortFeaturesOptions = {
  /**
   * Skip the post-t0-row leakage check. Use ONLY when signal_snapshots
   * was populated as a batch-precomputed grid covering many (market, t0)
   * cohorts at once (e.g., the Path B' AppTweak experiment), where the
   * presence of t > t0 rows is expected — they belong to FUTURE cohorts
   * for the same app, not leakage. The SELECT below still honors the
   * t<=t0 cutoff regardless, so disabling the check does not introduce
   * leakage at the read layer; it only suppresses the bug-detection
   * tripwire designed for the per-cohort production pipeline.
   *
   * Default: false. The check is mandatory for production pipelines so
   * a faulty signal-write code path surfaces as a clear error.
   */
  skip_leakage_check?: boolean;
};

/**
 * Read the cohort's signal features as observed at or before `freeze.t0`.
 *
 * Leakage detection: this function FIRST checks whether any
 * signal_snapshots rows exist for any frozen app with `t > freeze.t0`.
 * If so, it throws — even though the SELECT below would have filtered
 * them out. The throw is the point: a row with `t > freeze.t0` means
 * the signal pipeline was run against data observed after the decision
 * date, and even though we'd discard it for THIS read, the row's
 * existence indicates the upstream pipeline isn't honoring the cutoff.
 * Better to surface that bug now than to ship silent results.
 *
 * Set `opts.skip_leakage_check = true` for batch-precomputed multi-cohort
 * runs (see GetFrozenCohortFeaturesOptions). The SELECT cutoff (t<=t0) is
 * always applied; the option only skips the upfront tripwire.
 */
export function getFrozenCohortFeatures(
  db: Database,
  freeze: CohortFreeze,
  opts: GetFrozenCohortFeaturesOptions = {},
): SignalSnapshotRow[] {
  if (freeze.app_ids.length === 0) {
    return [];
  }
  const placeholders = freeze.app_ids.map(() => "?").join(",");

  if (!opts.skip_leakage_check) {
    // Leakage detection: any post-t0 row for our frozen apps is a bug.
    const leakageRow = db
      .prepare<{ count: number }, (string | number)[]>(
        `SELECT COUNT(*) AS count FROM signal_snapshots
         WHERE app_id IN (${placeholders}) AND t > ?`,
      )
      .get(...freeze.app_ids, freeze.t0);
    if (leakageRow && leakageRow.count > 0) {
      throw new Error(
        `getFrozenCohortFeatures: detected ${leakageRow.count} signal_snapshots row(s) with t > t0=${freeze.t0} for frozen cohort (market=${freeze.market}). Backtest leakage — fix the signal pipeline cutoff before retrying.`,
      );
    }
  }

  return db
    .prepare<SignalSnapshotRow, (string | number)[]>(
      `SELECT app_id, signal_name, t, value,
              llm_model, llm_prompt_version, llm_request_hash, llm_response_hash,
              llm_response_archived, source_urls_json, computed_at
       FROM signal_snapshots
       WHERE app_id IN (${placeholders}) AND t <= ?
       ORDER BY app_id, signal_name, t`,
    )
    .all(...freeze.app_ids, freeze.t0);
}
