import type { RawAppData } from "../types/raw-app-data.ts";
import { scoreLocalizationGap } from "./localization-gap.ts";
import { scorePaywallComplexity } from "./paywall-complexity.ts";
import { scoreRevenue } from "./revenue-estimator.ts";

export interface CompositeInput {
  app: RawAppData;
  /**
   * Velocity sub-score (0-10), or null until M5 baselines accumulate (Track B
   * scaffolding writes daily snapshots; J14+ delta produces a usable score).
   */
  velocity: number | null;
}

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
  composite: number;
  breakdown: CompositeBreakdown;
  weights: CompositeWeights;
}

const WEIGHTS_NO_VELOCITY: CompositeWeights = {
  locGap: 0.4,
  revenue: 0.4,
  paywall: 0.2,
  velocity: 0,
};

const WEIGHTS_WITH_VELOCITY: CompositeWeights = {
  locGap: 0.3,
  revenue: 0.3,
  paywall: 0.15,
  velocity: 0.25,
};

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

  const weights = velocity === null ? WEIGHTS_NO_VELOCITY : WEIGHTS_WITH_VELOCITY;

  const composite =
    locGap * weights.locGap +
    revenue * weights.revenue +
    paywall * weights.paywall +
    (velocity ?? 0) * weights.velocity;

  return {
    composite: Math.max(0, Math.min(10, composite)),
    breakdown: { locGap, revenue, paywall, velocity },
    weights,
  };
}
