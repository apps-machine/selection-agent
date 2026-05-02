#!/usr/bin/env bun
/**
 * Synthetic backtest — proves the v1 harness works end-to-end with realistic
 * data shapes BEFORE the real first backtest can run.
 *
 * Why synthetic: the REAL first backtest gates on 42matters trial signup
 * (founder-required) and AppGoblin dump availability. Until both are in
 * place we still need to know the harness compiles, runs, and produces
 * sensible reports. This script is the smoke test for that.
 *
 * Pipeline:
 *   1. Open a temp bun:sqlite DB and apply v1 migrations.
 *   2. Seed a synthetic cohort of 50 hypothetical apps in tier-2 SEA
 *      markets (id, vn, th).
 *   3. Seed chart_snapshots: 12 months of historical ranking data per app.
 *   4. Seed signal_snapshots: all 4 v1 signals at multiple t0-pre points.
 *   5. Seed winner_scores at t0+12mo (split: 8 winners / 32 losers / 10 marginal).
 *   6. Call runBacktest() with t0=2022-09-01, t_measure=2023-09-01.
 *   7. Write the rendered markdown report + JSON sidecar to docs/planning/.
 *   8. Print summary table to stdout.
 *
 * NOT in `package.json` `files:` whitelist — verified by
 * `tests/cli/internal-publish-boundary.test.ts` (npm pack --dry-run check).
 *
 * Exit codes:
 *   0 — synthetic backtest produced a report
 *   1 — any failure (file write, DB error, schema migration)
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type BacktestReport,
  DEFAULT_K_VALUES,
  renderBacktestReportMarkdown,
  runBacktest,
} from "../src/backtest/harness.ts";
import { runMigrations } from "../src/storage/schema.ts";

const COHORT_SIZE = 50;
const T0_MS = Date.parse("2022-09-01T00:00:00.000Z");
const T_MEASURE_MS = Date.parse("2023-09-01T00:00:00.000Z");
const COHORT_LABEL = "synthetic-2022-tier2-sea";
const MARKET = "id" as const;
const SUBMARKETS = ["id", "vn", "th"] as const;
const CATEGORIES = ["productivity", "health", "lifestyle", "finance", "social"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;
const REPORT_PATH = resolve(
  import.meta.dirname,
  "../../../docs/planning/agent-v1-synthetic-backtest-results.md",
);

interface SyntheticApp {
  app_id: string;
  market: (typeof SUBMARKETS)[number];
  category: (typeof CATEGORIES)[number];
  /** Forces a winner outcome at t_measure (true) vs loser/marginal (false). */
  isWinner: boolean;
  /** When true, signals are correlated with the outcome (good ranker case). */
  signalsAlign: boolean;
}

function buildSyntheticCohort(): SyntheticApp[] {
  // Mix of outcomes:
  //   8 winners     (16% — realistic for tier-2 SEA top-grossing tail)
  //   10 marginal   (20%)
  //   32 losers     (64%)
  // Of the 8 winners, 6 have aligned signals (the ranker should catch these)
  // and 2 have noise signals (the ranker will miss them — backtest reality).
  // Of the 10 marginals, 5 have aligned-strong-but-not-winner signals.
  const cohort: SyntheticApp[] = [];
  for (let i = 0; i < COHORT_SIZE; i++) {
    const idx = i % 50;
    const app_id = `synth.app${String(idx).padStart(3, "0")}`;
    const market = SUBMARKETS[i % SUBMARKETS.length] ?? "id";
    const category = CATEGORIES[i % CATEGORIES.length] ?? "productivity";
    const isWinner = i < 8;
    // Signal alignment: 6 of 8 winners + 5 of 10 marginals (the rest are noise).
    const signalsAlign = i < 6 || (i >= 8 && i < 13);
    cohort.push({ app_id, market, category, isWinner, signalsAlign });
  }
  return cohort;
}

function seedChartSnapshots(db: Database, cohort: readonly SyntheticApp[]): number {
  // 12 months of monthly chart_snapshots ending at T0_MS so freezeCohort
  // sees every app at or before t0. Real backtest reads weekly+; monthly
  // is sufficient for the smoke test.
  const insert = db.prepare(
    `INSERT INTO chart_snapshots (market, category, captured_at, rank, app_id, source)
     VALUES (?, ?, ?, ?, ?, 'synthetic')`,
  );
  let rows = 0;
  // captured_at is composite-PK with rank, so we offset rank by app index
  // within month to avoid PK collisions (12 months × 50 apps = 600 rows).
  db.transaction(() => {
    for (let m = 0; m < 12; m++) {
      const captured_at = T0_MS - (12 - m) * MONTH_MS;
      cohort.forEach((app, idx) => {
        // Winners climb (rank goes down); losers slide (rank goes up).
        const baseRank = app.isWinner ? 100 - m * 5 : 100 + m * 3;
        const rank = baseRank + idx; // unique per (m, idx) → no PK collision
        insert.run(app.market, app.category, captured_at, rank, app.app_id);
        rows += 1;
      });
    }
  })();
  return rows;
}

