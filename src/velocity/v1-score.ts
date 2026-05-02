/**
 * v1 velocity signal — chart_snapshots driven, smoothed, top-200 scoped.
 *
 * Distinct from the M5/M6 `getVelocityScore` in `delta.ts` which reads from
 * the legacy `app_snapshot` table for the existing pipeline. This module
 * reads from the NEW `chart_snapshots` table introduced by the v1 schema
 * (Task 2) and persists results to `signal_snapshots` with full provenance
 * for backtest replay.
 *
 * Why two paths coexist:
 *   - `delta.ts` / `getVelocityScore` powers the existing M6 orchestrator
 *     pipeline against snapshots already collected via run-snapshot.ts.
 *     Untouched by v1 to keep the 428 existing tests green.
 *   - `v1-score.ts` / `computeVelocityScoreV1` is the new v1 surface that
 *     reads from `chart_snapshots` (populated by Apple RSS / AppGoblin
 *     ingestion) and writes signals to `signal_snapshots` for the
 *     opportunity composer + backtest harness.
 *
 * The two will converge in a later task once the new chart_snapshots-based
 * ingestion fully replaces the legacy app_snapshot path.
 *
 * Per docs/planning/agent-v1-foundation.md task 3:
 *   - 30d-smoothing filter that excludes single-day spikes
 *   - Top-200 grossing scope
 *   - Persist signal snapshots with versioning to signal_snapshots
 *   - Output normalized 0-10 score per app
 *   - Returns null if N=0 days OR fewer than MIN_DAYS_FOR_SIGNAL days history
 */

import type { Database } from "bun:sqlite";
import pino from "pino";
import { smoothRankSeries } from "./smooth.ts";
import type { RankPoint } from "./types.ts";

