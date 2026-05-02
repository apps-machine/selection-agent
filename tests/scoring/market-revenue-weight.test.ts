/**
 * Tests for src/scoring/market-revenue-weight.ts after the v1 category
 * preset split (ex-TODO at line 23).
 *
 * Required by docs/planning/agent-v1-foundation.md task 4 part B:
 *   - Verify category preset split works (subscription / games / ads).
 *   - Confirm cpi_ltv_proxy can read from the same source (consistency:
 *     every market in the cpi_ltv_proxy seed has at least a default
 *     fallback in each preset).
 *   - Backwards compatibility: v0.7 surface (`MARKET_REVENUE_WEIGHT`,
 *     `DEFAULT_REVENUE_WEIGHT`, `marketRevenueWeight(market)`) still
 *     returns the same numbers as before.
 */

import { describe, expect, test } from "bun:test";
import {
  ADS_REVENUE_WEIGHT,
  DEFAULT_ADS_WEIGHT,
  DEFAULT_GAMES_WEIGHT,
  DEFAULT_PRESET_FALLBACKS,
  DEFAULT_REVENUE_WEIGHT,
  DEFAULT_SUBSCRIPTION_WEIGHT,
  GAMES_REVENUE_WEIGHT,
  MARKET_REVENUE_WEIGHT,
  marketRevenueWeight,
  REVENUE_WEIGHT_PRESETS,
  SUBSCRIPTION_REVENUE_WEIGHT,
} from "../../src/scoring/market-revenue-weight.ts";
import { CPI_LTV_ESTIMATES } from "../../src/signals/cpi-ltv-proxy.ts";

describe("v0.7 backwards compatibility", () => {
  test("MARKET_REVENUE_WEIGHT === SUBSCRIPTION_REVENUE_WEIGHT (re-export)", () => {
    expect(MARKET_REVENUE_WEIGHT).toBe(SUBSCRIPTION_REVENUE_WEIGHT);
  });

  test("DEFAULT_REVENUE_WEIGHT === DEFAULT_SUBSCRIPTION_WEIGHT (re-export)", () => {
    expect(DEFAULT_REVENUE_WEIGHT).toBe(DEFAULT_SUBSCRIPTION_WEIGHT);
    expect(DEFAULT_REVENUE_WEIGHT).toBe(0.25);
  });

  test("marketRevenueWeight(market) defaults to subscription preset", () => {
    expect(marketRevenueWeight("us")).toBe(SUBSCRIPTION_REVENUE_WEIGHT.us!);
    expect(marketRevenueWeight("jp")).toBe(SUBSCRIPTION_REVENUE_WEIGHT.jp!);
    expect(marketRevenueWeight("br")).toBe(SUBSCRIPTION_REVENUE_WEIGHT.br!);
    expect(marketRevenueWeight("id")).toBe(SUBSCRIPTION_REVENUE_WEIGHT.id!);
  });

  test("marketRevenueWeight(market) falls back to subscription default for unknown market", () => {
    expect(marketRevenueWeight("xx")).toBe(DEFAULT_SUBSCRIPTION_WEIGHT);
  });

  test("market lookup is case-insensitive", () => {
    expect(marketRevenueWeight("US")).toBe(marketRevenueWeight("us"));
    expect(marketRevenueWeight("ID")).toBe(marketRevenueWeight("id"));
  });
});

describe("category presets — subscription", () => {
  test("subscription preset matches v0.7 numbers exactly", () => {
    // Spot-check a sample of each tier.
    expect(SUBSCRIPTION_REVENUE_WEIGHT.us).toBe(5.5);
    expect(SUBSCRIPTION_REVENUE_WEIGHT.jp).toBe(3.5);
    expect(SUBSCRIPTION_REVENUE_WEIGHT.de).toBe(2.2);
    expect(SUBSCRIPTION_REVENUE_WEIGHT.br).toBe(0.25);
    expect(SUBSCRIPTION_REVENUE_WEIGHT.id).toBe(0.08);
  });

  test("subscription preset: tier-1 (US) >> tier-5 (ID) — 50× ratio", () => {
    const ratio = SUBSCRIPTION_REVENUE_WEIGHT.us! / SUBSCRIPTION_REVENUE_WEIGHT.id!;
    expect(ratio).toBeGreaterThan(50);
  });
});

