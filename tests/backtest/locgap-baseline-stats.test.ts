import { describe, expect, test } from "bun:test";
import {
  type BaselineRow,
  computeLocGapBaselineStats,
} from "../../src/backtest/locgap-baseline-stats.ts";

describe("computeLocGapBaselineStats", () => {
  test("computes pct_below_5 and mean_locgap per (market, t0)", () => {
    const rows = [
      { app_id: "a", market: "id", t: 1, value: 9 },
      { app_id: "b", market: "id", t: 1, value: 8 },
      { app_id: "c", market: "id", t: 1, value: 4 },
      { app_id: "d", market: "id", t: 1, value: 2 },
      { app_id: "e", market: "us", t: 1, value: 1 },
      { app_id: "f", market: "us", t: 1, value: 0 },
    ];
    const out = computeLocGapBaselineStats(rows, [1], ["id", "us"]);
    expect(out).toContainEqual<BaselineRow>({
      market: "id",
      t: 1,
      n: 4,
      mean_locgap: 5.75,
      pct_below_5: 0.5,
    });
    expect(out).toContainEqual<BaselineRow>({
      market: "us",
      t: 1,
      n: 2,
      mean_locgap: 0.5,
      pct_below_5: 1.0,
    });
  });

  test("missing (market, t) combination yields n=0 row", () => {
    const out = computeLocGapBaselineStats([], [1], ["id"]);
    expect(out).toEqual([{ market: "id", t: 1, n: 0, mean_locgap: 0, pct_below_5: 0 }]);
  });
});
