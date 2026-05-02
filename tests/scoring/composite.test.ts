/**
 * Tests for src/scoring/composite.ts after the v1 top-3 robust mean
 * refactor. The legacy weighted-sum formula is gone — composite now
 * delegates to src/signals/composer.ts.
 *
 * Per docs/planning/agent-v1-foundation.md task 4 part C:
 *   - Score = top-3 mean of {locGap, revenue, paywall, velocity},
 *     null sub-scores excluded.
 *   - Eligibility: ≥3 non-null sub-scores → eligible: true.
 *   - Composite shape (composite/breakdown/weights) preserved for the
 *     brief + ranker; weights now reports participation (1) vs absence (0)
 *     instead of multiplier weights.
 *
 * The legacy revenue + paywall sub-scores are always finite (their scorers
 * clamp to 0 instead of null), so the only nullable sub-score is velocity.
 * That means N is either 3 (velocity null) or 4 (velocity present), so
 * the composite always returns eligible: true under normal conditions.
 */

import { describe, expect, test } from "bun:test";
import { SCORING_VERSION, scoreComposite } from "../../src/scoring/composite.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";

const baseApp: RawAppData = {
  store: "apple",
  appId: "test",
  trackId: null,
  market: "us",
  name: "Test App",
  developer: "Test Dev",
  category: "Productivity",
  rank: 1,
  rating: 4.5,
  ratingsCount: 50_000,
  priceUsd: 0,
  iapPresent: false,
  description: "The best calorie counter app. Track meals and reach your goals.",
  screenshotUrls: [],
  iconUrl: null,
  releaseDate: null,
  lastUpdated: null,
  scrapedAt: new Date().toISOString(),
};

describe("scoreComposite — shape preserved (brief + ranker compat)", () => {
  test("returns breakdown with all sub-scores when velocity null", () => {
    const out = scoreComposite({ app: baseApp, velocity: null });
    expect(out.breakdown.locGap).toBeGreaterThanOrEqual(0);
    expect(out.breakdown.locGap).toBeLessThanOrEqual(10);
    expect(out.breakdown.revenue).toBeGreaterThanOrEqual(0);
    expect(out.breakdown.paywall).toBeGreaterThanOrEqual(0);
    expect(out.breakdown.velocity).toBeNull();
  });

  test("composite is bounded [0, 10]", () => {
    const out = scoreComposite({ app: baseApp, velocity: null });
    expect(out.composite).toBeGreaterThanOrEqual(0);
    expect(out.composite).toBeLessThanOrEqual(10);
  });

  test("eligible: true when 3 sub-scores are non-null (velocity null path)", () => {
    // locGap, revenue, paywall always finite → N=3 → eligible.
    const out = scoreComposite({ app: baseApp, velocity: null });
    expect(out.eligible).toBe(true);
  });

  test("eligible: true with all 4 sub-scores (velocity provided)", () => {
    const out = scoreComposite({ app: baseApp, velocity: 7 });
    expect(out.eligible).toBe(true);
  });
});

