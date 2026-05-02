/**
 * E2E backtest integration test.
 *
 * Spins a full backtest on a synthetic cohort that's larger than the unit
 * tests in tests/backtest/harness.test.ts. The point is to verify the
 * report shape end-to-end: precision@K computation, baseline rankings,
 * lift, top-K rendering — all on a 30-app cohort with non-trivial
 * signal/winner correlations.
 *
 * NOT a duplicate of scripts/run-first-backtest.ts (which writes a doc).
 * This test asserts on report values; the script demos the harness.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_K_VALUES,
  LIFT_INFINITY_SENTINEL,
  renderBacktestReportMarkdown,
  runBacktest,
} from "../../src/backtest/harness.ts";
import { runMigrations } from "../../src/storage/schema.ts";

const T0 = Date.parse("2022-09-01T00:00:00.000Z");
const T_MEASURE = Date.parse("2023-09-01T00:00:00.000Z");
const MARKET = "id" as const;
const COHORT_SIZE = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

interface SyntheticApp {
  app_id: string;
  isWinner: boolean;
  signalsAlign: boolean;
}

function buildCohort(): SyntheticApp[] {
  // 5 winners, all with aligned signals → ranker should catch all 5.
  // 5 marginals, mixed signal alignment.
  // 20 losers with low signals.
  const apps: SyntheticApp[] = [];
  for (let i = 0; i < COHORT_SIZE; i++) {
    apps.push({
      app_id: `e2e.app${String(i).padStart(2, "0")}`,
      isWinner: i < 5,
      signalsAlign: i < 5 || (i >= 5 && i < 8),
    });
  }
  return apps;
}

function seedChartSnapshots(db: Database, cohort: readonly SyntheticApp[]): void {
  const insert = db.prepare(
    `INSERT INTO chart_snapshots (market, category, captured_at, rank, app_id, source)
     VALUES (?, ?, ?, ?, ?, 'synthetic-e2e')`,
  );
  db.transaction(() => {
    for (let m = 0; m < 6; m++) {
      const captured_at = T0 - (6 - m) * MONTH_MS;
      cohort.forEach((app, idx) => {
        const rank = 100 + idx + m; // unique per (m, idx); always in chart
        insert.run(MARKET, "productivity", captured_at, rank, app.app_id);
      });
    }
  })();
}

function seedSignalSnapshots(db: Database, cohort: readonly SyntheticApp[]): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO signal_snapshots
     (app_id, signal_name, t, value,
      llm_model, llm_prompt_version, llm_request_hash,
      llm_response_hash, llm_response_archived, source_urls_json,
      computed_at)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, '[]', ?)`,
  );
  db.transaction(() => {
    for (const app of cohort) {
      const baseScore = app.signalsAlign ? 8.0 : 2.5;
      for (const signal of [
        "locGap",
        "velocity",
        "incumbent_vulnerability",
        "cpi_ltv_proxy",
      ] as const) {
        insert.run(app.app_id, signal, T0 - DAY_MS, baseScore, "v1.0.0", T0 - DAY_MS + 1);
      }
    }
  })();
}

function seedWinnerScores(db: Database, cohort: readonly SyntheticApp[]): void {
  const insert = db.prepare(
    `INSERT INTO winner_scores
     (app_id, t0, measured_at, score, tier, formula_version, computed_at)
     VALUES (?, ?, ?, ?, ?, 'v1.0.0', ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < cohort.length; i++) {
      const app = cohort[i]!;
      const tier: "winner" | "marginal" | "loser" = app.isWinner
        ? "winner"
        : i < 10
          ? "marginal"
          : "loser";
      const score = tier === "winner" ? 8.5 : tier === "marginal" ? 6.0 : 2.0;
      insert.run(app.app_id, T0, T_MEASURE, score, tier, T_MEASURE + 1);
    }
  })();
}

describe("E2E backtest on synthetic cohort", () => {
  let db: Database;
  let cohort: SyntheticApp[];

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    cohort = buildCohort();
    seedChartSnapshots(db, cohort);
    seedSignalSnapshots(db, cohort);
    seedWinnerScores(db, cohort);
  });

  afterEach(() => db.close());

  test("runBacktest produces report with eligible apps + winners + precision@K", () => {
    const report = runBacktest(db, {
      cohort_label: "e2e-test",
      market: MARKET,
      t0: T0,
      t_measure: T_MEASURE,
      candidate_app_ids: cohort.map((a) => a.app_id),
      k_values: [...DEFAULT_K_VALUES],
    });

    expect(report.candidate_count).toBe(COHORT_SIZE);
    expect(report.eligible_count).toBe(COHORT_SIZE); // all apps have 4 signals
    expect(report.winner_count).toBe(5);
    expect(report.precision.length).toBe(DEFAULT_K_VALUES.length);

    // 5 winners with aligned signals → top-5 = all winners → precision@5 = 1.0
    const p5 = report.precision.find((p) => p.k === 5);
    expect(p5?.v1).toBe(1.0);

    // top-10 catches all 5 winners → precision@10 = 0.5
    const p10 = report.precision.find((p) => p.k === 10);
    expect(p10?.v1).toBe(0.5);

    // Top-K v1 list contains the 5 winners
    expect(report.details.top_k_v1.length).toBeGreaterThanOrEqual(5);
    const topWinners = report.details.top_k_v1.filter((r) => r.tier === "winner");
    expect(topWinners.length).toBeGreaterThanOrEqual(5);
  });

  test("backtest baselines (locGap_only, velocity_only) computed in report", () => {
    const report = runBacktest(db, {
      cohort_label: "e2e-baselines",
      market: MARKET,
      t0: T0,
      t_measure: T_MEASURE,
      candidate_app_ids: cohort.map((a) => a.app_id),
      k_values: [10],
    });

    const row = report.precision[0];
    expect(row?.k).toBe(10);
    // Single-signal baselines: same data underneath in this synthetic, so
    // both v1 and baselines catch all 5 winners in top-10.
    expect(row?.locGap_only).toBe(0.5);
    expect(row?.velocity_only).toBe(0.5);
    // Lift = v1 / locGap_only = 0.5 / 0.5 = 1.0 (no lift from a single
    // strong signal cohort — expected; lift over baseline matters when
    // signals diverge).
    expect(row?.lift_v1).toBe(1.0);
  });

  test("backtest report markdown renders correctly", () => {
    const report = runBacktest(db, {
      cohort_label: "e2e-render",
      market: MARKET,
      t0: T0,
      t_measure: T_MEASURE,
      candidate_app_ids: cohort.map((a) => a.app_id),
      k_values: [5, 10],
    });

    const md = renderBacktestReportMarkdown(report);
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain("# v1 Backtest Report — e2e-render");
    expect(md).toContain("- Market: id");
    expect(md).toContain("- Candidates: 30");
    expect(md).toContain("- Eligible (N≥3 signals): 30");
    expect(md).toContain("- Winners (winner_score tier=winner at t_measure): 5");
    expect(md).toContain("## Precision @ K");
    expect(md).toContain("| 5 |");
    expect(md).toContain("| 10 |");
    expect(md).toContain("## Top");
    // Each top-K row should include score + tier
    expect(md).toMatch(/\| e2e\.app\d+ \| \d/);
  });

  test("lift sentinel surfaces when baseline catches zero winners", () => {
    // Build a degenerate case: locGap signals are all set to a constant 0
    // for the WINNERS only, so locGap_only ranking puts losers above winners
    // → locGap_only precision@5 = 0 → lift = LIFT_INFINITY_SENTINEL.
    const fresh = new Database(":memory:");
    runMigrations(fresh);
    const c = buildCohort();
    seedChartSnapshots(fresh, c);
    // Override locGap signal: winners get LOW values, losers get HIGH.
    const insert = fresh.prepare(
      `INSERT OR IGNORE INTO signal_snapshots
       (app_id, signal_name, t, value,
        llm_model, llm_prompt_version, llm_request_hash,
        llm_response_hash, llm_response_archived, source_urls_json,
        computed_at)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, '[]', ?)`,
    );
    fresh.transaction(() => {
      for (const app of c) {
        // locGap inverted vs winner status
        insert.run(
          app.app_id,
          "locGap",
          T0 - DAY_MS,
          app.isWinner ? 0.5 : 9.0,
          "v1.0.0",
          T0 - DAY_MS + 1,
        );
        // velocity + incumbent_vulnerability + cpi_ltv_proxy aligned with winners
        for (const signal of ["velocity", "incumbent_vulnerability", "cpi_ltv_proxy"] as const) {
          insert.run(
            app.app_id,
            signal,
            T0 - DAY_MS,
            app.isWinner ? 8.5 : 2.0,
            "v1.0.0",
            T0 - DAY_MS + 1,
          );
        }
      }
    })();
    seedWinnerScores(fresh, c);

    const report = runBacktest(fresh, {
      cohort_label: "lift-sentinel",
      market: MARKET,
      t0: T0,
      t_measure: T_MEASURE,
      candidate_app_ids: c.map((a) => a.app_id),
      k_values: [5],
    });

    const row = report.precision[0];
    // locGap_only ranks losers first → precision@5 = 0
    expect(row?.locGap_only).toBe(0);
    // v1 (top-3 mean across all 4 signals) drops the bad locGap → still
    // catches winners → precision@5 > 0 → lift = sentinel.
    expect(row?.v1).toBeGreaterThan(0);
    expect(row?.lift_v1).toBe(LIFT_INFINITY_SENTINEL);

    fresh.close();
  });
});