function seedSignalSnapshots(db: Database, cohort: readonly SyntheticApp[]): number {
  // Persist 4 signal types per app at t0-3mo and t0-1mo (two pre-t0 points).
  // The runBacktest will pick the LATEST per (app, signal) at t<=t0.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO signal_snapshots
     (app_id, signal_name, t, value,
      llm_model, llm_prompt_version, llm_request_hash,
      llm_response_hash, llm_response_archived, source_urls_json,
      computed_at)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, '[]', ?)`,
  );
  const points = [T0_MS - 3 * MONTH_MS, T0_MS - 1 * MONTH_MS];
  let rows = 0;
  db.transaction(() => {
    for (const app of cohort) {
      for (const t of points) {
        // Aligned signals (winners + winning-marginals): 7-9/10. Noise: 2-5/10.
        // Loser signals: 1-4/10. Mix gives the backtest a realistic precision
        // signal — winners with aligned signals are caught; winners with
        // noise signals are missed.
        const aligned = app.signalsAlign;
        const baseScore = aligned ? 7.5 : 3.0;
        const variance = (Math.sin(app.app_id.length * t * 0.001) + 1) * 0.5; // 0-1 deterministic
        const score = Math.min(10, Math.max(0, baseScore + variance));
        for (const signal of [
          "locGap",
          "velocity",
          "incumbent_vulnerability",
          "cpi_ltv_proxy",
        ] as const) {
          insert.run(app.app_id, signal, t, score, "v1.0.0", t + 1);
          rows += 1;
        }
      }
    }
  })();
  return rows;
}

function seedWinnerScores(db: Database, cohort: readonly SyntheticApp[]): number {
  // Persist winner_scores at t_measure for every app. Tier reflects the
  // synthetic outcome class: winners=8/10, losers=2/10, marginals=6/10.
  const insert = db.prepare(
    `INSERT INTO winner_scores
     (app_id, t0, measured_at, score, tier, formula_version, computed_at)
     VALUES (?, ?, ?, ?, ?, 'v1.0.0', ?)`,
  );
  let rows = 0;
  db.transaction(() => {
    for (let i = 0; i < cohort.length; i++) {
      const app = cohort[i]!;
      const tier: "winner" | "marginal" | "loser" = app.isWinner
        ? "winner"
        : i < 18
          ? "marginal"
          : "loser";
      const score = tier === "winner" ? 8.0 : tier === "marginal" ? 6.0 : 2.0;
      insert.run(app.app_id, T0_MS, T_MEASURE_MS, score, tier, T_MEASURE_MS + 1);
      rows += 1;
    }
  })();
  return rows;
}

function buildReportMarkdown(report: BacktestReport, seedStats: SeedStats): string {
  const lines: string[] = [];
  lines.push("# v1 Agent — Synthetic Backtest Results (smoke test)");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Cohort label: \`${report.cohort_label}\``);
  lines.push("");
  lines.push("## What this is");
  lines.push("");
  lines.push(
    "**This is a SMOKE TEST, not a real backtest.** It proves the harness compiles, runs, ",
  );
  lines.push(
    "and produces sensible reports against synthetic data shaped like the future tier-2 SEA cohort.",
  );
  lines.push("");
  lines.push("The REAL first backtest on 2022-tier2-sea-id gates on (1) 42matters trial signup");
  lines.push(
    "and (2) AppGoblin dump download. See `docs/planning/agent-v1-real-backtest-checklist.md`",
  );
  lines.push("for the founder workflow.");
  lines.push("");
  lines.push("## Synthetic seed");
  lines.push("");
  lines.push(`- Cohort size: ${seedStats.cohortSize} apps`);
  lines.push(`- Markets: ${SUBMARKETS.join(", ")} (tier-2 SEA)`);
  lines.push(`- Categories: ${CATEGORIES.join(", ")}`);
  lines.push(`- chart_snapshots rows: ${seedStats.chartRows}`);
  lines.push(`- signal_snapshots rows: ${seedStats.signalRows}`);
  lines.push(`- winner_scores rows: ${seedStats.winnerRows}`);
  lines.push(
    `- Outcome split: 8 winners / 10 marginal / 32 losers (synthetic, not real-world ratios)`,
  );
  lines.push(
    `- Signal alignment: 6/8 winners have aligned signals (ranker should catch them); 2/8 have noise (ranker will miss)`,
  );
  lines.push("");
  lines.push("## Backtest report");
  lines.push("");
  lines.push(renderBacktestReportMarkdown(report));
  lines.push("");
  lines.push("## What the harness proved");
  lines.push("");
  lines.push("The synthetic run validates these end-to-end paths:");
  lines.push("");
  lines.push(
    "- `runMigrations` applies v1 schema (8 tables: opportunities, winner_scores, signal_snapshots, chart_snapshots, app_metadata_snapshots, cohort_freezes, schema_migrations, rate_limit_queue)",
  );
  lines.push(
    "- `freezeCohort` captures the cohort + verifies every app appears in chart_snapshots at or before t0",
  );
  lines.push(
    "- `getFrozenCohortFeatures` reads ONLY pre-t0 signal_snapshots (leakage detection: throws if any post-t0 row exists for a frozen app)",
  );
  lines.push(
    "- `computeOpportunityScore` (top-3 robust mean) ranks apps by composite score, eligibility-gates N<3 signals",
  );
  lines.push(
    "- `runBacktest` joins the v1 ranking against winner_scores tier='winner' at t_measure to compute precision@K",
  );
  lines.push(
    "- `renderBacktestReportMarkdown` produces the human-readable digest used by /plan-eng-review",
  );
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  lines.push(
    "- All values are synthetic. The signal-to-winner correlation is hand-engineered to give precision > 0; this does NOT predict real-world v1 precision.",
  );
  lines.push(
    "- The seed uses two pre-t0 signal_snapshots per (app, signal); a real run reads many more (one per scraping cadence × 12 months).",
  );
  lines.push(
    "- chart_snapshots use one snapshot per month; a real run reads weekly chart-rss snapshots from Apple RSS + AppGoblin dumps.",
  );
  lines.push(
    "- winner_scores are hand-set tiers (winner/marginal/loser). A real run computes them deterministically via `computeWinnerScore` over forward-looking ground-truth data.",
  );
  lines.push("");
  lines.push("## Next step");
  lines.push("");
  lines.push(
    "Sign up for 42matters 14-day trial → run `selection-agent --internal appgoblin-import` (when implemented in v0.8.1) → run real backtest via `selection-agent --internal backtest --cohort 2022-tier2-sea-id --t0 2022-09-01 --market id`.",
  );
  lines.push("");
  return lines.join("\n");
}

