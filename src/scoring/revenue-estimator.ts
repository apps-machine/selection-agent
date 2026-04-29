import { marketRevenueWeight } from "./market-revenue-weight.ts";

export interface RevenueScoreInput {
  rating: number | null;
  ratingsCount: number | null;
  market: string;
}

// Map signal (rating x ratingsCount x ARPU) to a 0-10 log-scaled score.
//   - BASELINE: signal below this maps to ~0 (small indie apps with negligible revenue proxy)
//   - MAX: signal at/above this maps to 10 (blockbuster apps)
// Tuned against:
//   - "indie": 500 ratings, 4.0 stars, US (signal ~7k) -> low (<=4)
//   - "blockbuster": 5M ratings, 4.7 stars, US (signal ~82M) -> high (>=8)
const BASELINE_SIGNAL = 100;
const MAX_SIGNAL = 1e8;

const LOG_BASELINE = Math.log10(BASELINE_SIGNAL);
const LOG_MAX = Math.log10(MAX_SIGNAL);
const LOG_RANGE = LOG_MAX - LOG_BASELINE;

export function scoreRevenue(input: RevenueScoreInput): number {
  const { rating, ratingsCount, market } = input;
  if (rating === null || ratingsCount === null) return 0;
  // Defensive: scrapers may return NaN for new apps with no signal yet. Without
  // this guard, NaN propagates through composite and corrupts the entire ranking.
  if (!Number.isFinite(rating) || !Number.isFinite(ratingsCount)) return 0;
  if (ratingsCount <= 0) return 0;

  const signal = rating * ratingsCount * marketRevenueWeight(market);
  if (!Number.isFinite(signal) || signal <= 0) return 0;

  const logSignal = Math.log10(signal + 1);
  const raw = ((logSignal - LOG_BASELINE) / LOG_RANGE) * 10;
  return Math.max(0, Math.min(10, raw));
}
