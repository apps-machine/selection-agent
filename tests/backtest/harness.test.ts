/**
 * Backtest harness tests — the critical safety net for the v1 ranker.
 *
 * Test priorities (all GAPs from agent-v1-foundation.md test plan):
 *   1. precision@K math correct on synthetic data (the headline metric)
 *   2. lift over locGap-only baseline reported (Codex Round 1 #7 fix)
 *   3. ★ LEAKAGE TEST CRITICAL ★ — post-t0 trap row never enters ranking
 *   4. reproducibility — same DB ⇒ same BacktestReport
 *   5. eligibility — apps with N<3 signals excluded from ranking
 *   6. empty cohort → zero-padded report (no throw)
 *   7. t_measure defaults to t0 + 12mo when unspecified
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type BacktestOptions,
  DEFAULT_K_VALUES,
  LIFT_INFINITY_SENTINEL,
  renderBacktestReportMarkdown,
  runBacktest,
} from "../../src/backtest/harness.ts";
import type { OpportunityMarket } from "../../src/opportunities/schema.ts";
import { runMigrations } from "../../src/storage/schema.ts";

const T0 = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;
const T_MEASURE = T0 + 12 * MONTH_MS;
const MARKET: OpportunityMarket = "id";

let chartRankCounter = 0;
function nextRank(): number {
  chartRankCounter += 1;
  return chartRankCounter;
}

interface InsertChartArgs {
  app_id: string;
  captured_at: number;
  market?: string;
  category?: string;
}

function insertChart(db: Database, args: InsertChartArgs): void {
  db.prepare(
    "INSERT INTO chart_snapshots (market, category, captured_at, rank, app_id, source) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    args.market ?? MARKET,
    args.category ?? "productivity",
    args.captured_at,
    nextRank(),
    args.app_id,
    "apple_rss",
  );
}

interface InsertSignalArgs {
  app_id: string;
  signal: string;
  t: number;
  value: number | null;
  prompt_version?: string;
  llm_model?: string | null;
  llm_response_archived?: string | null;
}

function insertSignal(db: Database, args: InsertSignalArgs): void {
  db.prepare(
    `INSERT INTO signal_snapshots (
       app_id, signal_name, t, value,
       llm_model, llm_prompt_version, llm_request_hash, llm_response_hash,
       llm_response_archived, source_urls_json, computed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.app_id,
    args.signal,
    args.t,
    args.value,
    args.llm_model ?? null,
    args.prompt_version ?? "v1.0.0",
    null,
    null,
    args.llm_response_archived ?? null,
    null,
    args.t + 1,
  );
}

function insertWinnerScore(
  db: Database,
  args: { app_id: string; t0: number; t_measure: number; tier: "winner" | "marginal" | "loser" },
): void {
  db.prepare(
    `INSERT INTO winner_scores
       (app_id, t0, measured_at, score, tier, formula_version, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.app_id,
    args.t0,
    args.t_measure,
    args.tier === "winner" ? 8.0 : args.tier === "marginal" ? 6.0 : 3.0,
    args.tier,
    "v1.0.0",
    args.t_measure + 1,
  );
}

/**
 * Plant 4 v1 signals (all non-null) for an app at a single timestamp. Wraps
 * 4 insertSignal calls so individual tests stay readable.
 */
function plantFullSignalSet(
  db: Database,
  args: {
    app_id: string;
    t: number;
    locGap: number;
    velocity: number;
    incumbent_vulnerability: number;
    cpi_ltv_proxy: number;
  },
): void {
  insertSignal(db, { app_id: args.app_id, signal: "locGap", t: args.t, value: args.locGap });
  insertSignal(db, {
    app_id: args.app_id,
    signal: "velocity",
    t: args.t,
    value: args.velocity,
  });
  insertSignal(db, {
    app_id: args.app_id,
    signal: "incumbent_vulnerability",
    t: args.t,
    value: args.incumbent_vulnerability,
  });
  insertSignal(db, {
    app_id: args.app_id,
    signal: "cpi_ltv_proxy",
    t: args.t,
    value: args.cpi_ltv_proxy,
  });
}

