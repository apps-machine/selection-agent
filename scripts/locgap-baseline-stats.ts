#!/usr/bin/env bun
/**
 * Emit the locGap baseline stats TSV for the 14 Path B' measurement points.
 *
 * Reads signal_snapshots (signal_name='locGap', llm_prompt_version=v1.0.0-apptweak)
 * joined to chart_snapshots to attach the market label, then runs
 * computeLocGapBaselineStats. Output:
 *   data/apptweak-2026-05-04/locgap-baseline-stats.tsv
 *
 * No API spend; pure SQL + arithmetic.
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  computeLocGapBaselineStats,
  type SignalRow,
} from "../src/backtest/locgap-baseline-stats.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DEFAULT_DB = join(ROOT, ".cache", "selection-agent.sqlite");
const OUT = join(ROOT, "data", "apptweak-2026-05-04", "locgap-baseline-stats.tsv");

const SEA = ["id", "vn", "th", "my", "bd"];
const T1 = ["us", "jp", "kr", "br", "mx"];

function isoToMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}
const SEA_T0S = [
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
].map(isoToMs);
const T1_T0S = ["2025-08-04", "2026-02-04"].map(isoToMs);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const dbPath = arg("db", DEFAULT_DB);
const db = new Database(dbPath, { readonly: true });

// Pull every locGap row + join to chart_snapshots once to get market.
// signal_snapshots has app_id but not market — chart_snapshots has both.
// JOIN on (app_id, captured_at <= t) is too broad; we use the t value (which
// matches t0) to pick the chart row at the same date.
//
// As of 2026-05-06 the AppTweak locGap is per-market: each (app, market, t0)
// gets its own row under prompt_version `v1.0.0-apptweak-{market}`. The JOIN
// picks the row whose suffix matches the chart's market — this is what makes
// the (market, t0) statistics market-correct (Spotify in `id` shows up as the
// Indonesian listing's locGap, not the English listing's).
const rows = db
  .prepare<{ app_id: string; market: string; t: number; value: number }, []>(
    `SELECT s.app_id, c.market, s.t, s.value
     FROM signal_snapshots s
     JOIN chart_snapshots c
       ON c.app_id = s.app_id AND c.captured_at = s.t
     WHERE s.signal_name = 'locGap'
       AND s.llm_prompt_version = 'v1.0.0-apptweak-' || c.market
       AND s.value IS NOT NULL`,
  )
  .all() as SignalRow[];

const seaStats = computeLocGapBaselineStats(rows, SEA_T0S, SEA);
const t1Stats = computeLocGapBaselineStats(rows, T1_T0S, T1);
const all = [...seaStats, ...t1Stats];

const lines = ["market\tt0\tt0_iso\tn\tmean_locgap\tpct_below_5\ttier"];
for (const r of all) {
  const tier = SEA.includes(r.market) ? "sea" : "tier1";
  lines.push(
    `${r.market}\t${r.t}\t${new Date(r.t).toISOString().slice(0, 10)}\t${r.n}\t${r.mean_locgap.toFixed(3)}\t${r.pct_below_5.toFixed(3)}\t${tier}`,
  );
}
writeFileSync(OUT, `${lines.join("\n")}\n`, "utf8");
db.close();

process.stdout.write(`Wrote ${all.length} rows to ${OUT}\n`);
const seaMean = seaStats.reduce((s, r) => s + r.pct_below_5, 0) / Math.max(1, seaStats.length);
const t1Mean = t1Stats.reduce((s, r) => s + r.pct_below_5, 0) / Math.max(1, t1Stats.length);
process.stdout.write(`SEA mean pct_below_5 = ${seaMean.toFixed(3)}\n`);
process.stdout.write(`Tier-1 mean pct_below_5 = ${t1Mean.toFixed(3)}\n`);
