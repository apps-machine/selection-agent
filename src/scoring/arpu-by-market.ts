// ARPU per market (USD/install, all-app blended estimate)
//
// Source: blended public estimates 2024-2025 (Sensor Tower, data.ai, Statista
// global mobile spend / install reports). Numbers are rough and only used as a
// proxy weight in revenue-estimator: a US install signal counts ~10x a BR
// install signal when ranking opportunity size.
//
// FOUNDER REVIEW NEEDED at PR confirmation:
//   - Validate values reflect the markets we plan to target, OR
//   - Drop regional weighting entirely (set every value to 1.0) and rely on
//     rating x ratingsCount only. Both modes are supported by revenue-estimator.
//
// Markets not listed fall back to DEFAULT_ARPU. Adding a market is a one-line
// edit; no scorer code changes needed.

export type MarketCode = string; // ISO 3166-1 alpha-2, lowercase

export const ARPU_BY_MARKET: Readonly<Record<MarketCode, number>> = Object.freeze({
  // Tier 1 — high spend
  us: 3.5,
  jp: 3.2,
  au: 2.9,
  gb: 2.8,
  ca: 2.6,
  kr: 2.5,
  de: 2.2,
  fr: 2.1,
  no: 2.1,
  se: 2.0,
  ch: 2.4,
  nl: 2.0,
  // Tier 2 — mid spend
  it: 1.6,
  es: 1.5,
  ie: 2.0,
  be: 1.9,
  at: 2.0,
  dk: 2.1,
  fi: 1.9,
  nz: 2.5,
  sg: 2.3,
  hk: 2.2,
  tw: 1.7,
  // Tier 3 — emerging
  br: 0.45,
  mx: 0.55,
  ar: 0.4,
  cl: 0.6,
  co: 0.4,
  pl: 0.9,
  cz: 0.95,
  hu: 0.85,
  ro: 0.7,
  pt: 1.3,
  gr: 1.0,
  tr: 0.4,
  ru: 0.5,
  // Tier 4 — large pop, low ARPU (still relevant for scale)
  in: 0.3,
  id: 0.35,
  ph: 0.4,
  vn: 0.35,
  th: 0.55,
  my: 0.7,
  za: 0.5,
  ng: 0.2,
  eg: 0.25,
  sa: 1.5,
  ae: 1.8,
  il: 1.7,
  cn: 1.2, // Apple App Store only; Google Play unavailable in CN
});

export const DEFAULT_ARPU = 0.5;

export function arpuForMarket(market: string): number {
  const key = market.toLowerCase();
  return ARPU_BY_MARKET[key] ?? DEFAULT_ARPU;
}
