/**
 * 30-day rank smoothing for the v1 velocity signal.
 *
 * The new `chart_snapshots` table records one row per (market, category,
 * captured_at, rank) with the app at that rank on that day. When we compute
 * velocity for an app, we get a noisy time-series: ranks bounce day-to-day
 * for editorial reasons (a featured slot, a holiday spike, a brief category
 * reshuffle) without reflecting the app's actual trajectory.
 *
 * The smoother filters single-day spikes — days where the rank jumps by more
 * than `SPIKE_THRESHOLD` ranks compared to BOTH neighbors. A genuine climb
 * over 30 days will move ~5-10 ranks per day; a 90-rank single-day swing
 * that reverts is editorial noise, not signal.
 *
 * Per docs/planning/agent-v1-foundation.md task 3:
 *   "Define noise threshold: rank_delta > 80 in 1 day = noise (drop)"
 *
 * The filter is conservative: only drops a point if the absolute delta to
 * BOTH the previous and next observation exceeds the threshold, AND the
 * point reverts (sign flip on either side). A monotonic 90-rank climb over
 * 5 days is real; a single-day 90-rank spike that reverses is not. Edge
 * points (first / last) are kept as-is — there's no neighbor to compare on
 * one side, and the v1 score relies on the endpoints.
 */

import type { RankPoint, SmoothOptions } from "./types.ts";

/** A single-day rank delta exceeding this is treated as noise (per spec). */
export const SPIKE_THRESHOLD = 80;

/**
 * Smooths a time-series of `(date, rank)` pairs by dropping single-day
 * spikes. Input must be sorted by date ASC; output preserves order and
 * drops spike rows entirely (no interpolation — the score uses what
 * remains).
 *
 * Returns a new array; does not mutate the input.
 */
export function smoothRankSeries(
  series: readonly RankPoint[],
  opts: SmoothOptions = {},
): RankPoint[] {
  const threshold = opts.spikeThreshold ?? SPIKE_THRESHOLD;
  if (threshold <= 0) {
    throw new Error(`smoothRankSeries: spikeThreshold must be > 0, got ${threshold}`);
  }
  if (series.length <= 2) {
    // Not enough neighbors to detect a spike. Keep both endpoints — the
    // caller must handle <2 day series at the score-eligibility layer.
    return [...series];
  }

  const out: RankPoint[] = [];
  out.push(series[0]!);
  for (let i = 1; i < series.length - 1; i++) {
    const prev = series[i - 1]!;
    const cur = series[i]!;
    const next = series[i + 1]!;

    const deltaPrev = cur.rank - prev.rank;
    const deltaNext = next.rank - cur.rank;

    // Spike: huge jump on both sides AND the jump reverses (prev→cur and
    // cur→next have opposite signs). A monotonic 100-rank climb across two
    // days is real movement; a 90-up-then-90-down round-trip is editorial
    // noise.
    const bigBoth = Math.abs(deltaPrev) > threshold && Math.abs(deltaNext) > threshold;
    const reverses = Math.sign(deltaPrev) !== Math.sign(deltaNext) && deltaPrev !== 0;
    if (bigBoth && reverses) {
      continue; // drop this point
    }
    out.push(cur);
  }
  out.push(series[series.length - 1]!);
  return out;
}
