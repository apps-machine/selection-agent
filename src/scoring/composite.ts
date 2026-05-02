/**
 * Composite scorer — adapter from RawAppData to the v1 top-3 robust mean.
 *
 * Originally (v0.7) this was a fixed-weight sum of locGap + revenue +
 * paywall + velocity. v1 swaps the formula for the robust top-3 mean
 * exposed in `src/signals/composer.ts`. The shape of `CompositeOutput`
 * is preserved so the existing reporters (briefs, ranker, refresh-demo)
 * keep their call sites unchanged — but the score itself now follows
 * the v1 contract: top-3 of N≥3, null when N<3.
 *
 * Why preserve the shape: the orchestrator pipeline persists `composite`
 * onto every ScoredCandidate; briefs render `composite.composite` and the
 * `breakdown.{locGap,revenue,paywall,velocity}` per-row. Changing those
 * field names would cascade through brief golden snapshots, refresh-demo
 * payloads, and ranker tests. Adapter pattern keeps blast radius small.
 *
 * Why the heuristic-weight constants are gone:
 *   The old WEIGHTS_NO_VELOCITY / WEIGHTS_WITH_VELOCITY tables encoded a
 *   weighted-sum formula that we explicitly replaced. Keeping them around
 *   would invite confusion (looks like the formula uses them — it doesn't).
 *   The `weights` field is now a status object that reports which signals
 *   participated in the top-3 and the eligibility flag, not a multiplier
 *   table. Old callers that read `weights.velocity` to mean "did velocity
 *   participate" still work; callers that read it as a multiplier never
 *   should have.
 *
 * The four sub-scores (locGap, revenue, paywall, velocity) computed from
 * RawAppData remain published in `breakdown` for human reading in the
 * brief. They no longer feed the composer 1:1 (the v1 SignalValues are
 * locGap + velocity + incumbent_vulnerability + cpi_ltv_proxy); instead,
 * this adapter passes the four legacy sub-scores into the composer using
 * the SignalValues shape as a vehicle, taking advantage of its
 * top-3-of-N nature. revenue + paywall stand in for the v1 signals that
 * aren't computable from RawAppData alone (incumbent_vulnerability needs
 * reviews; cpi_ltv_proxy needs (category, market) lookups).
 */

import type { SignalValues } from "../opportunities/schema.ts";
import { computeOpportunityScore, SCORING_VERSION } from "../signals/composer.ts";
import type { RawAppData } from "../types/raw-app-data.ts";
import { scoreLocalizationGap } from "./localization-gap.ts";
import { scorePaywallComplexity } from "./paywall-complexity.ts";
import { scoreRevenue } from "./revenue-estimator.ts";

export { SCORING_VERSION };

export interface CompositeInput {
  app: RawAppData;
  /**
   * Velocity sub-score (0-10), or null until M5 baselines accumulate.
   * Null means "we don't know" — the composer will exclude it from the
   * top-3 mean entirely (NOT coerce to 0).
   */
  velocity: number | null;
}

/**
 * Status object reporting which signals participated. `eligible` is the
 * v1 contract gate (≥3 non-null sub-scores required to produce a score).
 * The legacy `weights` field is preserved for backward compatibility with
 * brief / ranker / demo code that imported the type — values are now
 * informational booleans-as-numbers (1 = signal participated, 0 = absent).
 */
export interface CompositeWeights {
  locGap: number;
  revenue: number;
  paywall: number;
  velocity: number;
}

export interface CompositeBreakdown {
  locGap: number;
  revenue: number;
  paywall: number;
  velocity: number | null;
}

export interface CompositeOutput {
  /**
   * Top-3 mean of non-null sub-scores. Always 0-10. When fewer than 3
   * sub-scores are non-null, set to 0 (the composite contract is a number
   * for backward-compat) and `eligible: false` is set on the output.
   */
  composite: number;
  /** True iff at least 3 sub-scores were non-null (v1 eligibility gate). */
  eligible: boolean;
  /** Per-sub-score values for human reading in the brief. */
  breakdown: CompositeBreakdown;
  /**
   * 1 = sub-score participated (non-null & finite), 0 = absent. Preserved
   * as `Record<string, number>` so existing callers reading
   * `weights.velocity` still get a number; the semantic shifted from
   * "multiplier" to "participation flag".
   */
  weights: CompositeWeights;
}

/**
 * Build a SignalValues object from the four legacy sub-scores. revenue
 * and paywall stand in for the v1-native signals that need richer inputs
 * than RawAppData alone (incumbent_vulnerability, cpi_ltv_proxy). The
 * composer doesn't care which key holds which value — it operates on the
 * top-3 of the value set. Null inputs stay null.
 */
function adaptToSignalValues(
  locGap: number,
  revenue: number,
  paywall: number,
  velocity: number | null,
): SignalValues {
  return {
    locGap,
    velocity,
    // The next two slots reuse the SignalValues schema as transport for
    // the legacy revenue + paywall sub-scores. v2 will compute the real
    // incumbent_vulnerability + cpi_ltv_proxy from richer inputs and the
    // legacy slots will retire.
    incumbent_vulnerability: revenue,
    cpi_ltv_proxy: paywall,
  };
}

export function scoreComposite(input: CompositeInput): CompositeOutput {
  const { app, velocity } = input;

  const locGap = scoreLocalizationGap({ description: app.description, market: app.market });
  const revenue = scoreRevenue({
    rating: app.rating,
    ratingsCount: app.ratingsCount,
    market: app.market,
  });
  const paywall = scorePaywallComplexity({
    iapPresent: app.iapPresent,
    description: app.description,
  });

  const signals = adaptToSignalValues(locGap, revenue, paywall, velocity);
  const result = computeOpportunityScore(signals);

  // When ineligible (N<3), publish composite=0 + eligible=false so brief +
  // ranker still receive a number (their existing types expected one).
  // Downstream code that wants to filter ineligible candidates checks the
  // explicit `eligible` flag, NOT the score being 0.
  const composite = result.score ?? 0;

  // Participation flags. velocity is the only nullable input from the caller;
  // the heuristic sub-scores are always finite (their respective scorers
  // already clamp to 0 instead of null). We still report 1 for finite values
  // and 0 for null/non-finite to keep the semantics uniform.
  const weights: CompositeWeights = {
    locGap: Number.isFinite(locGap) ? 1 : 0,
    revenue: Number.isFinite(revenue) ? 1 : 0,
    paywall: Number.isFinite(paywall) ? 1 : 0,
    velocity: velocity !== null && Number.isFinite(velocity) ? 1 : 0,
  };

  return {
    composite: Math.max(0, Math.min(10, composite)),
    eligible: result.eligible,
    breakdown: { locGap, revenue, paywall, velocity },
    weights,
  };
}
