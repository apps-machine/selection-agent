/**
 * v1 velocity extension tests — covers the additions in src/velocity/smooth.ts
 * and src/velocity/v1-score.ts. The legacy delta.ts / snapshot.ts paths are
 * exercised by their own existing test files and are NOT touched here.
 *
 * Coverage:
 *   - 30d-smoothing: spike-day excluded
 *   - Top-200 grossing scope: rank > 200 ignored
 *   - Version bump persisted in signal_snapshots
 *   - N=0 days history → null
 *   - <7 days history → null
 *   - Happy path: steady 50-rank climb → score in 8-10 band
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../src/storage/schema.ts";
import { SPIKE_THRESHOLD, smoothRankSeries } from "../../src/velocity/smooth.ts";
import {
  computeAndPersistVelocityV1,
  computeVelocityScoreV1,
  MIN_DAYS_FOR_SIGNAL,
  normalizeRankDeltaToScore,
  persistVelocitySignal,
  SIGNAL_NAME,
  TOP_N,
  VELOCITY_VERSION,
} from "../../src/velocity/v1-score.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const T_NOW = 1_700_000_000_000; // arbitrary fixed unix-ms
const MARKET = "id";
const CATEGORY = "productivity";

function insertChartRow(
  db: Database,
  args: {
    app_id: string;
    captured_at: number;
    rank: number;
    market?: string;
    category?: string;
    source?: string;
  },
): void {
  db.prepare(
    "INSERT INTO chart_snapshots (market, category, captured_at, rank, app_id, source) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    args.market ?? MARKET,
    args.category ?? CATEGORY,
    args.captured_at,
    args.rank,
    args.app_id,
    args.source ?? "apple_rss",
  );
}

/** Seed `days` consecutive daily rank rows for one app, oldest → newest. */
function seedDailyRanks(
  db: Database,
  app_id: string,
  ranks: readonly number[],
  endT: number = T_NOW,
): void {
  for (let i = 0; i < ranks.length; i++) {
    const dayOffset = -(ranks.length - 1 - i); // i=0 → oldest
    insertChartRow(db, {
      app_id,
      captured_at: endT + dayOffset * DAY_MS,
      rank: ranks[i]!,
    });
  }
}

describe("smoothRankSeries — 30d smoothing", () => {
  test("spike day excluded when delta exceeds threshold both sides AND reverses", () => {
    // Per spec: deltas of [10, 5, 2, 90, 3, 4, 5] over 7 days; the 4th day's
    // 90-rank spike should be filtered.
    // Construct as ranks where consecutive diffs are those deltas. Start at
    // rank 100 to keep ranks positive after climbs.
    const ranks: number[] = [100];
    const deltas = [10, 5, 2, 90, 3, 4, 5];
    for (const d of deltas) {
      // Going DOWN in rank = climbing the chart; we'll just apply +/- and the
      // smoother detects abs delta vs both neighbors.
      ranks.push(ranks[ranks.length - 1]! + d);
    }
    // Now to make the 90-spike a true REVERSAL (so smoother kicks in), flip
    // its sign: replace one of the +90 with a value that creates a spike up
    // then back down on the same day. Reconstruct explicitly.
    //
    // Series: [100, 102, 104, 110, 200, 105, 109, 114]
    //                          ^ rank 200 is the spike (jump up 90, back down 95)
    const spikeSeries = [
      { t: T_NOW + 0 * DAY_MS, rank: 100 },
      { t: T_NOW + 1 * DAY_MS, rank: 102 },
      { t: T_NOW + 2 * DAY_MS, rank: 104 },
      { t: T_NOW + 3 * DAY_MS, rank: 110 },
      { t: T_NOW + 4 * DAY_MS, rank: 200 }, // SPIKE day
      { t: T_NOW + 5 * DAY_MS, rank: 105 },
      { t: T_NOW + 6 * DAY_MS, rank: 109 },
    ];

    const smoothed = smoothRankSeries(spikeSeries);

    // Spike day MUST be removed
    expect(smoothed.find((p) => p.rank === 200)).toBeUndefined();
    // Length reduced by exactly 1
    expect(smoothed.length).toBe(spikeSeries.length - 1);
    // Endpoints preserved
    expect(smoothed[0]?.rank).toBe(100);
    expect(smoothed[smoothed.length - 1]?.rank).toBe(109);
  });

  test("monotonic climb is NOT smoothed even when daily delta exceeds threshold", () => {
    // 100 → 5 over 5 days is a 95-rank improvement total; intermediate days
    // can have huge deltas but they don't REVERSE direction.
    const monotonic = [
      { t: 0, rank: 100 },
      { t: DAY_MS, rank: 80 },
      { t: 2 * DAY_MS, rank: 60 },
      { t: 3 * DAY_MS, rank: 40 },
      { t: 4 * DAY_MS, rank: 5 }, // 35-rank delta, no reversal
    ];
    const smoothed = smoothRankSeries(monotonic);
    expect(smoothed.length).toBe(monotonic.length);
  });

  test("series of ≤ 2 points returns input unchanged (can't detect spikes)", () => {
    expect(smoothRankSeries([])).toEqual([]);
    const one = [{ t: 0, rank: 50 }];
    expect(smoothRankSeries(one)).toEqual(one);
    const two = [
      { t: 0, rank: 50 },
      { t: DAY_MS, rank: 60 },
    ];
    expect(smoothRankSeries(two)).toEqual(two);
  });

  test("custom threshold respected", () => {
    // Small reversal of 30 each side should NOT smooth at default 80, but
    // SHOULD smooth at threshold 20.
    const series = [
      { t: 0, rank: 50 },
      { t: DAY_MS, rank: 50 },
      { t: 2 * DAY_MS, rank: 80 }, // up 30
      { t: 3 * DAY_MS, rank: 50 }, // down 30
      { t: 4 * DAY_MS, rank: 50 },
    ];
    expect(smoothRankSeries(series).length).toBe(series.length); // default 80, no spike
    expect(smoothRankSeries(series, { spikeThreshold: 20 }).length).toBe(series.length - 1);
  });

  test("spike threshold sentinel constant exposed", () => {
    expect(SPIKE_THRESHOLD).toBe(80);
  });

  test("rejects non-positive threshold", () => {
    expect(() => smoothRankSeries([], { spikeThreshold: 0 })).toThrow();
    expect(() => smoothRankSeries([], { spikeThreshold: -1 })).toThrow();
  });
});