describe("category presets — games", () => {
  test("games preset: JP > US (gaming heavyweight inversion)", () => {
    expect(GAMES_REVENUE_WEIGHT.jp).toBeGreaterThan(GAMES_REVENUE_WEIGHT.us!);
  });

  test("games preset: SEA markets non-zero (games convert in SEA)", () => {
    expect(GAMES_REVENUE_WEIGHT.id).toBeGreaterThan(0);
    expect(GAMES_REVENUE_WEIGHT.vn).toBeGreaterThan(0);
    expect(GAMES_REVENUE_WEIGHT.th).toBeGreaterThan(0);
  });

  test("games SEA weights > subscription SEA weights (games convert better in SEA)", () => {
    expect(GAMES_REVENUE_WEIGHT.id).toBeGreaterThan(SUBSCRIPTION_REVENUE_WEIGHT.id!);
    expect(GAMES_REVENUE_WEIGHT.th).toBeGreaterThan(SUBSCRIPTION_REVENUE_WEIGHT.th!);
  });

  test("marketRevenueWeight with 'games' preset", () => {
    expect(marketRevenueWeight("jp", "games")).toBe(GAMES_REVENUE_WEIGHT.jp!);
    expect(marketRevenueWeight("id", "games")).toBe(GAMES_REVENUE_WEIGHT.id!);
  });

  test("DEFAULT_GAMES_WEIGHT applied for unknown market", () => {
    expect(marketRevenueWeight("xx", "games")).toBe(DEFAULT_GAMES_WEIGHT);
  });
});

describe("category presets — ads", () => {
  test("ads preset: US still highest absolute, but lift over SEA much smaller", () => {
    const subRatio = SUBSCRIPTION_REVENUE_WEIGHT.us! / SUBSCRIPTION_REVENUE_WEIGHT.id!;
    const adsRatio = ADS_REVENUE_WEIGHT.us! / ADS_REVENUE_WEIGHT.id!;
    expect(subRatio).toBeGreaterThan(adsRatio);
  });

  test("ads preset: SEA markets weighted higher than subscription preset", () => {
    expect(ADS_REVENUE_WEIGHT.id).toBeGreaterThan(SUBSCRIPTION_REVENUE_WEIGHT.id!);
    expect(ADS_REVENUE_WEIGHT.vn).toBeGreaterThan(SUBSCRIPTION_REVENUE_WEIGHT.vn!);
  });

  test("marketRevenueWeight with 'ads' preset", () => {
    expect(marketRevenueWeight("us", "ads")).toBe(ADS_REVENUE_WEIGHT.us!);
    expect(marketRevenueWeight("ph", "ads")).toBe(ADS_REVENUE_WEIGHT.ph!);
  });

  test("DEFAULT_ADS_WEIGHT applied for unknown market", () => {
    expect(marketRevenueWeight("xx", "ads")).toBe(DEFAULT_ADS_WEIGHT);
  });
});

describe("REVENUE_WEIGHT_PRESETS registry", () => {
  test("registry has all three presets", () => {
    expect(Object.keys(REVENUE_WEIGHT_PRESETS).sort()).toEqual(["ads", "games", "subscription"]);
  });

  test("registry tables match exported constants", () => {
    expect(REVENUE_WEIGHT_PRESETS.subscription).toBe(SUBSCRIPTION_REVENUE_WEIGHT);
    expect(REVENUE_WEIGHT_PRESETS.games).toBe(GAMES_REVENUE_WEIGHT);
    expect(REVENUE_WEIGHT_PRESETS.ads).toBe(ADS_REVENUE_WEIGHT);
  });

  test("DEFAULT_PRESET_FALLBACKS matches exported defaults", () => {
    expect(DEFAULT_PRESET_FALLBACKS.subscription).toBe(DEFAULT_SUBSCRIPTION_WEIGHT);
    expect(DEFAULT_PRESET_FALLBACKS.games).toBe(DEFAULT_GAMES_WEIGHT);
    expect(DEFAULT_PRESET_FALLBACKS.ads).toBe(DEFAULT_ADS_WEIGHT);
  });
});

describe("cpi_ltv_proxy seed integration — every seed market is covered", () => {
  test("every market in CPI_LTV_ESTIMATES has at least a fallback in each preset", () => {
    // Either explicitly listed, or the preset default applies. The contract
    // is that marketRevenueWeight() always returns a finite number for any
    // market that appears in the cpi_ltv_proxy seed.
    const markets = new Set(CPI_LTV_ESTIMATES.map((e) => e.market));
    for (const m of markets) {
      for (const preset of ["subscription", "games", "ads"] as const) {
        const w = marketRevenueWeight(m, preset);
        expect(w, `non-finite weight for ${m}/${preset}`).toBeGreaterThan(0);
        expect(Number.isFinite(w)).toBe(true);
      }
    }
  });

  test("cpi_ltv_proxy seed markets (id/vn/th/my/ph/bd) are all known to subscription preset OR fall to default", () => {
    // Soft check: all 6 SEA markets should produce a meaningful weight.
    for (const m of ["id", "vn", "th", "my", "ph", "bd"]) {
      const w = marketRevenueWeight(m);
      expect(w).toBeGreaterThan(0);
    }
  });
});
