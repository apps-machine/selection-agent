/**
 * Tests for src/signals/composer.ts.
 *
 * Coverage required by docs/planning/agent-v1-foundation.md task 4 part C
 * (Codex Round 2 #3 fix — CRITICAL):
 *   - N=0 signals → { score: null, eligible: false }
 *   - N=1 signal → { score: null, eligible: false }
 *   - N=2 signals → { score: null, eligible: false }
 *   - N=3 signals (one is 0) → eligible: true, score = avg of all 3 (0 IS counted)
 *   - N=4 signals → eligible: true, score = avg of top 3 (lowest excluded)
 *   - Null safety: signal with value 0 ≠ null treatment (0 enters top-3 if among highest)
 *   - All 4 signals same value (e.g., 5) → score = 5, eligible: true
 *
 * Plus boundary checks on null vs undefined vs 0 + the SCORING_VERSION constant.
 */

import { describe, expect, test } from "bun:test";
import type { SignalValues } from "../../src/opportunities/schema.ts";
import {
  computeOpportunityScore,
  MIN_NON_NULL_SIGNALS,
  SCORING_VERSION,
  TOP_K,
} from "../../src/signals/composer.ts";

describe("computeOpportunityScore — N count branches", () => {
  test("N=0: empty signals → { score: null, eligible: false }", () => {
    expect(computeOpportunityScore({})).toEqual({ score: null, eligible: false });
  });

  test("N=0: all four keys explicitly null → { score: null, eligible: false }", () => {
    const sigs: SignalValues = {
      locGap: null,
      velocity: null,
      incumbent_vulnerability: null,
      cpi_ltv_proxy: null,
    };
    expect(computeOpportunityScore(sigs)).toEqual({ score: null, eligible: false });
  });

  test("N=1: one signal present → { score: null, eligible: false }", () => {
    const sigs: SignalValues = { locGap: 9 };
    expect(computeOpportunityScore(sigs)).toEqual({ score: null, eligible: false });
  });

  test("N=1: one signal with value 0 still N=1 → { score: null, eligible: false }", () => {
    const sigs: SignalValues = { locGap: 0 };
    expect(computeOpportunityScore(sigs)).toEqual({ score: null, eligible: false });
  });

  test("N=2: two signals → { score: null, eligible: false }", () => {
    const sigs: SignalValues = { locGap: 9, velocity: 8 };
    expect(computeOpportunityScore(sigs)).toEqual({ score: null, eligible: false });
  });

  test("N=2: two signals with one being 0 → { score: null, eligible: false }", () => {
    const sigs: SignalValues = { locGap: 0, velocity: 8 };
    expect(computeOpportunityScore(sigs)).toEqual({ score: null, eligible: false });
  });

  test("N=3: three signals → eligible: true, score = avg of all 3", () => {
    const sigs: SignalValues = { locGap: 9, velocity: 6, incumbent_vulnerability: 3 };
    const out = computeOpportunityScore(sigs);
    expect(out.eligible).toBe(true);
    expect(out.score).toBeCloseTo((9 + 6 + 3) / 3, 5);
  });

  test("N=3: one signal IS 0 (not null) → 0 enters top-3 → avg includes the 0", () => {
    // CRITICAL test: 0 must NOT be silently dropped. With N=3 and the lowest
    // being 0, the top-3 IS all 3 — the 0 enters the average.
    const sigs: SignalValues = { locGap: 9, velocity: 6, incumbent_vulnerability: 0 };
    const out = computeOpportunityScore(sigs);
    expect(out.eligible).toBe(true);
    expect(out.score).toBeCloseTo((9 + 6 + 0) / 3, 5);
  });

  test("N=4: four signals → eligible: true, score = avg of TOP 3 (lowest excluded)", () => {
    const sigs: SignalValues = {
      locGap: 9,
      velocity: 8,
      incumbent_vulnerability: 7,
      cpi_ltv_proxy: 2, // lowest — must be excluded
    };
    const out = computeOpportunityScore(sigs);
    expect(out.eligible).toBe(true);
    expect(out.score).toBeCloseTo((9 + 8 + 7) / 3, 5);
  });

  test("N=4: lowest signal is 0 → 0 excluded from top-3", () => {
    const sigs: SignalValues = {
      locGap: 9,
      velocity: 8,
      incumbent_vulnerability: 7,
      cpi_ltv_proxy: 0, // lowest at 0 — excluded from top-3
    };
    const out = computeOpportunityScore(sigs);
    expect(out.eligible).toBe(true);
    expect(out.score).toBeCloseTo((9 + 8 + 7) / 3, 5);
  });
});