interface SeedStats {
  cohortSize: number;
  chartRows: number;
  signalRows: number;
  winnerRows: number;
}

function printSummaryTable(report: BacktestReport): void {
  process.stdout.write("\n=== Synthetic Backtest Summary ===\n");
  process.stdout.write(`Cohort: ${report.cohort_label} (market=${report.market})\n`);
  process.stdout.write(
    `t0 = ${new Date(report.t0).toISOString().slice(0, 10)}, t_measure = ${new Date(
      report.t_measure,
    )
      .toISOString()
      .slice(0, 10)}\n`,
  );
  process.stdout.write(
    `Candidates: ${report.candidate_count} | Eligible: ${report.eligible_count} | Winners: ${report.winner_count}\n\n`,
  );
  process.stdout.write("K   v1     locGap_only   velocity_only   lift_v1\n");
  process.stdout.write("--  -----  -----------   -------------   -------\n");
  for (const row of report.precision) {
    const lift = row.lift_v1 === 999 ? "    ∞" : row.lift_v1.toFixed(2).padStart(5);
    process.stdout.write(
      `${String(row.k).padEnd(3)} ${row.v1.toFixed(2).padStart(5)}  ${row.locGap_only
        .toFixed(2)
        .padStart(11)}   ${row.velocity_only.toFixed(2).padStart(13)}   ${lift}\n`,
    );
  }
  process.stdout.write("\n");
}

async function main(): Promise<void> {
  process.stdout.write("Synthetic backtest — running smoke test against v1 harness\n");
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    process.stdout.write(`✓ migrations applied\n`);

    const cohort = buildSyntheticCohort();
    const chartRows = seedChartSnapshots(db, cohort);
    process.stdout.write(`✓ seeded ${chartRows} chart_snapshots rows\n`);

    const signalRows = seedSignalSnapshots(db, cohort);
    process.stdout.write(`✓ seeded ${signalRows} signal_snapshots rows\n`);

    const winnerRows = seedWinnerScores(db, cohort);
    process.stdout.write(`✓ seeded ${winnerRows} winner_scores rows\n`);

    const report = runBacktest(db, {
      cohort_label: COHORT_LABEL,
      market: MARKET,
      t0: T0_MS,
      t_measure: T_MEASURE_MS,
      candidate_app_ids: cohort.map((c) => c.app_id),
      k_values: [...DEFAULT_K_VALUES],
    });
    process.stdout.write(`✓ runBacktest completed\n`);

    const md = buildReportMarkdown(report, {
      cohortSize: cohort.length,
      chartRows,
      signalRows,
      winnerRows,
    });
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, md, "utf8");
    process.stdout.write(`✓ wrote report to ${REPORT_PATH}\n`);

    printSummaryTable(report);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nFAILED: ${message}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
  } finally {
    db.close();
  }
}

await main();
