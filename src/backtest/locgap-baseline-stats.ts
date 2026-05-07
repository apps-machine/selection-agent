/**
 * locGap baseline stats per (market, t0) — sanity check before backtest.
 *
 * Pure function: takes a flat list of {app_id, market, t, value} signal rows
 * and the (markets, t0s) grid we care about, returns one row per (market, t0)
 * with mean_locgap and pct_below_5 (the "non-localized rate" used in M7.5).
 *
 * Hypothesis from M7.5 (validate via this output):
 *   - SEA markets (id/vn/th/my/bd) at any t0 → pct_below_5 in [0.4, 0.8].
 *   - tier-1 markets (us/jp/kr/br/mx) at any t0 → pct_below_5 < 0.15.
 *
 * If the data contradicts the hypothesis, the experimental design is broken
 * and the backtest verdict won't be trustworthy — fix the LLM judge prompt
 * or the underlying records before running the backtest.
 */
export interface SignalRow {
  app_id: string;
  market: string;
  t: number;
  value: number;
}

export interface BaselineRow {
  market: string;
  t: number;
  n: number;
  mean_locgap: number;
  pct_below_5: number;
}

const NON_LOCALIZED_THRESHOLD = 5;

export function computeLocGapBaselineStats(
  rows: readonly SignalRow[],
  t0s: readonly number[],
  markets: readonly string[],
): BaselineRow[] {
  const out: BaselineRow[] = [];
  for (const market of markets) {
    for (const t of t0s) {
      const matched = rows.filter((r) => r.market === market && r.t === t);
      if (matched.length === 0) {
        out.push({ market, t, n: 0, mean_locgap: 0, pct_below_5: 0 });
        continue;
      }
      const sum = matched.reduce((a, r) => a + r.value, 0);
      const below = matched.filter((r) => r.value < NON_LOCALIZED_THRESHOLD).length;
      out.push({
        market,
        t,
        n: matched.length,
        mean_locgap: sum / matched.length,
        pct_below_5: below / matched.length,
      });
    }
  }
  return out;
}
