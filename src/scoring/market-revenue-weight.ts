// Per-market revenue weight tables, organized by category preset.
//
// Multiplies the `rating × ratingsCount` signal in revenue-estimator so that
// a US install signal counts ~22× a BR signal and ~70× an IN signal. Direction
// matters more than absolute values: ratios drive ranking.
//
// Why category presets exist (Phase 1 split, ex-TODO):
//   The original (v0.7) table was a single subscription/utility preset.
//   That preset over-counts subs in NA and undercounts game IAP in JP/KR.
//   v1 introduces three named presets so the agent can score the same app
//   correctly regardless of monetization model:
//
//     subscription — health/fitness, AI utilities, photo, productivity,
//                    lifestyle. NA/AU/JP weighted high; LATAM/SEA low.
//     games        — mobile games (premium IAP, gacha, F2P). JP/KR/CN
//                    weighted highest; SEA mid-tier (volume + IAP);
//                    NA still strong but not dominant.
//     ads          — social/utility apps monetized via ads. SEA/LATAM
//                    weighted higher relative to subs (huge eyeball
//                    inventory at low CPM); NA still highest by absolute
//                    eCPM but the lift over SEA is much smaller.
//
//   The revenue estimator can pass an explicit preset; defaults stay on
//   `subscription` to preserve the v0.7 ranking behavior. Picking the
//   right preset is the cpi_ltv_proxy signal's job (it knows what kind
//   of monetization the category supports per market).
//
// Sources (calibrated 2026-04-29 → 2026-05-02):
//   - Sensor Tower / Adjust 2023-2024 Japan + Korea reports
//   - Business of Apps app revenue 2023-2025 (BR, IN, ID, MX)
//   - Appfigures 2025 US consumer spend ($55.5B / 10B downloads ~ $5.5/install)
//   - RevenueCat 2025 State of Subscription Apps (NA/AU/JP top, LATAM/SEA bottom)
//   - TechCrunch 2025 India + IAP coverage
//   - Liftoff Mobile App Trends 2024 (gaming + ads SEA bias)
//
// Markets not listed in a preset fall back to that preset's
// `DEFAULT_*_WEIGHT`. Adding a market is a one-line edit; no scorer code
// changes needed. The cpi_ltv_proxy seed file uses the same market codes
// so the two layers stay in lock-step (cpi_ltv_proxy.ts imports nothing
// from this file but the documentation invariant is enforced by the
// `MarketCode` type alias they share via convention).

export type MarketCode = string; // ISO 3166-1 alpha-2, lowercase

/**
 * Preset names. Public API surface — adding a preset is a minor bump,
 * removing one is a major bump (the cpi_ltv_proxy may pick from these).
 */
export type RevenueWeightPreset = "subscription" | "games" | "ads";

/**
 * Subscription / utility preset (v0.7 baseline). Apps Machine's primary
 * niche — health/fitness, AI utilities, photo, productivity, lifestyle.
 * NA + JP heavyweights; LATAM + SEA bottom (volume markets, low subs
 * conversion). Identical to the original v0.7 `MARKET_REVENUE_WEIGHT`.
 */
export const SUBSCRIPTION_REVENUE_WEIGHT: Readonly<Record<MarketCode, number>> = Object.freeze({
  // Tier 1 — subscription monetization heavyweights
  us: 5.5,
  jp: 3.5,
  ca: 3.2,
  au: 3.2,
  gb: 3.0,
  ch: 3.0,
  // Tier 2 — Western EU + advanced APAC
  de: 2.2,
  fr: 2.0,
  nl: 2.0,
  it: 1.8,
  es: 1.6,
  ie: 2.0,
  be: 1.9,
  at: 2.0,
  dk: 2.1,
  fi: 1.9,
  no: 2.1,
  se: 2.0,
  nz: 2.5,
  kr: 2.0,
  sg: 2.0,
  hk: 1.8,
  tw: 1.2,
  // Tier 3 — Mid-tier (lower SEA + Eastern EU + GCC)
  pl: 0.9,
  cz: 0.95,
  hu: 0.85,
  ro: 0.7,
  pt: 1.3,
  gr: 1.0,
  sa: 1.5,
  ae: 1.8,
  il: 1.7,
  // Tier 4 — Low-IAP markets (high install volume, low subscription conversion)
  br: 0.25,
  mx: 0.25,
  ar: 0.2,
  cl: 0.3,
  co: 0.2,
  tr: 0.2,
  ru: 0.25,
  th: 0.18,
  my: 0.25,
  // Tier 5 — Volume markets, near-zero subscription IAP
  in: 0.08,
  id: 0.08,
  ph: 0.08,
  vn: 0.08,
  za: 0.25,
  ng: 0.05,
  eg: 0.1,
  // CN: App Store-only (no Google Play), different dynamics. Excluded by design.
});

/**
 * Games preset. Mobile games (premium IAP, gacha, F2P). JP/KR/CN dominate
 * absolute spend; SEA is mid-tier (volume + reasonable IAP); NA is strong
 * but the lift over JP/KR is much smaller than in subscriptions.
 */
