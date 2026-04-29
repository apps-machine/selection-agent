import { describe, expect, test } from "bun:test";
import { scoreComposite } from "../../src/scoring/composite.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";

const baseApp: RawAppData = {
  store: "apple",
  appId: "test",
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

describe("scoreComposite", () => {
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

  test("zero-rating app (no signal anywhere) yields composite 0", () => {
    const noSignal: RawAppData = {
      ...baseApp,
      rating: null,
      ratingsCount: null,
      iapPresent: false,
      description: "The best app for everyone.",
    };
    const out = scoreComposite({ app: noSignal, velocity: null });
    expect(out.composite).toBe(0);
  });

  test("high-opportunity app (gap + revenue + complex paywall) scores high (>=7)", () => {
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
  });

  test("velocity null uses 0.4/0.4/0.2 weights (loc, rev, paywall)", () => {
    const synthetic: RawAppData = {
      ...baseApp,
      market: "br", // EN desc in BR => loc gap = 10
      rating: 5,
      ratingsCount: 100_000_000, // ensures revenue = 10
      iapPresent: false, // paywall = 0
    };
    const out = scoreComposite({ app: synthetic, velocity: null });
    // expected: 10*0.4 + 10*0.4 + 0*0.2 = 8.0
    expect(out.composite).toBeCloseTo(8.0, 1);
  });

  test("velocity provided uses 0.3/0.3/0.15/0.25 weights", () => {
    const synthetic: RawAppData = {
      ...baseApp,
      market: "br",
      rating: 5,
      ratingsCount: 100_000_000,
      iapPresent: false,
    };
    const out = scoreComposite({ app: synthetic, velocity: 8 });
    // expected: 10*0.3 + 10*0.3 + 0*0.15 + 8*0.25 = 3 + 3 + 0 + 2 = 8.0
    expect(out.composite).toBeCloseTo(8.0, 1);
    expect(out.breakdown.velocity).toBe(8);
  });

  test("velocity 0 still uses velocity weights (different from null)", () => {
    const synthetic: RawAppData = {
      ...baseApp,
      market: "br",
      rating: 5,
      ratingsCount: 100_000_000,
      iapPresent: false,
    };
    const withZeroVel = scoreComposite({ app: synthetic, velocity: 0 });
    const withNullVel = scoreComposite({ app: synthetic, velocity: null });
    // null uses 0.4/0.4/0.2 weights = 8.0
    // velocity=0 uses 0.3/0.3/0.15/0.25 weights = 6.0
    expect(withNullVel.composite).toBeGreaterThan(withZeroVel.composite);
  });

  test("breakdown weights summary is included", () => {
    const out = scoreComposite({ app: baseApp, velocity: null });
    expect(out.weights).toEqual({ locGap: 0.4, revenue: 0.4, paywall: 0.2, velocity: 0 });
    const out2 = scoreComposite({ app: baseApp, velocity: 5 });
    expect(out2.weights).toEqual({ locGap: 0.3, revenue: 0.3, paywall: 0.15, velocity: 0.25 });
  });
});