const logger = pino({
  name: "velocity-v1",
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * Bumped on any formula change (smoothing rule, normalization curve,
 * top-N scope, etc). Persisted in signal_snapshots so backtest replay
 * can pin to a specific formula generation.
 */
export const VELOCITY_VERSION = "v1.0.0";

/**
 * Top-N grossing rank cutoff for the v1 velocity signal. Apps that never
 * appeared inside this rank window are not considered — the signal is a
 * tier-2 SEA "rising challenger" indicator, not a long-tail discovery.
 */
export const TOP_N = 200;

/**
 * Minimum days of history before velocity is computed. Below this, the
 * signal is too noisy to trust and we return null (the composer treats
 * null as "we don't know," NOT as zero).
 */
export const MIN_DAYS_FOR_SIGNAL = 7;

/**
 * Fixed identifier used in signal_snapshots.signal_name. Centralized so
 * downstream queries (composer, opportunity assembler, brief renderer)
 * can refer to a single string constant.
 */
export const SIGNAL_NAME = "velocity";

export interface ComputeVelocityV1Options {
  /** Override clock for tests. Returns epoch ms. */
  clock?: () => number;
  /**
   * Look-back window in days. Default 30 — matches "30d-smoothing" spec.
   * Tests pass smaller values to seed less data.
   */
  windowDays?: number;
  /**
   * Top-N rank cutoff. Default TOP_N (200). Tests can override to verify
   * the boundary is honored.
   */
  topN?: number;
  /** Minimum valid days required. Default MIN_DAYS_FOR_SIGNAL (7). */
  minDays?: number;
}

export interface ComputeVelocityV1Result {
  /** Normalized 0-10 score, or null when insufficient history. */
  score: number | null;
  /** Smoothed series actually used to derive the score. Empty when null. */
  smoothed: RankPoint[];
  /** Days of history available within the window AND inside top-N. */
  daysObserved: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read all (captured_at, rank) observations for a single app within the
 * trailing `windowDays` ending at `asOf`, capped at rank ≤ topN. Rows are
 * de-duplicated per day (one app may appear in multiple categories on the
 * same day; we take the BEST = lowest rank).
 *
 * SQL note: GROUP BY captured_at + MIN(rank) gives one row per day with
 * the app's best rank that day. Sort ASC for the smoother.
 */
function loadAppRankSeries(
  db: Database,
  app_id: string,
  fromT: number,
  toT: number,
  topN: number,
): RankPoint[] {
  const rows = db
    .prepare<{ t: number; rank: number }, [string, number, number, number]>(
      `SELECT captured_at AS t, MIN(rank) AS rank
       FROM chart_snapshots
       WHERE app_id = ? AND captured_at >= ? AND captured_at <= ? AND rank <= ?
       GROUP BY captured_at
       ORDER BY captured_at ASC`,
    )
    .all(app_id, fromT, toT, topN);
  return rows.map((r) => ({ t: r.t, rank: r.rank }));
}

/**
 * Map a rank delta (oldest_rank - newest_rank in the smoothed series — so
 * positive = climbed, e.g., 100 → 50 = +50) to a 0-10 score per spec:
 *
 *   improved by 50+   → 8-10  (linearly 8 at +50, 10 at +100+)
 *   improved by 20-49 → 5-7   (linearly 5 at +20, 7 at +49)
 *   improved by 0-19  → 2-4   (linearly 2 at  0, 4 at +19)
 *   declined or flat  → 0-1   (linearly 1 at  0, 0 at -50 or worse)
 *
 * Boundaries are inclusive on the lower bound, exclusive on the upper —
 * so improved = 50 lands in the 8-10 band, improved = 49 in the 5-7 band.
 *
 * The "0 falls into the 2-4 band" choice (rather than 0-1) reflects that
 * an app holding rank steadily in the top-200 grossing chart is itself a
 * mild positive signal — these are competitive slots. A truly weak signal
 * is when the app slides DOWN.
 */
export function normalizeRankDeltaToScore(rankImprovement: number): number {
  if (!Number.isFinite(rankImprovement)) return 0;

  if (rankImprovement >= 50) {
    // 50 → 8.0, 100+ → 10.0
    const above50 = Math.min(rankImprovement - 50, 50);
    return 8 + (above50 / 50) * 2;
  }
  if (rankImprovement >= 20) {
    // 20 → 5.0, 49 → 7.0 (29-rank span maps to 2 points)
    return 5 + ((rankImprovement - 20) / 29) * 2;
  }
  if (rankImprovement >= 0) {
    // 0 → 2.0, 19 → 4.0 (19-rank span maps to 2 points)
    return 2 + (rankImprovement / 19) * 2;
  }
  // Declined: 0 → 1.0 (already handled above), -1 → just under 1, -50+ → 0
  // Map [-50, 0) linearly to [0, 1).
  const decline = Math.min(-rankImprovement, 50);
  return Math.max(0, 1 - decline / 50);
}

/**
 * Compute the v1 velocity signal for a single app. Reads chart_snapshots,
 * applies the 30d-smoothing filter, normalizes the smoothed rank delta to
 * 0-10. Returns `{ score: null }` when:
 *
 *   - No chart_snapshots rows exist in the window (N=0).
 *   - Fewer than MIN_DAYS_FOR_SIGNAL distinct days inside top-N (signal
 *     too thin to trust).
 *
 * Does NOT persist on its own — call `persistVelocitySignal` to write to
 * signal_snapshots. The split lets the composer / harness compute many
 * scores in a hot loop and persist as a batched transaction.
 */
export function computeVelocityScoreV1(
  db: Database,
  app_id: string,
  opts: ComputeVelocityV1Options = {},
): ComputeVelocityV1Result {
  const now = (opts.clock ?? Date.now)();
  const windowDays = opts.windowDays ?? 30;
  const topN = opts.topN ?? TOP_N;
  const minDays = opts.minDays ?? MIN_DAYS_FOR_SIGNAL;

  if (windowDays <= 0) {
    throw new Error(`computeVelocityScoreV1: windowDays must be > 0, got ${windowDays}`);
  }
  if (topN <= 0) {
    throw new Error(`computeVelocityScoreV1: topN must be > 0, got ${topN}`);
  }
  if (minDays <= 0) {
    throw new Error(`computeVelocityScoreV1: minDays must be > 0, got ${minDays}`);
  }

  const fromT = now - windowDays * DAY_MS;
  const series = loadAppRankSeries(db, app_id, fromT, now, topN);

  if (series.length === 0) {
    logger.debug({ app_id, windowDays, topN }, "velocity-v1: no chart_snapshots in window");
    return { score: null, smoothed: [], daysObserved: 0 };
  }
  if (series.length < minDays) {
    logger.debug(
      { app_id, daysObserved: series.length, minDays },
      "velocity-v1: insufficient history",
    );
    return { score: null, smoothed: [], daysObserved: series.length };
  }

  const smoothed = smoothRankSeries(series);
  // After smoothing we may have fewer days. Re-check the threshold so a
  // series that's "7 days raw, all spikes" doesn't sneak past.
  if (smoothed.length < minDays) {
    logger.debug(
      { app_id, daysObserved: smoothed.length, minDays, rawDays: series.length },
      "velocity-v1: insufficient smoothed history",
    );
    return { score: null, smoothed: [], daysObserved: smoothed.length };
  }

  const oldest = smoothed[0]!;
  const newest = smoothed[smoothed.length - 1]!;
  // Improvement = positive when the app climbed (rank went DOWN).
  const rankImprovement = oldest.rank - newest.rank;
  const score = normalizeRankDeltaToScore(rankImprovement);

  return { score, smoothed, daysObserved: smoothed.length };
}

/**
 * Persist a v1 velocity score to signal_snapshots.
 *
 * Velocity is deterministic — no LLM is called — so all LLM provenance
 * columns are explicitly nulled. We still occupy the row in signal_snapshots
 * (rather than a separate deterministic-signals table) so the backtest
 * harness can JOIN one signals view across all signal types regardless of
 * provenance origin.
 *
 * Notes:
 *   - `llm_prompt_version` is the empty string (NOT null) because the
 *     `signal_snapshots` PRIMARY KEY includes it. NULLs in PK columns
 *     would let SQLite treat each NULL as distinct, breaking dedup. The
 *     empty string is a sentinel meaning "no prompt version applies."
 *   - `signal_pipeline_version` (from VELOCITY_VERSION) lives in the
 *     `metadata`-style portion via the explicit `llm_prompt_version` only;
 *     since velocity has no prompt, we encode the pipeline version in the
 *     same column. Bumping VELOCITY_VERSION will create a NEW row (per PK)
 *     instead of overwriting — so historical scores remain queryable.
 *   - Re-persisting the same (app_id, t, version) is rejected at PK level.
 *     Caller must dedupe upstream or wrap in INSERT OR IGNORE if idempotent
 *     re-runs are needed.
 */
export function persistVelocitySignal(
  db: Database,
  app_id: string,
  value: number | null,
  t: number,
  opts: { clock?: () => number; version?: string } = {},
): void {
  const computed_at = (opts.clock ?? Date.now)();
  const version = opts.version ?? VELOCITY_VERSION;
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
 * Compute + persist convenience helper. Composes the two operations under
 * a single transaction so partial failure is impossible: either the score
 * is durable or it isn't.
 */
export function computeAndPersistVelocityV1(
  db: Database,
  app_id: string,
  opts: ComputeVelocityV1Options & { version?: string } = {},
): ComputeVelocityV1Result {
  const now = (opts.clock ?? Date.now)();
  const result = computeVelocityScoreV1(db, app_id, opts);
  persistVelocitySignal(db, app_id, result.score, now, {
    clock: opts.clock,
    version: opts.version,
  });
  return result;
}