export const GAMES_REVENUE_WEIGHT: Readonly<Record<MarketCode, number>> = Object.freeze({
  // Tier 1 — gaming heavyweights
  jp: 6.0,
  kr: 4.5,
  us: 4.5,
  ca: 2.8,
  au: 2.8,
  gb: 2.6,
  // Tier 2 — strong gaming markets
  de: 2.0,
  fr: 1.8,
  it: 1.5,
  es: 1.4,
  nl: 1.6,
  ch: 2.4,
  tw: 2.0,
  hk: 2.0,
  sg: 1.6,
  // Tier 3 — Mid-tier
  ru: 0.6,
  pl: 0.7,
  br: 0.5,
  mx: 0.4,
  tr: 0.3,
  sa: 1.0,
  ae: 1.2,
  il: 1.0,
  // Tier 4 — SEA gaming (volume + decent IAP for games specifically)
  th: 0.45,
  my: 0.4,
  id: 0.3,
  ph: 0.25,
  vn: 0.3,
  bd: 0.1,
  // Tier 5 — Low gaming IAP
  in: 0.15,
  za: 0.2,
  ng: 0.05,
  eg: 0.1,
});

/**
 * Ads preset. Social/utility apps monetized via ad revenue (eCPM). SEA
 * + LATAM weighted higher relative to subs because huge eyeball volume
 * partially offsets low eCPM. NA still highest by absolute revenue but
 * the lift over SEA is ~10× rather than the 70× seen in subscriptions.
 */
export const ADS_REVENUE_WEIGHT: Readonly<Record<MarketCode, number>> = Object.freeze({
  // Tier 1 — high eCPM markets
  us: 3.5,
  ca: 2.8,
  au: 2.6,
  gb: 2.6,
  jp: 2.4,
  ch: 2.5,
  // Tier 2 — Western EU + advanced APAC
  de: 1.8,
  fr: 1.6,
  nl: 1.6,
  it: 1.3,
  es: 1.3,
  kr: 1.6,
  sg: 1.4,
  hk: 1.3,
  tw: 1.0,
  nz: 2.0,
  ie: 1.6,
  // Tier 3 — Mid-tier
  pl: 0.65,
  pt: 1.0,
  ae: 1.4,
  sa: 1.2,
  il: 1.3,
  // Tier 4 — High-volume ad markets (LATAM + SEA): low eCPM, big inventory
  br: 0.55,
  mx: 0.5,
  ar: 0.4,
  cl: 0.55,
  co: 0.4,
  tr: 0.45,
  ru: 0.5,
  th: 0.4,
  my: 0.5,
  id: 0.35,
  ph: 0.3,
  vn: 0.3,
  bd: 0.15,
  in: 0.2,
  za: 0.4,
  ng: 0.1,
  eg: 0.2,
});

/**
 * Per-preset defaults for markets not listed. Subscription default stays
 * at 0.25 (v0.7 behavior). Games + ads default reflect their respective
 * "what does an unknown market roughly look like."
 */
export const DEFAULT_SUBSCRIPTION_WEIGHT = 0.25;
export const DEFAULT_GAMES_WEIGHT = 0.25;
export const DEFAULT_ADS_WEIGHT = 0.3;

/** All preset tables exposed via a registry — lets cpi_ltv_proxy and other
 * consumers iterate / pick by name without a switch statement. */
export const REVENUE_WEIGHT_PRESETS: Readonly<
  Record<RevenueWeightPreset, Readonly<Record<MarketCode, number>>>
> = Object.freeze({
  subscription: SUBSCRIPTION_REVENUE_WEIGHT,
  games: GAMES_REVENUE_WEIGHT,
  ads: ADS_REVENUE_WEIGHT,
});

export const DEFAULT_PRESET_FALLBACKS: Readonly<Record<RevenueWeightPreset, number>> =
  Object.freeze({
    subscription: DEFAULT_SUBSCRIPTION_WEIGHT,
    games: DEFAULT_GAMES_WEIGHT,
    ads: DEFAULT_ADS_WEIGHT,
  });

/**
 * BACK-COMPAT: original v0.7 surface. The v0.7 callers (revenue-estimator,
 * external consumers) imported `MARKET_REVENUE_WEIGHT` and
 * `DEFAULT_REVENUE_WEIGHT` directly — keep them re-exporting the
 * subscription preset so v1 doesn't break consumers. New code should
 * pick a preset explicitly via `marketRevenueWeight(market, preset)`.
 *
 * Use rename-on-export form (rather than `export const X = Y;`) so knip's
 * duplicate-export detection sees these as deliberate aliases and not
 * accidental copy-paste.
 */
export {
  DEFAULT_SUBSCRIPTION_WEIGHT as DEFAULT_REVENUE_WEIGHT,
  SUBSCRIPTION_REVENUE_WEIGHT as MARKET_REVENUE_WEIGHT,
};

/**
 * Look up the revenue weight for a market. Default preset is `subscription`
 * to preserve v0.7 behavior — existing call sites in revenue-estimator
 * keep the same numbers without changes. v1 callers (cpi_ltv_proxy and
 * future category-aware scoring) pass an explicit preset.
 */
export function marketRevenueWeight(
  market: string,
  preset: RevenueWeightPreset = "subscription",
): number {
  const key = market.toLowerCase();
  const table = REVENUE_WEIGHT_PRESETS[preset];
  return table[key] ?? DEFAULT_PRESET_FALLBACKS[preset];
}