function makeOpts(overrides: Partial<BacktestOptions> = {}): BacktestOptions {
  return {
    cohort_label: "test-cohort",
    market: MARKET,
    t0: T0,
    t_measure: T_MEASURE,
    candidate_app_ids: [],
    k_values: [5, 10],
    ...overrides,
  };
}

// ─── 1. precision@K math ─────────────────────────────────────────────

describe("precision@K computation", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    chartRankCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  test("100 candidates, 10 winners; v1 ranks 6 winners in top-10 → precision@10 = 0.6", () => {
    // Setup: 100 apps. The first 10 are real winners (we'll set their
    // winner_scores tier='winner'). The v1 score we plant aligns top-10
    // ranking such that 6 of those 10 winners land in v1's top-10.
    //
    // We control v1 score = top-3 mean of 4 signals. By planting all 4
    // signals at the same value `s`, score = s. Easy ranking control.
    //
    // Plan:
    //   apps "w1".."w6"  → winners, score 9.5..9.0  (in v1 top-10)
    //   apps "w7".."w10" → winners, score 5.0..4.7  (NOT in v1 top-10)
    //   apps "x1".."x4"  → losers,  score 9.0..8.7  (in v1 top-10, displacing w7-w10)
    //   apps "y1".."y86" → losers,  score 1.0..1.86 (long tail)
    const cohort: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const id = `w${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: 9.5 - 0.1 * (i - 1),
        velocity: 9.5 - 0.1 * (i - 1),
        incumbent_vulnerability: 9.5 - 0.1 * (i - 1),
        cpi_ltv_proxy: 9.5 - 0.1 * (i - 1),
      });
      insertWinnerScore(db, { app_id: id, t0: T0, t_measure: T_MEASURE, tier: "winner" });
    }
    for (let i = 7; i <= 10; i++) {
      const id = `w${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      const s = 5.0 - 0.1 * (i - 7);
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: s,
        velocity: s,
        incumbent_vulnerability: s,
        cpi_ltv_proxy: s,
      });
      insertWinnerScore(db, { app_id: id, t0: T0, t_measure: T_MEASURE, tier: "winner" });
    }
    for (let i = 1; i <= 4; i++) {
      const id = `x${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      const s = 9.0 - 0.1 * (i - 1);
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: s,
        velocity: s,
        incumbent_vulnerability: s,
        cpi_ltv_proxy: s,
      });
      insertWinnerScore(db, { app_id: id, t0: T0, t_measure: T_MEASURE, tier: "loser" });
    }
    for (let i = 1; i <= 86; i++) {
      const id = `y${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      const s = 1.0 + 0.01 * i;
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: s,
        velocity: s,
        incumbent_vulnerability: s,
        cpi_ltv_proxy: s,
      });
      insertWinnerScore(db, { app_id: id, t0: T0, t_measure: T_MEASURE, tier: "loser" });
    }
    expect(cohort.length).toBe(100);

    const report = runBacktest(db, makeOpts({ candidate_app_ids: cohort, k_values: [10] }));

    expect(report.candidate_count).toBe(100);
    expect(report.eligible_count).toBe(100);
    expect(report.winner_count).toBe(10);
    const p10 = report.precision.find((p) => p.k === 10);
    expect(p10).toBeDefined();
    expect(p10?.v1).toBeCloseTo(0.6);
  });

  test("precision@K denominator is K (not topK.length) when ranked < K", () => {
    // 3 eligible apps (all winners). precision@10 should be 3/10 = 0.3,
    // NOT 3/3 = 1.0. The K-as-denominator rule prevents gaming the metric
    // by shrinking the ranked set.
    const cohort: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const id = `w${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: 8,
        velocity: 8,
        incumbent_vulnerability: 8,
        cpi_ltv_proxy: 8,
      });
      insertWinnerScore(db, { app_id: id, t0: T0, t_measure: T_MEASURE, tier: "winner" });
    }
    const report = runBacktest(db, makeOpts({ candidate_app_ids: cohort, k_values: [10] }));
    const p10 = report.precision.find((p) => p.k === 10);
    expect(p10?.v1).toBeCloseTo(0.3);
  });
});

// ─── 2. lift over baselines ──────────────────────────────────────────

describe("lift over locGap-only baseline", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    chartRankCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  test("v1 catches 6/10 winners; locGap_only catches 4/10 → lift = 1.5", () => {
    // Setup: 10 winners. locGap signal alone correctly ranks 4 of them in
    // top-10. v1 (top-3 mean across 4 signals) catches 6 of them.
    //
    // We construct this by having locGap rank some apps high (locGap=9 for
    // winners w1-w4; locGap=3 for winners w5-w10), then making the OTHER
    // signals strong for w5-w10 so the top-3 mean (v1) elevates them.
    const cohort: string[] = [];
    // w1-w4: high locGap (in locGap top-10), high other signals (in v1 top-10)
    for (let i = 1; i <= 4; i++) {
      const id = `w${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: 9.5,
        velocity: 9.0,
        incumbent_vulnerability: 9.0,
        cpi_ltv_proxy: 9.0,
      });
      insertWinnerScore(db, { app_id: id, t0: T0, t_measure: T_MEASURE, tier: "winner" });
    }
    // w5-w6: low locGap (NOT in locGap top-10) but very high other signals
    // → v1 score = top3 mean of (low locGap + 3 high others) is still high
    for (let i = 5; i <= 6; i++) {
      const id = `w${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: 3.0,
        velocity: 9.5,
        incumbent_vulnerability: 9.5,
        cpi_ltv_proxy: 9.5,
      });
      insertWinnerScore(db, { app_id: id, t0: T0, t_measure: T_MEASURE, tier: "winner" });
    }
    // w7-w10: low everywhere → not in either top-10
    for (let i = 7; i <= 10; i++) {
      const id = `w${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: 1.0,
        velocity: 1.0,
        incumbent_vulnerability: 1.0,
        cpi_ltv_proxy: 1.0,
      });
      insertWinnerScore(db, { app_id: id, t0: T0, t_measure: T_MEASURE, tier: "winner" });
    }
    // Filler losers — high locGap (push them to top of locGap ranking ahead
    // of w5-w6) but low other signals so v1 doesn't rank them.
    for (let i = 1; i <= 6; i++) {
      const id = `loc-pretender-${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: 9.0 - 0.05 * i,
        velocity: 1.0,
        incumbent_vulnerability: 1.0,
        cpi_ltv_proxy: 1.0,
      });
      insertWinnerScore(db, { app_id: id, t0: T0, t_measure: T_MEASURE, tier: "loser" });
    }
    // More long-tail losers
    for (let i = 1; i <= 30; i++) {
      const id = `loser-${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: 0.5,
        velocity: 0.5,
        incumbent_vulnerability: 0.5,
        cpi_ltv_proxy: 0.5,
      });
      insertWinnerScore(db, { app_id: id, t0: T0, t_measure: T_MEASURE, tier: "loser" });
    }

    const report = runBacktest(db, makeOpts({ candidate_app_ids: cohort, k_values: [10] }));
    const p10 = report.precision.find((p) => p.k === 10);
    expect(p10).toBeDefined();
    // v1 catches w1-w6 (6) + 4 high-other-signals (none above winners) → 6/10 = 0.6
    expect(p10?.v1).toBeCloseTo(0.6);
    // locGap_only catches w1-w4 (4 winners with locGap=9.5) → 4/10 = 0.4
    // Top-10 also includes loc-pretender-1..6 with locGap=8.95..8.7 (losers).
    expect(p10?.locGap_only).toBeCloseTo(0.4);
    // Lift = 0.6 / 0.4 = 1.5
    expect(p10?.lift_v1).toBeCloseTo(1.5);
  });

  test("lift sentinel when baseline precision is 0 and v1 catches a winner", () => {
    // Set up so locGap_only catches 0 winners but v1 catches 1.
    // Single winner with low locGap, high others → v1 finds it; locGap_only
    // ranks high-locGap losers ahead of it.
    const cohort: string[] = [];
    insertChart(db, { app_id: "w1", captured_at: T0 - 1000 });
    plantFullSignalSet(db, {
      app_id: "w1",
      t: T0 - 100,
      locGap: 1,
      velocity: 9.5,
      incumbent_vulnerability: 9.5,
      cpi_ltv_proxy: 9.5,
    });
    insertWinnerScore(db, { app_id: "w1", t0: T0, t_measure: T_MEASURE, tier: "winner" });
    cohort.push("w1");
    // High-locGap losers fill locGap_only top-K
    for (let i = 1; i <= 20; i++) {
      const id = `lgloser-${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: 9 - 0.05 * i,
        velocity: 0.1,
        incumbent_vulnerability: 0.1,
        cpi_ltv_proxy: 0.1,
      });
      insertWinnerScore(db, { app_id: id, t0: T0, t_measure: T_MEASURE, tier: "loser" });
    }
    const report = runBacktest(db, makeOpts({ candidate_app_ids: cohort, k_values: [5] }));
    const p5 = report.precision.find((p) => p.k === 5);
    expect(p5?.locGap_only).toBe(0);
    expect(p5?.v1).toBeGreaterThan(0);
    expect(p5?.lift_v1).toBe(LIFT_INFINITY_SENTINEL);
  });
});

// ─── 3. ★ LEAKAGE TEST CRITICAL ★ ────────────────────────────────────

describe("★ leakage detection (post-t0 rows must NEVER influence ranking) ★", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    chartRankCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  test("post-t0 trap signal_snapshot row throws via getFrozenCohortFeatures", () => {
    // Seed cohort
    const cohort = ["app1", "app2", "app3"];
    for (const id of cohort) {
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: 5,
        velocity: 5,
        incumbent_vulnerability: 5,
        cpi_ltv_proxy: 5,
      });
    }
    // Plant the LEAKAGE TRAP: app1 has a signal AT t0+1 with score 10
    // (would dominate the v1 ranking if leaked into the harness).
    insertSignal(db, {
      app_id: "app1",
      signal: "locGap",
      t: T0 + 1,
      value: 10,
      prompt_version: "v1.0.0-trap",
    });

    // Running the harness against a cohort containing app1 must throw —
    // getFrozenCohortFeatures detects the post-t0 row even though the
    // SELECT below would have filtered it out.
    expect(() => runBacktest(db, makeOpts({ candidate_app_ids: cohort, k_values: [5] }))).toThrow(
      /leakage/i,
    );
  });

  test("post-t0 row for an app NOT in cohort does not throw (false leakage guard)", () => {
    // Cohort
    const cohort = ["app1", "app2"];
    for (const id of cohort) {
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      plantFullSignalSet(db, {
        app_id: id,
        t: T0 - 100,
        locGap: 5,
        velocity: 5,
        incumbent_vulnerability: 5,
        cpi_ltv_proxy: 5,
      });
    }
    // Out-of-cohort app with a post-t0 row — must NOT trigger leakage throw.
    insertChart(db, { app_id: "out-of-cohort", captured_at: T0 - 1000 });
    insertSignal(db, {
      app_id: "out-of-cohort",
      signal: "locGap",
      t: T0 + 1,
      value: 10,
    });
    // Should NOT throw.
    expect(() =>
      runBacktest(db, makeOpts({ candidate_app_ids: cohort, k_values: [5] })),
    ).not.toThrow();
  });

  test("trap row at t0+epsilon is detected (boundary check)", () => {
    insertChart(db, { app_id: "app1", captured_at: T0 - 1000 });
    plantFullSignalSet(db, {
      app_id: "app1",
      t: T0 - 100,
      locGap: 5,
      velocity: 5,
      incumbent_vulnerability: 5,
      cpi_ltv_proxy: 5,
    });
    // 1ms past t0 — leakage.
    insertSignal(db, {
      app_id: "app1",
      signal: "velocity",
      t: T0 + 1,
      value: 9,
      prompt_version: "boundary-trap",
    });
    expect(() => runBacktest(db, makeOpts({ candidate_app_ids: ["app1"], k_values: [5] }))).toThrow(
      /leakage/i,
    );
  });

  test("row exactly AT t0 is fine (boundary inclusive)", () => {
    insertChart(db, { app_id: "app1", captured_at: T0 - 1000 });
    plantFullSignalSet(db, {
      app_id: "app1",
      t: T0,
      locGap: 5,
      velocity: 5,
      incumbent_vulnerability: 5,
      cpi_ltv_proxy: 5,
    });
    expect(() =>
      runBacktest(db, makeOpts({ candidate_app_ids: ["app1"], k_values: [5] })),
    ).not.toThrow();
  });
});

// ─── 4. reproducibility (LLM responses frozen in signal_snapshots) ──

describe("reproducibility — same inputs ⇒ same outputs", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    chartRankCounter = 0;
    // Seed 50 apps, each with full signal set + archived LLM response so
    // any future signal-pipeline replay can read the response from disk.
    const cohort: string[] = [];
    for (let i = 1; i <= 50; i++) {
      const id = `app${i}`;
      cohort.push(id);
      insertChart(db, { app_id: id, captured_at: T0 - 1000 });
      const s = 1.0 + (i % 10);
      insertSignal(db, {
        app_id: id,
        signal: "locGap",
        t: T0 - 100,
        value: s,
        llm_model: "claude-opus-4-7",
        llm_response_archived: `frozen response for ${id}`,
      });
      insertSignal(db, {
        app_id: id,
        signal: "velocity",
        t: T0 - 100,
        value: s + 0.5,
      });
      insertSignal(db, {
        app_id: id,
        signal: "incumbent_vulnerability",
        t: T0 - 100,
        value: s + 0.3,
      });
      insertSignal(db, {
        app_id: id,
        signal: "cpi_ltv_proxy",
        t: T0 - 100,
        value: s + 0.2,
      });
      insertWinnerScore(db, {
        app_id: id,
        t0: T0,
        t_measure: T_MEASURE,
        tier: i <= 5 ? "winner" : i <= 10 ? "marginal" : "loser",
      });
    }
    // Save cohort on the db handle so the test below can use it
    (db as unknown as { __cohort: string[] }).__cohort = cohort;
  });

  afterEach(() => {
    db.close();
  });

  test("two consecutive runBacktest invocations produce identical reports", () => {
    const cohort = (db as unknown as { __cohort: string[] }).__cohort;

    // Run #1
    const report1 = runBacktest(
      db,
      makeOpts({
        candidate_app_ids: cohort,
        existing_freeze: { t0: T0, market: MARKET, app_ids: cohort },
      }),
    );
    // Run #2 with the same options — uses existing_freeze to skip the
    // freezeCohort write (which would PK-collide on the second call).
    const report2 = runBacktest(
      db,
      makeOpts({
        candidate_app_ids: cohort,
        existing_freeze: { t0: T0, market: MARKET, app_ids: cohort },
      }),
    );

    expect(report1.candidate_count).toBe(report2.candidate_count);
    expect(report1.eligible_count).toBe(report2.eligible_count);
    expect(report1.winner_count).toBe(report2.winner_count);
    expect(report1.precision).toEqual(report2.precision);
    expect(report1.details.top_k_v1).toEqual(report2.details.top_k_v1);
  });
});

// ─── 5. eligibility — N<3 signals excluded ───────────────────────────

describe("eligibility (N<3 signals → excluded from v1 ranking)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    chartRankCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  test("apps with only 2 non-null signals do not appear in top_k_v1", () => {
    // app1: 2 signals (ineligible) — would be #1 if the eligibility check
    // were broken (signal values of 10, 10 → top-3-of-2 mean is undefined
    // and the composer must reject)
    insertChart(db, { app_id: "two-signal-app", captured_at: T0 - 1000 });
    insertSignal(db, { app_id: "two-signal-app", signal: "locGap", t: T0 - 100, value: 10 });
    insertSignal(db, {
      app_id: "two-signal-app",
      signal: "velocity",
      t: T0 - 100,
      value: 10,
    });

    // Eligible apps (3+ signals)
    insertChart(db, { app_id: "eligible-1", captured_at: T0 - 1000 });
    insertSignal(db, { app_id: "eligible-1", signal: "locGap", t: T0 - 100, value: 5 });
    insertSignal(db, { app_id: "eligible-1", signal: "velocity", t: T0 - 100, value: 5 });
    insertSignal(db, {
      app_id: "eligible-1",
      signal: "incumbent_vulnerability",
      t: T0 - 100,
      value: 5,
    });

    const report = runBacktest(
      db,
      makeOpts({
        candidate_app_ids: ["two-signal-app", "eligible-1"],
        k_values: [5],
      }),
    );
    expect(report.eligible_count).toBe(1);
    const ids = report.details.top_k_v1.map((r) => r.app_id);
    expect(ids).not.toContain("two-signal-app");
    expect(ids).toContain("eligible-1");
  });
});

// ─── 6. empty cohort ─────────────────────────────────────────────────

describe("empty cohort handling", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    chartRankCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  test("empty candidate_app_ids → zero-padded report (no throw)", () => {
    const report = runBacktest(db, makeOpts({ candidate_app_ids: [], k_values: [5, 10] }));
    expect(report.candidate_count).toBe(0);
    expect(report.eligible_count).toBe(0);
    expect(report.winner_count).toBe(0);
    expect(report.precision).toHaveLength(2);
    for (const row of report.precision) {
      expect(row.v1).toBe(0);
      expect(row.locGap_only).toBe(0);
      expect(row.velocity_only).toBe(0);
      expect(row.lift_v1).toBe(0);
    }
    expect(report.details.top_k_v1).toEqual([]);
  });
});

// ─── 7. t_measure default ─────────────────────────────────────────────

describe("t_measure default (t0 + 12mo)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    chartRankCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  test("when t_measure omitted, defaults to t0 + 12 months", () => {
    insertChart(db, { app_id: "app1", captured_at: T0 - 1000 });
    plantFullSignalSet(db, {
      app_id: "app1",
      t: T0 - 100,
      locGap: 5,
      velocity: 5,
      incumbent_vulnerability: 5,
      cpi_ltv_proxy: 5,
    });
    const expected = T0 + 12 * MONTH_MS;
    insertWinnerScore(db, {
      app_id: "app1",
      t0: T0,
      t_measure: expected,
      tier: "winner",
    });
    const report = runBacktest(db, {
      cohort_label: "default-tmeasure",
      market: MARKET,
      t0: T0,
      candidate_app_ids: ["app1"],
      k_values: [5],
    });
    expect(report.t_measure).toBe(expected);
    expect(report.winner_count).toBe(1);
  });
});

// ─── 8. defaults ──────────────────────────────────────────────────────

describe("DEFAULT_K_VALUES + report rendering", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    chartRankCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  test("DEFAULT_K_VALUES is [5, 10, 25, 50]", () => {
    expect([...DEFAULT_K_VALUES]).toEqual([5, 10, 25, 50]);
  });

  test("renderBacktestReportMarkdown produces a parseable digest", () => {
    insertChart(db, { app_id: "app1", captured_at: T0 - 1000 });
    plantFullSignalSet(db, {
      app_id: "app1",
      t: T0 - 100,
      locGap: 5,
      velocity: 5,
      incumbent_vulnerability: 5,
      cpi_ltv_proxy: 5,
    });
    insertWinnerScore(db, { app_id: "app1", t0: T0, t_measure: T_MEASURE, tier: "winner" });
    const report = runBacktest(db, makeOpts({ candidate_app_ids: ["app1"], k_values: [5] }));
    const md = renderBacktestReportMarkdown(report);
    expect(md).toContain("# v1 Backtest Report");
    expect(md).toContain("## Precision @ K");
    expect(md).toContain("app1");
  });
});