describe("computeOpportunityScore — null vs zero distinction (Codex R2 #3 critical)", () => {
  test("0 enters top-3 if among highest (all signals = 0)", () => {
    const sigs: SignalValues = {
      locGap: 0,
      velocity: 0,
      incumbent_vulnerability: 0,
      cpi_ltv_proxy: 0,
    };
    const out = computeOpportunityScore(sigs);
    expect(out.eligible).toBe(true);
    expect(out.score).toBe(0);
  });

  test("0 vs null: signal=0 IS counted in N; signal=null is NOT", () => {
    // N=3 with one explicit 0 → eligible
    const withZero: SignalValues = {
      locGap: 5,
      velocity: 5,
      incumbent_vulnerability: 0, // 0 still counts as a non-null sample
    };
    expect(computeOpportunityScore(withZero).eligible).toBe(true);

    // N=2 with one null → ineligible (the null does NOT count)
    const withNull: SignalValues = {
      locGap: 5,
      velocity: 5,
      incumbent_vulnerability: null,
    };
    expect(computeOpportunityScore(withNull).eligible).toBe(false);
  });

  test("undefined treated identically to null (omitted key)", () => {
    // SignalValuesSchema fields are .nullable().optional(); a key may be
    // omitted (undefined) instead of explicitly null. Both must drop out
    // of N.
    const omitted: SignalValues = { locGap: 5, velocity: 5 };
    expect(computeOpportunityScore(omitted).eligible).toBe(false);

    const explicitUndef = { ...omitted, incumbent_vulnerability: undefined } as SignalValues;
    expect(computeOpportunityScore(explicitUndef).eligible).toBe(false);
  });

  test("never coerce null to 0: a single non-null=10 + 3 nulls → still ineligible", () => {
    // If null were coerced to 0, this would have N=4 and score = (10+0+0)/3
    // and look like an okay opportunity. With the contract, N=1 → null score.
    const sigs: SignalValues = {
      locGap: 10,
      velocity: null,
      incumbent_vulnerability: null,
      cpi_ltv_proxy: null,
    };
    const out = computeOpportunityScore(sigs);
    expect(out.score).toBeNull();
    expect(out.eligible).toBe(false);
  });
});

describe("computeOpportunityScore — top-K behavior", () => {
  test("all 4 signals same value (5) → score = 5, eligible: true", () => {
    const sigs: SignalValues = {
      locGap: 5,
      velocity: 5,
      incumbent_vulnerability: 5,
      cpi_ltv_proxy: 5,
    };
    const out = computeOpportunityScore(sigs);
    expect(out.eligible).toBe(true);
    expect(out.score).toBe(5);
  });

  test("ties at top-K boundary: tie included as part of top-3 (sort stable enough)", () => {
    // If three signals tie at 7 and one is 4, top-3 are {7,7,7}, score 7.
    const sigs: SignalValues = {
      locGap: 7,
      velocity: 7,
      incumbent_vulnerability: 7,
      cpi_ltv_proxy: 4,
    };
    const out = computeOpportunityScore(sigs);
    expect(out.score).toBe(7);
  });

  test("monotonic property: replacing the lowest non-top-3 value should not change the score", () => {
    const a = computeOpportunityScore({
      locGap: 9,
      velocity: 8,
      incumbent_vulnerability: 7,
      cpi_ltv_proxy: 2,
    }).score!;
    const b = computeOpportunityScore({
      locGap: 9,
      velocity: 8,
      incumbent_vulnerability: 7,
      cpi_ltv_proxy: 0, // changed lowest
    }).score!;
    expect(a).toBeCloseTo(b, 5);
    expect(a).toBeCloseTo((9 + 8 + 7) / 3, 5);
  });

  test("top-3 of 4 is INVARIANT to which key holds which value", () => {
    // Same set of values arranged differently across keys → same score.
    const arr1 = computeOpportunityScore({
      locGap: 1,
      velocity: 9,
      incumbent_vulnerability: 5,
      cpi_ltv_proxy: 7,
    }).score!;
    const arr2 = computeOpportunityScore({
      locGap: 9,
      velocity: 7,
      incumbent_vulnerability: 1,
      cpi_ltv_proxy: 5,
    }).score!;
    const arr3 = computeOpportunityScore({
      locGap: 7,
      velocity: 5,
      incumbent_vulnerability: 9,
      cpi_ltv_proxy: 1,
    }).score!;
    // All three arrangements have top-3 = {9,7,5} → score = 7
    expect(arr1).toBeCloseTo(7, 5);
    expect(arr2).toBeCloseTo(7, 5);
    expect(arr3).toBeCloseTo(7, 5);
  });

  test("non-finite slipping in (NaN/Infinity) is filtered defensively", () => {
    const sigs = {
      locGap: 9,
      velocity: 8,
      incumbent_vulnerability: 7,
      cpi_ltv_proxy: Number.NaN as number,
    } as SignalValues;
    const out = computeOpportunityScore(sigs);
    // NaN dropped → N=3 → eligible with avg of (9, 8, 7).
    expect(out.eligible).toBe(true);
    expect(out.score).toBeCloseTo((9 + 8 + 7) / 3, 5);
  });
});

describe("composer constants", () => {
  test("SCORING_VERSION = v1.0.0", () => {
    expect(SCORING_VERSION).toBe("v1.0.0");
  });

  test("MIN_NON_NULL_SIGNALS = 3 (per spec)", () => {
    expect(MIN_NON_NULL_SIGNALS).toBe(3);
  });

  test("TOP_K = 3 (per spec)", () => {
    expect(TOP_K).toBe(3);
  });
});
