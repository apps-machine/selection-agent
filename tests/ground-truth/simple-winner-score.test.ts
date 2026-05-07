import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  computeSimpleWinnerScore,
  SIMPLE_WINNER_FORMULA_VERSION,
  WINNER_WINDOW_DAYS,
} from "../../src/ground-truth/simple-winner-score.ts";
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

describe("computeSimpleWinnerScore — boolean top-100 at t_measure ± 7d", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("app with rank=50 at t_measure → tier=winner, score=10", () => {
    const app = "winner.app";
    insertChart(db, { app_id: app, captured_at: T_MEASURE, rank: 50 });
    const result = computeSimpleWinnerScore(db, app, T0, T_MEASURE);
    expect(result).not.toBeNull();
    expect(result?.tier).toBe("winner");
    expect(result?.score).toBe(10);
  });

  test("app with rank=150 at t_measure (top-200 but NOT top-100) → tier=loser, score=0", () => {
    const app = "marginal.app";
    insertChart(db, { app_id: app, captured_at: T_MEASURE, rank: 150 });
    const result = computeSimpleWinnerScore(db, app, T0, T_MEASURE);
    expect(result).not.toBeNull();
    expect(result?.tier).toBe("loser");
    expect(result?.score).toBe(0);
  });

  test("app with chart data EARLIER but none in winner window → tier=loser, score=0", () => {
    // Has chart_snapshots at or before t_measure (so the existence guard
    // passes), but no rows within the ±7d window with rank ≤ 100.
    const app = "earlier.app";
    insertChart(db, { app_id: app, captured_at: T0, rank: 10 });
    insertChart(db, {
      app_id: app,
      captured_at: T_MEASURE - 60 * DAY_MS,
      rank: 50,
    });
    const result = computeSimpleWinnerScore(db, app, T0, T_MEASURE);
    expect(result).not.toBeNull();
    expect(result?.tier).toBe("loser");
    expect(result?.score).toBe(0);
  });

  test("app with NO chart_snapshots at all → null", () => {
    const result = computeSimpleWinnerScore(db, "ghost.app", T0, T_MEASURE);
    expect(result).toBeNull();
  });

  test("app with rank=99 at t_measure-3d (inside ±7d window) → tier=winner", () => {
    const app = "near.app";
    insertChart(db, {
      app_id: app,
      captured_at: T_MEASURE - 3 * DAY_MS,
      rank: 99,
    });
    const result = computeSimpleWinnerScore(db, app, T0, T_MEASURE);
    expect(result).not.toBeNull();
    expect(result?.tier).toBe("winner");
    expect(result?.score).toBe(10);
  });

  test("app with rank=99 at t_measure-14d (outside ±7d window) → tier=loser", () => {
    const app = "outside.app";
    insertChart(db, {
      app_id: app,
      captured_at: T_MEASURE - 14 * DAY_MS,
      rank: 99,
    });
    const result = computeSimpleWinnerScore(db, app, T0, T_MEASURE);
    expect(result).not.toBeNull();
    expect(result?.tier).toBe("loser");
    expect(result?.score).toBe(0);
  });

  test("persists row with formula_version=v1.0.0-simple", () => {
    const app = "persist.app";
    insertChart(db, { app_id: app, captured_at: T_MEASURE, rank: 50 });
    computeSimpleWinnerScore(db, app, T0, T_MEASURE);
    const row = db
      .prepare<{ formula_version: string; score: number; tier: string }, [string, number]>(
        "SELECT formula_version, score, tier FROM winner_scores WHERE app_id = ? AND t0 = ?",
      )
      .get(app, T0);
    expect(row?.formula_version).toBe(SIMPLE_WINNER_FORMULA_VERSION);
    expect(row?.formula_version).toBe("v1.0.0-simple");
    expect(row?.score).toBe(10);
    expect(row?.tier).toBe("winner");
  });

  test("WINNER_WINDOW_DAYS exported and equals 7", () => {
    expect(WINNER_WINDOW_DAYS).toBe(7);
  });

  test("rank=100 exactly (boundary) at t_measure → tier=winner", () => {
    const app = "boundary.app";
    insertChart(db, { app_id: app, captured_at: T_MEASURE, rank: 100 });
    const result = computeSimpleWinnerScore(db, app, T0, T_MEASURE);
    expect(result?.tier).toBe("winner");
    expect(result?.score).toBe(10);
  });

  test("app appears at t_measure+7d (boundary on the right) → tier=winner", () => {
    const app = "right-boundary.app";
    // Need at-or-before-t_measure data to satisfy existence guard, then
    // a top-100 row at t_measure+7d (within window).
    insertChart(db, { app_id: app, captured_at: T0, rank: 200 });
    insertChart(db, {
      app_id: app,
      captured_at: T_MEASURE + WINNER_WINDOW_DAYS * DAY_MS,
      rank: 50,
    });
    const result = computeSimpleWinnerScore(db, app, T0, T_MEASURE);
    expect(result?.tier).toBe("winner");
    expect(result?.score).toBe(10);
  });
});