describe("scoreComposite — top-3 robust mean formula", () => {
  test("zero-rating app (no signal anywhere) yields composite 0", () => {
    const noSignal: RawAppData = {
      ...baseApp,
      rating: null,
      ratingsCount: null,
      iapPresent: false,
      description: "The best app for everyone.",
    };
    const out = scoreComposite({ app: noSignal, velocity: null });
    // All three sub-scores ≈ 0 → top-3 mean = 0; eligible: true (N=3 of 0s).
    expect(out.composite).toBe(0);
    expect(out.eligible).toBe(true);
  });

  test("high-opportunity app (gap + revenue + complex paywall) scores high (≥7)", () => {
    const highOpp: RawAppData = {
      ...baseApp,
      market: "br",
      rating: 4.7,
      ratingsCount: 2_000_000,
      iapPresent: true,
      description:
        "The best calorie counter app. Free trial, then monthly subscription or lifetime upgrade.",
    };
    const out = scoreComposite({ app: highOpp, velocity: null });
    expect(out.composite).toBeGreaterThanOrEqual(7);
    expect(out.eligible).toBe(true);
  });

  test("velocity null: composite = mean of {locGap, revenue, paywall}", () => {
    const synthetic: RawAppData = {
      ...baseApp,
      market: "br", // EN desc in BR ⇒ loc gap = 10
      rating: 5,
      ratingsCount: 100_000_000, // ⇒ revenue = 10
      iapPresent: false, // ⇒ paywall = 0
    };
    const out = scoreComposite({ app: synthetic, velocity: null });
    // Top-3 of {10, 10, 0, null} (N=3) = (10+10+0)/3 ≈ 6.667
    expect(out.composite).toBeCloseTo((10 + 10 + 0) / 3, 2);
  });

  test("velocity provided: composite = top-3 mean (lowest sub-score excluded)", () => {
    const synthetic: RawAppData = {
      ...baseApp,
      market: "br",
      rating: 5,
      ratingsCount: 100_000_000,
      iapPresent: false,
    };
    const out = scoreComposite({ app: synthetic, velocity: 8 });
    // Top-3 of {10, 10, 0, 8} = top-3 = {10, 10, 8} → 28/3 ≈ 9.333
    expect(out.composite).toBeCloseTo((10 + 10 + 8) / 3, 2);
    expect(out.breakdown.velocity).toBe(8);
  });

  test("velocity 0 still treated as a real value (NOT silently dropped)", () => {
    // Codex R2 #3 invariant at this layer too: 0 must enter the top-3
    // selection if it ranks among the top 3 by value. With paywall=0 and
    // velocity=0, both 0s sit at the bottom and the top-3 picks {10, 10, 0}.
    const synthetic: RawAppData = {
      ...baseApp,
      market: "br",
      rating: 5,
      ratingsCount: 100_000_000,
      iapPresent: false,
    };
    const withZeroVel = scoreComposite({ app: synthetic, velocity: 0 });
    const withNullVel = scoreComposite({ app: synthetic, velocity: null });
    // Both have effectively the same top-3 because the 0 from velocity is
    // tied with the 0 from paywall — top-3 picks 10, 10, then one of the 0s.
    // The composite is identical because the math is the same: (10+10+0)/3.
    expect(withZeroVel.composite).toBeCloseTo(withNullVel.composite, 5);
    // And the participation flag distinguishes the two cases:
    expect(withZeroVel.weights.velocity).toBe(1);
    expect(withNullVel.weights.velocity).toBe(0);
  });

  test("weights now report participation (1) vs absence (0), not multipliers", () => {
    const out = scoreComposite({ app: baseApp, velocity: null });
    expect(out.weights).toEqual({ locGap: 1, revenue: 1, paywall: 1, velocity: 0 });

    const out2 = scoreComposite({ app: baseApp, velocity: 5 });
    expect(out2.weights).toEqual({ locGap: 1, revenue: 1, paywall: 1, velocity: 1 });
  });

  test("velocity-only-strong app: top-3 includes velocity (high) + 2 others", () => {
    // base app on US: locGap ≈ 0 (English in US is not a gap), reasonable
    // revenue, no paywall. Adding velocity=10 gives top-3 = {10, revenue, 0}.
    const out = scoreComposite({ app: baseApp, velocity: 10 });
    expect(out.composite).toBeGreaterThan(0);
    expect(out.breakdown.velocity).toBe(10);
  });
});

describe("scoreComposite — boundary + invariants", () => {
  test("never NaN even when all sub-scores collapse to 0", () => {
    const dead: RawAppData = {
      ...baseApp,
      rating: 0,
      ratingsCount: 0,
      iapPresent: false,
      description: "",
    };
    const out = scoreComposite({ app: dead, velocity: null });
    expect(Number.isNaN(out.composite)).toBe(false);
    expect(Number.isFinite(out.composite)).toBe(true);
  });

  test("monotonic across velocity: higher velocity ⇒ higher composite when it's in top-3", () => {
    const synthetic: RawAppData = {
      ...baseApp,
      market: "br",
      rating: 5,
      ratingsCount: 100_000_000,
      iapPresent: true,
      description: "Free trial then monthly subscription.",
    };
    const at5 = scoreComposite({ app: synthetic, velocity: 5 }).composite;
    const at8 = scoreComposite({ app: synthetic, velocity: 8 }).composite;
    expect(at8).toBeGreaterThanOrEqual(at5);
  });

  test("SCORING_VERSION re-exported from composer", () => {
    expect(SCORING_VERSION).toBe("v1.0.0");
  });
});
