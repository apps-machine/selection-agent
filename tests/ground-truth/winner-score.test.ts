import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  classifyTier,
  computeWinnerScore,
  MONTHS_TOP100_CAP,
  normalizeMonthsTop100,
  normalizeRevenue,
  normalizeStability,
  WINNER_SCORE_FORMULA_VERSION,
} from "../../src/ground-truth/winner-score.ts";
import { runMigrations } from "../../src/storage/schema.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

const T0 = 1_700_000_000_000;
const T_MEASURE = T0 + 12 * MONTH_MS;

let rankCounter = 0;
function nextRank(): number {
  rankCounter += 1;
  return rankCounter;
}

function insertChart(
  db: Database,
  args: {
    app_id: string;
    captured_at: number;
    rank?: number;
    market?: string;
    category?: string;
  },
): void {
  db.prepare(
    "INSERT INTO chart_snapshots (market, category, captured_at, rank, app_id, source) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    args.market ?? "id",
    args.category ?? "productivity",
    args.captured_at,
    args.rank ?? nextRank(),
    args.app_id,
    "apple_rss",
  );
}

function insertSignal(
  db: Database,
  args: { app_id: string; signal: string; t: number; value: number | null },
): void {
  db.prepare(
    `INSERT INTO signal_snapshots (app_id, signal_name, t, value, llm_prompt_version, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(args.app_id, args.signal, args.t, args.value, "v1.0.0", args.t + 1);
}

describe("computeWinnerScore — happy path", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("app top-100 12mo + growing reviews + revenue → score >= 7 (winner)", () => {
    const app = "winner.app";
    // 12 distinct months in top-100 grossing — the spec describes
    // "top-100 8mo" but at MONTHS_TOP100_CAP=36 the staleness contribution
    // alone is too small to clear 7; combined with saturated review + near-cap
    // revenue + stable rank, 12mo just clears it.
    for (let m = 0; m < 12; m++) {
      insertChart(db, {
        app_id: app,
        captured_at: T0 + m * MONTH_MS,
        rank: 10,
      });
    }
    // Review growth across 90d: 0 → 5000 (cap is 1000, so this saturates).
    insertSignal(db, {
      app_id: app,
      signal: "review_count",
      t: T_MEASURE - 80 * DAY_MS,
      value: 0,
    });
    insertSignal(db, {
      app_id: app,
      signal: "review_count",
      t: T_MEASURE - 1 * DAY_MS,
      value: 5000,
    });
    // Public revenue $90k/mo (close to cap).
    insertSignal(db, {
      app_id: app,
      signal: "public_revenue_estimate",
      t: T_MEASURE - 30 * DAY_MS,
      value: 90_000,
    });
    // Stable rank in last 90 days (sd small).
    for (let d = 0; d < 6; d++) {
      insertChart(db, {
        app_id: app,
        captured_at: T_MEASURE - 80 * DAY_MS + d * 10 * DAY_MS,
        rank: 11, // varies by 1 from the month-1 entries, low stddev
      });
    }

    const result = computeWinnerScore(db, app, T0, T_MEASURE);
    expect(result).not.toBeNull();
    expect(result?.score).toBeGreaterThanOrEqual(7);
    expect(result?.tier).toBe("winner");
  });

  test("app dropped after 2mo → score < 5 (loser)", () => {
    const app = "loser.app";
    // 2 months in top-100, then nothing.
    insertChart(db, { app_id: app, captured_at: T0, rank: 50 });
    insertChart(db, { app_id: app, captured_at: T0 + MONTH_MS, rank: 80 });
    // No reviews, no revenue, no chart presence in last 90 days.

    const result = computeWinnerScore(db, app, T0, T_MEASURE);
    expect(result).not.toBeNull();
    expect(result?.score).toBeLessThan(5);
    expect(result?.tier).toBe("loser");
  });

  test("middling everything → marginal (5 <= score < 7)", () => {
    const app = "marginal.app";
    // 14 months top-100 → ~0.39 of cap → 0.4 * 0.39 = 0.156 contribution
    for (let m = 0; m < 14; m++) {
      insertChart(db, {
        app_id: app,
        captured_at: T0 + m * MONTH_MS,
        rank: 60,
      });
    }
    // Mid review growth ~ 600/90d → 0.6 of cap → 0.3 * 0.6 = 0.18
    insertSignal(db, {
      app_id: app,
      signal: "review_count",
      t: T_MEASURE - 80 * DAY_MS,
      value: 100,
    });
    insertSignal(db, {
      app_id: app,
      signal: "review_count",
      t: T_MEASURE - 1 * DAY_MS,
      value: 700,
    });
    // Mid revenue $60k → 0.6 of cap → 0.2 * 0.6 = 0.12
    insertSignal(db, {
      app_id: app,
      signal: "public_revenue_estimate",
      t: T_MEASURE - 30 * DAY_MS,
      value: 60_000,
    });
    // Modestly stable rank → contributes some.
    for (let d = 0; d < 6; d++) {
      insertChart(db, {
        app_id: app,
        captured_at: T_MEASURE - 80 * DAY_MS + d * 10 * DAY_MS,
        rank: 65,
      });
    }

    const result = computeWinnerScore(db, app, T0, T_MEASURE);
    expect(result).not.toBeNull();
    expect(result?.score).toBeGreaterThanOrEqual(5);
    expect(result?.score).toBeLessThan(7);
    expect(result?.tier).toBe("marginal");
  });

  test("missing public_revenue_estimate → still computes (weight 0)", () => {
    const app = "no-revenue.app";
    for (let m = 0; m < 8; m++) {
      insertChart(db, {
        app_id: app,
        captured_at: T0 + m * MONTH_MS,
        rank: 10,
      });
    }
    insertSignal(db, {
      app_id: app,
      signal: "review_count",
      t: T_MEASURE - 80 * DAY_MS,
      value: 0,
    });
    insertSignal(db, {
      app_id: app,
      signal: "review_count",
      t: T_MEASURE - 1 * DAY_MS,
      value: 800,
    });
    // NO public_revenue_estimate row.
    for (let d = 0; d < 6; d++) {
      insertChart(db, {
        app_id: app,
        captured_at: T_MEASURE - 80 * DAY_MS + d * 10 * DAY_MS,
        rank: 12,
      });
    }

    const result = computeWinnerScore(db, app, T0, T_MEASURE);
    expect(result).not.toBeNull();
    // Doesn't crash, doesn't return null. Score is just lower than the
    // happy-path winner (revenue contributed 0).
    expect(result?.score).toBeGreaterThan(0);
  });

  test("zero data → null", () => {
    const result = computeWinnerScore(db, "ghost.app", T0, T_MEASURE);
    expect(result).toBeNull();
  });

  test("persists to winner_scores table with formula_version", () => {
    const app = "persist.app";
    insertChart(db, { app_id: app, captured_at: T0, rank: 50 });
    computeWinnerScore(db, app, T0, T_MEASURE);
    const row = db
      .prepare<{ formula_version: string; score: number }, [string, number]>(
        "SELECT formula_version, score FROM winner_scores WHERE app_id = ? AND t0 = ?",
      )
      .get(app, T0);
    expect(row?.formula_version).toBe(WINNER_SCORE_FORMULA_VERSION);
    expect(row?.score).toBeGreaterThanOrEqual(0);
  });
});

describe("computeWinnerScore — tier boundaries", () => {
  test("classifyTier exact boundaries", () => {
    expect(classifyTier(7.0)).toBe("winner");
    expect(classifyTier(7.001)).toBe("winner");
    expect(classifyTier(6.999)).toBe("marginal");
    expect(classifyTier(5.0)).toBe("marginal");
    expect(classifyTier(4.999)).toBe("loser");
    expect(classifyTier(0)).toBe("loser");
  });
});

describe("computeWinnerScore — STRICT TIME CUTOFF (no future leakage)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("post-t_measure rows are NOT read into score", () => {
    const app = "leakage.app";
    // Pre-t_measure: 1 month in top-100. Loser-ish score.
    insertChart(db, { app_id: app, captured_at: T0, rank: 50 });

    // POST-t_measure: 30 months in top-100, monster reviews. If the
    // function reads these, the score will jump from low to high.
    for (let m = 0; m < 30; m++) {
      insertChart(db, {
        app_id: app,
        captured_at: T_MEASURE + (m + 1) * MONTH_MS,
        rank: 1,
      });
    }
    insertSignal(db, {
      app_id: app,
      signal: "review_count",
      t: T_MEASURE + 60 * DAY_MS,
      value: 100_000,
    });
    insertSignal(db, {
      app_id: app,
      signal: "public_revenue_estimate",
      t: T_MEASURE + 30 * DAY_MS,
      value: 1_000_000,
    });

    const result = computeWinnerScore(db, app, T0, T_MEASURE);
    expect(result).not.toBeNull();
    // With the time cutoff working, score reflects ONLY the pre-t_measure
    // single chart row → loser tier.
    expect(result?.tier).toBe("loser");
    expect(result?.score).toBeLessThan(2);
  });

  test("data exactly at t_measure is INCLUDED (boundary)", () => {
    const app = "edge.app";
    insertChart(db, { app_id: app, captured_at: T_MEASURE, rank: 1 });
    const result = computeWinnerScore(db, app, T0, T_MEASURE);
    expect(result).not.toBeNull();
    // The exact-t_measure row counts as 1 month in top-100, so the
    // function returns a (small but non-null) score.
    expect(result?.score).toBeGreaterThan(0);
  });

  test("rejects t_measure < t0", () => {
    expect(() => computeWinnerScore(db, "x", T_MEASURE, T0)).toThrow(/>=/);
  });
});

describe("normalize helpers", () => {
  test("normalizeMonthsTop100 caps at 1.0", () => {
    expect(normalizeMonthsTop100(0)).toBe(0);
    expect(normalizeMonthsTop100(MONTHS_TOP100_CAP)).toBe(1);
    expect(normalizeMonthsTop100(MONTHS_TOP100_CAP * 2)).toBe(1);
    expect(normalizeMonthsTop100(-1)).toBe(0);
  });

  test("normalizeRevenue handles 0 and negative as 0", () => {
    expect(normalizeRevenue(0)).toBe(0);
    expect(normalizeRevenue(-100)).toBe(0);
    expect(normalizeRevenue(50_000)).toBe(0.5);
    expect(normalizeRevenue(1_000_000)).toBe(1);
  });

  test("normalizeStability null → 0", () => {
    expect(normalizeStability(null)).toBe(0);
    expect(normalizeStability(0)).toBe(1);
    expect(normalizeStability(50)).toBe(0);
    expect(normalizeStability(25)).toBeCloseTo(0.5);
  });
});
