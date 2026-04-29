// Per-market revenue weight (subscription / utility preset)
//
// Multiplies the rating x ratingsCount signal in revenue-estimator so that a
// US install signal counts ~22x a BR signal and ~70x an IN signal. Direction
// matters more than absolute values: ratios drive ranking.
//
// PRESET: subscription / utility apps (health/fitness, AI utilities, photo,
// productivity, lifestyle). Apps Machine's likely target niche. Game-heavy
// markets (JP/KR) are intentionally tuned for sub-app monetization, not games.
//
// Sources (calibrated 2026-04-29):
//   - Sensor Tower / Adjust 2023-2024 Japan + Korea reports
//   - Business of Apps app revenue 2023-2025 (BR, IN, ID, MX)
//   - Appfigures 2025 US consumer spend ($55.5B / 10B downloads ~ $5.5/install)
//   - RevenueCat 2025 State of Subscription Apps (NA/AU/JP top, LATAM/SEA bottom)
//   - TechCrunch 2025 India + IAP coverage
//
// Why these values differ from "blended public estimates":
//   - Blended ARPU mixes games (massive in JP/KR/CN) with subscriptions (NA-heavy).
//     For our subscription-clone niche, JP/KR over-count games and BR/IN are
//     way too high in blended numbers vs actual IAP per install.
//
// PHASE 1 TODO: split into category presets (subscription / games / ads) once
// we have first-app revenue data per market. Founder owns the table.
//
// Markets not listed fall back to DEFAULT_REVENUE_WEIGHT. Adding a market is a
// one-line edit; no scorer code changes needed.

export type MarketCode = string; // ISO 3166-1 alpha-2, lowercase

export const MARKET_REVENUE_WEIGHT: Readonly<Record<MarketCode, number>> = Object.freeze({
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

export const DEFAULT_REVENUE_WEIGHT = 0.25;

export function marketRevenueWeight(market: string): number {
  const key = market.toLowerCase();
  return MARKET_REVENUE_WEIGHT[key] ?? DEFAULT_REVENUE_WEIGHT;
}
