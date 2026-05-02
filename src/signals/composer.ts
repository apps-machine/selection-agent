/**
 * v1 scoring composer — top-3 robust mean over the four v1 signals.
 *
 * The composer's contract (per docs/planning/agent-v1-foundation.md
 * § "v1 scoring formula" + Codex Round 2 #3 fix):
 *
 *   - Inputs: SignalValues from src/opportunities/schema.ts. Each field is
 *     nullable; null means "we don't know," NOT "we know it's bad."
 *   - If fewer than 3 non-null signals are present, the composer returns
 *     `{ score: null, eligible: false }`. Below the threshold the
 *     opportunity isn't scoreable; downstream consumers MUST treat it as
 *     unranked, not as a low score.
 *   - If ≥3 non-null signals are present, take the top 3 by descending
 *     value and average them. Returns `{ score: avg, eligible: true }`.
 *
 * Why top-3 not all-4: robust to weak signals on individual dimensions.
 * An opportunity that's strong on 3 dimensions and weak on 1 still scores
 * well. This rejects the multiplicative-AND trap (any-zero-kills-all)
 * and the additive-mean trap (sum-of-noise).
 *
 * Why null is preserved (Codex Round 2 #3 — critical):
 *   - Coercing null to 0 silently turns "we have no data" into "this
 *     dimension is bad." That is wrong AND the kind of bug that's
 *     invisible until backtest precision craters.
 *   - The eligibility flag is the explicit downstream signal: not eligible
 *     ⇒ not scored ⇒ not ranked. Tests cover N=0, 1, 2, 3, 4 explicitly.
 *
 * Why a value of `0` IS counted in the top-3 (must NOT be silently dropped):
 *   - 0 is real information (the signal evaluated to bottom-of-band).
 *   - If 0 is one of the top 3 actual values (because the others are also
 *     low or null), it enters the average. That correctly reports a low
 *     score; pretending the value didn't exist is dishonest.
 *
 * No confidence_modifier in v1 (Codex Round 2 #4 fix): the modifier was
 * designed to dampen scores by ground-truth corroboration, but at v1 ship
 * we have no ground truth yet. A constant ×0.7 is a no-op that adds
 * complexity. v2 adds it once `winner_scores` has hundreds of historical
 * labels.
 */

import type { SignalValues } from "../opportunities/schema.ts";

/**
 * Bumped on any formula change (band boundaries, robust-mean rule,
 * eligibility threshold). Persisted in the opportunities table per record
 * so backtest replay can pin to a specific scoring generation.
 */
export const SCORING_VERSION = "v1.0.0";

/**
 * Minimum count of non-null signals required for the opportunity to be
 * scoreable. Hard-coded at 3 to match the spec; lower would let weak
 * 1-signal opportunities sneak into the ranking; higher would shrink the
 * candidate set too aggressively until v1 has more signal types.
 */
export const MIN_NON_NULL_SIGNALS = 3;

/**
 * How many top signals to average. Independent of MIN_NON_NULL_SIGNALS so
 * v2 can introduce a 5th signal and update TOP_K to 4 without changing the
 * eligibility floor.
 */
export const TOP_K = 3;

export interface ComposerResult {
  /** Top-K mean of non-null signals, or null when ineligible. */
  score: number | null;
  /** True iff at least MIN_NON_NULL_SIGNALS signals were non-null. */
  eligible: boolean;
}

/**
 * Order is documentation only — the composer is invariant to which signal
 * holds which value. The shape mirrors SignalValuesSchema for clarity at
 * call sites.
 */
const SIGNAL_KEYS: readonly (keyof SignalValues)[] = [
  "locGap",
  "velocity",
  "incumbent_vulnerability",
  "cpi_ltv_proxy",
] as const;

/**
 * Compute the v1 opportunity score from SignalValues.
 *
 * See module docstring for full contract. Tested against N = 0, 1, 2, 3, 4
 * non-null inputs; null is preserved (never coerced to 0); a literal 0
 * value participates in the top-K selection like any other number.
 */
export function computeOpportunityScore(signals: SignalValues): ComposerResult {
  // Extract non-null values from the four v1 keys. We deliberately iterate
  // a known key set (instead of Object.values) so adding a future field to
  // SignalValuesSchema doesn't silently change scoring semantics — any new
  // signal MUST be added to SIGNAL_KEYS and have its formula version bumped.
  const nonNull: number[] = [];
  for (const k of SIGNAL_KEYS) {
    const v = signals[k];
    // The exact predicate matters: `v != null` excludes both null and
    // undefined; `v === 0 || v` would silently drop 0 (the bug we're
    // explicitly testing against). Number.isFinite guards against NaN
    // / Infinity that would corrupt the mean if they slipped through.
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      nonNull.push(v);
    }
  }

  if (nonNull.length < MIN_NON_NULL_SIGNALS) {
    return { score: null, eligible: false };
  }

  // Top-K by value descending. .sort returns the array; we copy first to
  // avoid mutating the caller's data even though we built the local list.
  const sorted = [...nonNull].sort((a, b) => b - a);
  const topK = sorted.slice(0, TOP_K);
  const sum = topK.reduce((acc, x) => acc + x, 0);
  const score = sum / TOP_K;
  return { score, eligible: true };
}
