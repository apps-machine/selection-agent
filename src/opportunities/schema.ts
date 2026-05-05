/**
 * Opportunity contract — the v1 agent primitive.
 *
 * The agent's primitive is the Opportunity record, NOT the Brief. The Brief
 * is a rendering of an Opportunity into prose for indie maker consumption.
 *
 * Three rings of fields:
 *   1. LOAD-BEARING — structured, required for backtest queries + outcome
 *      tracking (id, source/target market, signals, predicted ranges,
 *      kill_metric, score, eligible flag).
 *   2. NARRATIVE — LLM-rendered, flexible (thesis prose + evidence URLs).
 *   3. ESCAPE HATCH — opaque metadata that evolves freely; promote to the
 *      contract once a key proves load-bearing across hundreds of records.
 *
 * Spec: docs/planning/agent-v1-foundation.md § "Opportunity contract".
 */

import { z } from "zod";

/**
 * Markets enum — ISO 3166-1 alpha-2 lowercase. Mirrors the existing 2-char
 * MarketCode pattern from src/judges/schemas.ts but pinned to the explicit
 * v1 universe (tier-1 anchor + tier-2 SEA target). Backtest queries
 * `WHERE target_market IN (...)` need a closed enum, not an open string.
 */
export const OpportunityMarketSchema = z.enum([
  "us",
  "jp",
  "kr",
  "de",
  "fr",
  "br",
  "es",
  "mx",
  "id",
  "vn",
  "th",
  "my",
  "ph",
  "bd",
]);
export type OpportunityMarket = z.infer<typeof OpportunityMarketSchema>;

/**
 * App-store category enum — starter list per the spec; not exhaustive of
 * Apple/Google taxonomies. Categories that surface in tier-2 SEA top-grossing
 * charts that the v1 agent reasons about. Extend cautiously: every new
 * category needs a cpi_ltv_proxy lookup row before scoring is meaningful.
 */
export const OpportunityCategorySchema = z.enum([
  "health",
  "productivity",
  "games",
  "lifestyle",
  "social",
  "utilities",
  "education",
  "finance",
  "shopping",
  "entertainment",
]);
export type OpportunityCategory = z.infer<typeof OpportunityCategorySchema>;

/** Score 0-10 with sub-decimal precision. Matches the existing Score10. */
const Score10 = z.number().min(0).max(10);

/**
 * Citation — every evidence URL must carry a claim string so the brief
 * renderer can show "URL X — claim supported". The optional source_quote
 * lets LLM augment paste verbatim text from the source as further proof.
 */
export const CitationSchema = z.object({
  url: z.string().url(),
  claim: z.string().min(1),
  source_quote: z.string().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

/**
 * SignalValues — all four v1 signals (locGap, velocity, incumbent_vulnerability,
 * cpi_ltv_proxy). Each is nullable on its own: a missing signal is "we don't
 * know," not "we know it's bad." Never coerce null to zero — the scoring
 * composer treats null and zero very differently. mechanic_novelty is
 * intentionally absent in v1 (evidence-only, lives in metadata.mechanic_evidence).
 */
export const SignalValuesSchema = z.object({
  locGap: Score10.nullable().optional(),
  velocity: Score10.nullable().optional(),
  incumbent_vulnerability: Score10.nullable().optional(),
  cpi_ltv_proxy: Score10.nullable().optional(),
});
export type SignalValues = z.infer<typeof SignalValuesSchema>;

/**
 * Predicted unit economics in ranges. CPI/LTV reported as low/high pairs to
 * convey the agent's uncertainty rather than fake precision. Validation
 * budget is the explicit kill-the-bet amount the founder commits before
 * checking the kill_metric.
 */
export const PredictedSchema = z.object({
  cpi_low: z.number().nonnegative().optional(),
  cpi_high: z.number().nonnegative().optional(),
  ltv_low: z.number().nonnegative().optional(),
  ltv_high: z.number().nonnegative().optional(),
  validation_budget_usd: z.number().nonnegative().optional(),
});
export type Predicted = z.infer<typeof PredictedSchema>;

/**
 * KillMetric — the machine-readable abort condition. `direction` is a closed
 * enum so the backtest harness can compare numerically without LLM parsing.
 * Example: { metric: "roas_d14", threshold: 0.5, direction: "below" } means
 * "kill if ROAS at day 14 is below 0.5".
 */
export const KillMetricDirectionSchema = z.enum(["below", "above"]);
export type KillMetricDirection = z.infer<typeof KillMetricDirectionSchema>;

export const KillMetricSchema = z.object({
  metric: z.string().min(1),
  threshold: z.number(),
  direction: KillMetricDirectionSchema,
});
export type KillMetric = z.infer<typeof KillMetricSchema>;

/**
 * ActualOutcome — populated post-validation, never at opportunity-generation
 * time. label is the ground-truth tier (winner/loser/marginal) or
 * not_validated when the founder declined to test. revenue_proven is
 * optional because not every winner discloses MRR.
 */
export const OutcomeLabelSchema = z.enum(["winner", "loser", "marginal", "not_validated"]);
export type OutcomeLabel = z.infer<typeof OutcomeLabelSchema>;

export const ActualOutcomeSchema = z.object({
  measured_at: z.string().datetime(),
  metric_value: z.number(),
  label: OutcomeLabelSchema,
  revenue_proven: z.number().nonnegative().optional(),
});
export type ActualOutcome = z.infer<typeof ActualOutcomeSchema>;

/**
 * Opportunity — the v1 agent primitive.
 *
 * Note on score/eligible consistency: schema accepts both
 * `{ score: null, eligible: true }` and `{ score: <number>, eligible: false }`.
 * These pairs are inconsistent at the scoring-composer level (eligibility
 * implies a real score; ineligibility implies null), but the schema does NOT
 * enforce that invariant. Downstream code (composer + persister) is expected
 * to keep the pair consistent. Schema-level enforcement was rejected because
 * it would force test fixtures to set both fields together for every
 * unrelated test, multiplying churn for a single composer-level rule.
 */
export const OpportunitySchema = z.object({
  // ─── LOAD-BEARING ───
  id: z.string().uuid(),
  generated_at: z.string().datetime(),
  source_app_id: z.string().min(1),
  source_market: OpportunityMarketSchema,
  target_market: OpportunityMarketSchema,
  category: OpportunityCategorySchema,

  signal_values: SignalValuesSchema,
  predicted: PredictedSchema,
  kill_metric: KillMetricSchema,
  actual_outcome: ActualOutcomeSchema.optional(),

  score: Score10.nullable(),
  eligible: z.boolean(),

  // ─── NARRATIVE ───
  thesis: z.string().min(1),
  evidence: z.array(CitationSchema).min(1),

  // ─── ESCAPE HATCH ───
  // metadata is opaque JSON. v1 keys: signal_pipeline_version, scoring_version,
  // mechanic_evidence (qualitative LLM paragraph). New keys land here freely
  // and graduate into the contract once they prove load-bearing across runs.
  metadata: z.record(z.string(), z.unknown()),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;
