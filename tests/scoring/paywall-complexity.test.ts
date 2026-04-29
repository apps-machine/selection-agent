import { describe, expect, test } from "bun:test";
import { scorePaywallComplexity } from "../../src/scoring/paywall-complexity.ts";

describe("scorePaywallComplexity", () => {
  test("returns 0 when no IAP present", () => {
    expect(
      scorePaywallComplexity({ iapPresent: false, description: "Free app, no purchases." }),
    ).toBe(0);
  });

  test("returns baseline (3) when IAP present but description is plain", () => {
    expect(
      scorePaywallComplexity({ iapPresent: true, description: "Buy more features." }),
    ).toBe(3);
  });

  test("subscription keywords add signal (>=5)", () => {
    const s = scorePaywallComplexity({
      iapPresent: true,
      description: "Unlock premium with a monthly subscription.",
    });
    expect(s).toBeGreaterThanOrEqual(5);
  });

  test("free trial + subscription scores >=7", () => {
    const s = scorePaywallComplexity({
      iapPresent: true,
      description: "Start with a 7-day free trial, then $9.99/month.",
    });
    expect(s).toBeGreaterThanOrEqual(7);
  });

  test("subscription + trial + lifetime scores >=9", () => {
    const s = scorePaywallComplexity({
      iapPresent: true,
      description:
        "Free trial available. Monthly subscription or one-time lifetime purchase.",
    });
    expect(s).toBeGreaterThanOrEqual(9);
  });

  test("multiple pricing tiers add signal", () => {
    const plain = scorePaywallComplexity({
      iapPresent: true,
      description: "Subscribe monthly to unlock features.",
    });
    const tiered = scorePaywallComplexity({
      iapPresent: true,
      description: "Subscribe monthly to Pro, Premium, or Plus tier.",
    });
    expect(tiered).toBeGreaterThan(plain);
  });

  test("keyword detection is case-insensitive", () => {
    const lower = scorePaywallComplexity({
      iapPresent: true,
      description: "monthly subscription, free trial, lifetime",
    });
    const upper = scorePaywallComplexity({
      iapPresent: true,
      description: "MONTHLY SUBSCRIPTION, FREE TRIAL, LIFETIME",
    });
    expect(upper).toBe(lower);
  });

  test("score is bounded [0, 10]", () => {
    const s = scorePaywallComplexity({
      iapPresent: true,
      description:
        "Subscription monthly yearly free trial lifetime one-time forever Pro Premium Plus Elite Ultimate",
    });
    expect(s).toBeLessThanOrEqual(10);
    expect(s).toBeGreaterThanOrEqual(0);
  });

  test("empty description with IAP returns baseline (3)", () => {
    expect(scorePaywallComplexity({ iapPresent: true, description: "" })).toBe(3);
  });
});
