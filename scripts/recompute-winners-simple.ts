#!/usr/bin/env bun
/**
 * Recompute winner_scores using the simple boolean definition for the
 * Path B' backtest cohorts.
 *
 * The v1 formula in `src/ground-truth/winner-score.ts` requires
 * review_count + public_revenue_estimate signals that AppTweak data
 * doesn't provide. On the 48,511 (app, t0) pairs from the 70-cohort
 * Path B' run, the v1 formula caps at ~5 (only the months_top_100 +
 * chart_stability weights contribute) and observed max=2.42, so every
 * row gets tier=`loser` and precision@K is undefined.
 *
 * This script:
 *   1. DELETEs all existing winner_scores rows
 *   2. Iterates the same 70 cohorts as `precompute-pathb-signals.ts`
 *      (5 SEA × 12 t0s + 5 tier-1 × 2 t0s)
 *   3. For each (market, t0), pulls candidate apps from chart_snapshots
 *      (rank ≤ 200 at or before t0)
 *   4. Computes simple-winner via `computeSimpleWinnerScore`
 *      (winner if app appears with rank ≤ 100 within t_measure ± 7d)
 *   5. Reports tier distribution
 *
 * t_measure is fixed at 2026-05-04T00:00:00Z (matches the Path B' run).
 *
 * Idempotent: re-running produces the same tier distribution because
 * DELETE + INSERT is naturally idempotent. Cohort definitions are
 * duplicated VERBATIM from precompute-pathb-signals.ts to prevent drift;
 * future Path B' winner reruns should use this script.
 */
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { computeSimpleWinnerScore } from "../src/ground-truth/simple-winner-score.ts";
import { runMigrations } from "../src/storage/schema.ts";

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

// Wipe existing winner_scores so the (app_id, t0) PK doesn't reject the
// new INSERTs. This is naturally destructive — the script defaults to the
// production .cache DB but accepts --db <path> for testing on a copy.
const before = db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM winner_scores").get();
process.stdout.write(`DB: ${dbPath}\n`);
process.stdout.write(`Existing winner_scores rows (will DELETE): ${before?.c ?? 0}\n`);
db.exec("DELETE FROM winner_scores");

const candStmt = db.prepare<{ app_id: string }, [string, number]>(
  `SELECT DISTINCT app_id FROM chart_snapshots
   WHERE market = ? AND captured_at <= ? AND rank <= 200
   ORDER BY app_id`,
);

let totalApps = 0;
let totalWinner = 0;
let totalLoser = 0;
let totalNull = 0;

for (const c of cohorts) {
  const candidates = candStmt.all(c.market, c.t0).map((r) => r.app_id);
  let cohortWinners = 0;
  let cohortLosers = 0;
  let cohortNulls = 0;

  for (const app_id of candidates) {
    try {
      const w = computeSimpleWinnerScore(db, app_id, c.t0, T_MEASURE_MS);
      if (w === null) {
        cohortNulls += 1;
      } else if (w.tier === "winner") {
        cohortWinners += 1;
      } else {
        cohortLosers += 1;
      }
    } catch (_e) {
      // PK collision shouldn't happen post-DELETE, but defensive.
      cohortNulls += 1;
    }
  }

  totalApps += candidates.length;
  totalWinner += cohortWinners;
  totalLoser += cohortLosers;
  totalNull += cohortNulls;

  process.stdout.write(
    `[${c.market} ${c.t0Iso}] candidates=${candidates.length} winners=${cohortWinners} losers=${cohortLosers} nulls=${cohortNulls}\n`,
  );
}

db.close();
process.stdout.write(
  `Done — apps=${totalApps} winners=${totalWinner} losers=${totalLoser} nulls=${totalNull}\n`,
);
