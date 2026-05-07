#!/usr/bin/env bun
/**
 * Precompute non-LLM signals + winner_scores for the 14 Path B' cohorts.
 *
 * For each (market, t0) cohort:
 *   1. Pick candidate apps = distinct app_id with chart_snapshots row at t0.
 *   2. Compute velocity v1 (chart-driven) and incumbent_vulnerability
 *      chart-stability fallback for each candidate at t=t0. Persist to
 *      signal_snapshots.
 *   3. Compute winner_score at t_measure for each candidate. Persist to
 *      winner_scores.
 *
 * cpi_ltv_proxy is intentionally null because AppTweak metadata doesn't carry
 * Apple/Google category. Composer's MIN_NON_NULL_SIGNALS=3 still allows the
 * cohort to be eligible with locGap + velocity + incumbent_vulnerability.
 *
 * Idempotent at the SQL layer: signal_snapshots uses INSERT OR IGNORE on
 * (app_id, signal_name, t, llm_prompt_version); winner_scores uses INSERT
 * (rejects re-scoring the same (app_id, t0) — log + continue).
 */
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { computeWinnerScore } from "../src/ground-truth/winner-score.ts";
import {
  computeIncumbentVulnerabilityFromCharts,
  INCUMBENT_VULN_FALLBACK_VERSION,
  persistIncumbentVulnSignal,
} from "../src/signals/incumbent-vulnerability.ts";
import { runMigrations } from "../src/storage/schema.ts";
import { computeAndPersistVelocityV1 } from "../src/velocity/v1-score.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DEFAULT_DB = join(ROOT, ".cache", "selection-agent.sqlite");
const T_MEASURE_MS = Date.parse("2026-05-04T00:00:00Z");

const SEA_MARKETS = ["id", "vn", "th", "my", "bd"] as const;
const TIER1_MARKETS = ["us", "jp", "kr", "br", "mx"] as const;

const SEA_T0S: string[] = [
  "2025-05-04",
  "2025-06-04",
  "2025-07-04",
  "2025-08-04",
  "2025-09-04",
  "2025-10-04",
  "2025-11-04",
  "2025-12-04",
  "2026-01-04",
  "2026-02-04",
  "2026-03-04",
  "2026-04-04",
];
const TIER1_T0S: string[] = ["2025-08-04", "2026-02-04"];

function isoToMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const dbPath = arg("db", DEFAULT_DB);
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
runMigrations(db);

interface Cohort {
  market: string;
  t0: number;
  t0Iso: string;
}
const cohorts: Cohort[] = [
  ...SEA_MARKETS.flatMap((m) => SEA_T0S.map((t) => ({ market: m, t0: isoToMs(t), t0Iso: t }))),
  ...TIER1_MARKETS.flatMap((m) => TIER1_T0S.map((t) => ({ market: m, t0: isoToMs(t), t0Iso: t }))),
];

const candStmt = db.prepare<{ app_id: string }, [string, number]>(
  `SELECT DISTINCT app_id FROM chart_snapshots
   WHERE market = ? AND captured_at <= ? AND rank <= 200
   ORDER BY app_id`,
);

let totalApps = 0;
let totalVelocity = 0;
let totalVuln = 0;
let totalWinner = 0;

for (const c of cohorts) {
  const candidates = candStmt.all(c.market, c.t0).map((r) => r.app_id);
  process.stdout.write(`[${c.market} ${c.t0Iso}] ${candidates.length} candidates\n`);
  totalApps += candidates.length;

  for (const app_id of candidates) {
    // 1. velocity v1 (chart-driven). Persist `t = c.t0` by passing
    //    `clock: () => c.t0` — `computeAndPersistVelocityV1` uses the same
    //    clock value both as the upper bound of the look-back window AND as
    //    the persisted `t`. Returns null on insufficient history; the row
    //    is still written so its absence is recorded.
    try {
      computeAndPersistVelocityV1(db, app_id, { clock: () => c.t0 });
      totalVelocity += 1;
    } catch (_e) {
      // already persisted (PK collision) → ignore
    }

    // 2. incumbent_vulnerability via chart-stability fallback.
    const vuln = computeIncumbentVulnerabilityFromCharts(db, app_id, c.t0, 90);
    try {
      persistIncumbentVulnSignal(db, app_id, vuln, c.t0, {
        version: INCUMBENT_VULN_FALLBACK_VERSION,
      });
      totalVuln += 1;
    } catch (_e) {
      // already persisted → ignore
    }

    // 3. winner_score at t_measure.
    try {
      const w = computeWinnerScore(db, app_id, c.t0, T_MEASURE_MS);
      if (w) totalWinner += 1;
    } catch (_e) {
      // already persisted → ignore
    }
  }
}

db.close();
process.stdout.write(
  `Done — apps=${totalApps} velocity_writes=${totalVelocity} vuln_writes=${totalVuln} winner_writes=${totalWinner}\n`,
);