describe("normalizeRankDeltaToScore — 0-10 bands", () => {
  test("improvement >= 50 → score in 8-10 band", () => {
    expect(normalizeRankDeltaToScore(50)).toBe(8);
    expect(normalizeRankDeltaToScore(75)).toBeCloseTo(9, 5);
    expect(normalizeRankDeltaToScore(100)).toBe(10);
    expect(normalizeRankDeltaToScore(200)).toBe(10); // capped
  });

  test("improvement 20-49 → score in 5-7 band", () => {
    expect(normalizeRankDeltaToScore(20)).toBe(5);
    expect(normalizeRankDeltaToScore(49)).toBeCloseTo(7, 5);
  });

  test("improvement 0-19 → score in 2-4 band", () => {
    expect(normalizeRankDeltaToScore(0)).toBe(2);
    expect(normalizeRankDeltaToScore(19)).toBeCloseTo(4, 5);
  });

  test("decline → score in 0-1 band", () => {
    // -1 just under 1, -50 → 0
    expect(normalizeRankDeltaToScore(-1)).toBeCloseTo(0.98, 2);
    expect(normalizeRankDeltaToScore(-50)).toBe(0);
    expect(normalizeRankDeltaToScore(-100)).toBe(0);
  });

  test("non-finite → 0 (safety)", () => {
    expect(normalizeRankDeltaToScore(Number.NaN)).toBe(0);
    expect(normalizeRankDeltaToScore(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("computeVelocityScoreV1 — happy + edge", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => db.close());

  test("happy path: steady 50-rank climb over 30 days → score in 8-10 band", () => {
    // 30 daily observations, linear rank descent from 60 to 10 (50-rank climb).
    const ranks: number[] = [];
    for (let i = 0; i < 30; i++) {
      ranks.push(Math.round(60 - (50 * i) / 29));
    }
    seedDailyRanks(db, "climber", ranks);

    const result = computeVelocityScoreV1(db, "climber", { clock: () => T_NOW });
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThanOrEqual(8);
    expect(result.score!).toBeLessThanOrEqual(10);
    expect(result.daysObserved).toBe(30);
  });

  test("N=0 days of history → returns null", () => {
    const result = computeVelocityScoreV1(db, "ghost", { clock: () => T_NOW });
    expect(result.score).toBeNull();
    expect(result.daysObserved).toBe(0);
  });

  test("< MIN_DAYS_FOR_SIGNAL days → returns null", () => {
    const ranks: number[] = [50, 48, 46, 44, 42, 40]; // 6 days
    seedDailyRanks(db, "tooyoung", ranks);
    const result = computeVelocityScoreV1(db, "tooyoung", { clock: () => T_NOW });
    expect(result.score).toBeNull();
    expect(result.daysObserved).toBe(6);
    expect(result.daysObserved).toBeLessThan(MIN_DAYS_FOR_SIGNAL);
  });

  test("exactly MIN_DAYS_FOR_SIGNAL days → returns score (boundary)", () => {
    const ranks: number[] = [50, 48, 46, 44, 42, 40, 38]; // 7 days
    seedDailyRanks(db, "boundary", ranks);
    const result = computeVelocityScoreV1(db, "boundary", { clock: () => T_NOW });
    expect(result.score).not.toBeNull();
    expect(result.daysObserved).toBe(7);
  });

  test("top-200 boundary: ranks > 200 are excluded from the series", () => {
    // Insert 250 chart rows for a single (market, category, day) — but only
    // ONE row per app per day actually matters for velocity; the test mirrors
    // the spec by inserting many rows per day, varying the app's rank.
    //
    // Concrete setup: app "topapp" has rank 150 every day for 30 days (within
    // top-200) AND rank 250 every day for 30 days (outside). The signal must
    // see only the rank-150 observations.
    for (let i = 0; i < 30; i++) {
      const t = T_NOW - i * DAY_MS;
      insertChartRow(db, {
        app_id: "topapp",
        captured_at: t,
        rank: 150,
        category: "productivity",
      });
      // Same app appearing in a different (category) at rank 250 — should be filtered out
      insertChartRow(db, {
        app_id: "topapp",
        captured_at: t,
        rank: 250,
        category: "lifestyle",
      });
    }
    const result = computeVelocityScoreV1(db, "topapp", { clock: () => T_NOW });
    expect(result.daysObserved).toBe(30);
    // Steady at rank 150 → improvement = 0 → score in 2-4 band, NOT 0
    expect(result.score).not.toBeNull();
    expect(result.score!).toBe(2);
  });

  test("top-N constant set to 200 per spec", () => {
    expect(TOP_N).toBe(200);
  });

  test("ranks > 250 stress: insert 250 rows for one (market, category, day) and verify cutoff", () => {
    // Spec wording: "Insert 250 chart_snapshots rows for one (market,
    // category, day). Verify the velocity scanner only considers ranks 1-200."
    const day = T_NOW;
    for (let r = 1; r <= 250; r++) {
      insertChartRow(db, {
        app_id: `app-${r}`,
        captured_at: day,
        rank: r,
      });
    }
    // Apps at ranks 1-200 should be queryable; 201+ filtered.
    // Pick app-180 (in window) and app-220 (out of window). Each only has one
    // day so won't satisfy MIN_DAYS_FOR_SIGNAL, but we're testing the SQL
    // filter, so verify daysObserved values.
    const inResult = computeVelocityScoreV1(db, "app-180", {
      clock: () => day,
      minDays: 1,
      windowDays: 1,
    });
    expect(inResult.daysObserved).toBe(1);

    const outResult = computeVelocityScoreV1(db, "app-220", {
      clock: () => day,
      minDays: 1,
      windowDays: 1,
    });
    expect(outResult.daysObserved).toBe(0);
  });

  test("custom topN respected", () => {
    insertChartRow(db, { app_id: "a", captured_at: T_NOW, rank: 150 });
    // Default topN=200 includes it
    const includes = computeVelocityScoreV1(db, "a", {
      clock: () => T_NOW,
      minDays: 1,
      windowDays: 1,
    });
    expect(includes.daysObserved).toBe(1);
    // Custom topN=100 excludes it
    const excludes = computeVelocityScoreV1(db, "a", {
      clock: () => T_NOW,
      minDays: 1,
      windowDays: 1,
      topN: 100,
    });
    expect(excludes.daysObserved).toBe(0);
  });

  test("decline scenario: app slid from rank 10 to rank 100 → score in 0-1 band", () => {
    const ranks: number[] = [];
    for (let i = 0; i < 14; i++) {
      ranks.push(Math.round(10 + (90 * i) / 13));
    }
    seedDailyRanks(db, "slider", ranks);
    const result = computeVelocityScoreV1(db, "slider", { clock: () => T_NOW });
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThanOrEqual(0);
    expect(result.score!).toBeLessThanOrEqual(1);
  });

  test("rejects non-positive options", () => {
    expect(() => computeVelocityScoreV1(db, "x", { windowDays: 0 })).toThrow();
    expect(() => computeVelocityScoreV1(db, "x", { topN: 0 })).toThrow();
    expect(() => computeVelocityScoreV1(db, "x", { minDays: 0 })).toThrow();
  });
});

describe("persistVelocitySignal — signal_snapshots provenance", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => db.close());

  test("writes a row with all LLM provenance columns NULL except prompt_version sentinel", () => {
    persistVelocitySignal(db, "a1", 7.5, T_NOW, { clock: () => T_NOW + 1 });

    const row = db
      .prepare<
        {
          app_id: string;
          signal_name: string;
          t: number;
          value: number | null;
          llm_model: string | null;
          llm_prompt_version: string;
          llm_request_hash: string | null;
          llm_response_hash: string | null;
          llm_response_archived: string | null;
          source_urls_json: string | null;
          computed_at: number;
        },
        []
      >("SELECT * FROM signal_snapshots WHERE signal_name = 'velocity'")
      .get();

    expect(row?.app_id).toBe("a1");
    expect(row?.signal_name).toBe("velocity");
    expect(row?.t).toBe(T_NOW);
    expect(row?.value).toBe(7.5);
    expect(row?.llm_model).toBeNull();
    expect(row?.llm_request_hash).toBeNull();
    expect(row?.llm_response_hash).toBeNull();
    expect(row?.llm_response_archived).toBeNull();
    expect(row?.source_urls_json).toBe("[]");
    expect(row?.llm_prompt_version).toBe(VELOCITY_VERSION);
    expect(row?.computed_at).toBe(T_NOW + 1);
  });

  test("null score is written as NULL value (not 0)", () => {
    persistVelocitySignal(db, "a2", null, T_NOW);
    const row = db
      .prepare<{ value: number | null }, []>(
        "SELECT value FROM signal_snapshots WHERE app_id='a2' AND signal_name='velocity'",
      )
      .get();
    expect(row?.value).toBeNull();
  });

  test("VELOCITY_VERSION bump creates a new row (PK includes prompt_version)", () => {
    persistVelocitySignal(db, "a3", 5.0, T_NOW, { version: "v1.0.0" });
    persistVelocitySignal(db, "a3", 6.0, T_NOW, { version: "v1.1.0" });
    const rows = db
      .prepare<{ value: number; llm_prompt_version: string }, []>(
        "SELECT value, llm_prompt_version FROM signal_snapshots WHERE app_id='a3' ORDER BY llm_prompt_version",
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.llm_prompt_version).toBe("v1.0.0");
    expect(rows[0]?.value).toBe(5.0);
    expect(rows[1]?.llm_prompt_version).toBe("v1.1.0");
    expect(rows[1]?.value).toBe(6.0);
  });

  test("signal_name constant is 'velocity'", () => {
    expect(SIGNAL_NAME).toBe("velocity");
  });

  test("VELOCITY_VERSION constant defined", () => {
    expect(VELOCITY_VERSION).toMatch(/^v\d+\.\d+\.\d+/);
    expect(VELOCITY_VERSION).toBe("v1.0.0");
  });
});

describe("computeAndPersistVelocityV1 — end-to-end", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => db.close());

  test("happy: computes score and persists to signal_snapshots in one shot", () => {
    const ranks: number[] = [];
    for (let i = 0; i < 30; i++) ranks.push(Math.round(60 - (50 * i) / 29));
    seedDailyRanks(db, "e2e", ranks);

    const result = computeAndPersistVelocityV1(db, "e2e", { clock: () => T_NOW });
    expect(result.score).not.toBeNull();

    const row = db
      .prepare<{ value: number; signal_name: string; llm_prompt_version: string }, []>(
        "SELECT value, signal_name, llm_prompt_version FROM signal_snapshots WHERE app_id='e2e'",
      )
      .get();
    expect(row?.signal_name).toBe(SIGNAL_NAME);
    expect(row?.value).toBe(result.score!);
    expect(row?.llm_prompt_version).toBe(VELOCITY_VERSION);
  });

  test("null score: persists a null value row (the absence is recorded)", () => {
    // No data → score null
    const result = computeAndPersistVelocityV1(db, "noop", { clock: () => T_NOW });
    expect(result.score).toBeNull();

    const row = db
      .prepare<{ value: number | null }, []>(
        "SELECT value FROM signal_snapshots WHERE app_id='noop'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row?.value).toBeNull();
  });
});
