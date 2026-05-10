/**
 * Stage 3 Runbook-Discovery — risk-thresholds schema.
 *
 * Defines the Zod schema for the user-supplied thresholds JSON consumed by
 * `selection-agent risk-check`. Defaults are baked in so a partial JSON file
 * (or `{}`) parses cleanly with sensible portfolio-strategy defaults; the
 * schema itself is the single source of truth for default values.
 *
 * Pure module — no IO, no side effects. The CLI surface lives in
 * `src/cli/index.ts` (subcommand) and `src/path-e/risk-check.ts`
 * (evaluator).
 */

import { z } from "zod";

/**
 * Default supported markets for the language-quality / coverage check.
 * Tier-2 SEA cluster (where the locGap thesis is empirically alive) plus
 * tier-1 mature markets the operator can ship native quality into without
 * relying on community translators. Operators with different language
 * skills or partner coverage should override via the JSON file.
 */
export const DEFAULT_SUPPORTED_MARKETS = [
  // Tier-2 SEA (locGap thesis alive — see m7.5-thesis-validation.md)
  "id",
  "vn",
  "th",
  "my",
  "bd",
  // Tier-1 mature
  "us",
  "gb",
  "ca",
  "au",
  "fr",
  "de",
] as const;

/**
 * Default clonable DNA classes — superset of the shortlist's CLONABLE_AUTO
 * and CLONABLE_REVIEW sets. Kept inline (not imported from build-shortlist
 * to keep this module dependency-free) so consumers can read the schema's
 * defaults without pulling in the whole shortlist pipeline.
 */
export const DEFAULT_CLONABLE_DNA_CLASSES = [
  "Match",
  "Hyper-Casual",
  "Idle",
  "Board & Card Games",
  "Photo & Video",
  "Productivity & Tools",
  "Lifestyle",
  "Education",
  "Health & Fitness",
  "Graphic & Design",
  "Party & Words",
  "Books & Writing",
  "Puzzle",
  "Simulation",
  "Casino",
] as const;

/**
 * Risk thresholds schema. All fields have defaults so a user-supplied
 * partial JSON (or the empty object `{}`) parses successfully. Defaults
 * are GENERIC portfolio-strategy values, NOT founder-specific calibrations.
 */
export const RiskThresholdsSchema = z.object({
  /**
   * Maximum portfolio concurrency — a candidate must currently appear in
   * at least this many tier-2 SEA markets (per its `markets_active` field)
   * to pass the spread test. Default 3 reflects a balanced cross-market
   * signal; lower this if you want to consider single-market wins.
   */
  maxConcurrentMarkets: z.number().int().min(1).max(10).default(3),

  /**
   * Minimum trailing-year top-100 tenure (in days) the candidate must
   * achieve in its best market to count as durable. Default 180 = ~6 months,
   * matching the shortlist pipeline's F1 durability filter.
   */
  minTenureDays: z.number().int().min(0).max(365).default(180),

  /**
   * Subscription IAP requirement. When true, candidates without a
   * subscription IAP fail the check (signal of established-monetization
   * market validation). When false, the check is informational only and
   * does not contribute to the aggregate verdict.
   */
  requireSubscriptionIap: z.boolean().default(false),

  /**
   * Markets the operator can ship native-quality localization into. ISO
   * alpha-2 codes (lowercase). A candidate PASSes if all of its
   * `markets_active` are in this set; WARNs if some are outside; FAILs if
   * none are. Defaults to the tier-2 SEA cluster + tier-1 mature markets.
   */
  supportedMarkets: z.array(z.string().length(2)).default([...DEFAULT_SUPPORTED_MARKETS]),

  /**
   * DNA classes the operator considers clonable. Defaults to the union of
   * the shortlist pipeline's CLONABLE_AUTO + CLONABLE_REVIEW sets. A
   * candidate FAILs if its `dna_class` is null or not in this set.
   */
  clonableDnaClasses: z.array(z.string()).default([...DEFAULT_CLONABLE_DNA_CLASSES]),
});

export type RiskThresholds = z.infer<typeof RiskThresholdsSchema>;
