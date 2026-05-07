#!/usr/bin/env bun
/**
 * Run the Path B' multi-cohort backtest, write per-cohort markdown +
 * aggregate verdict.
 *
 * Outputs:
 *   docs/planning/pathb-backtest-runs/<cohort>-<ts>.md   (per cohort)
 *   docs/planning/pathb-backtest-runs/<cohort>-<ts>.json (per cohort)
 *   docs/planning/pathb-backtest-runs/multi-cohort-<ts>.json (full struct)
 *   docs/planning/agent-v1-path-b-results.md             (verdict, hand-curated after this script writes a draft)
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderBacktestReportMarkdown } from "../src/backtest/harness.ts";
import { runPathBBacktests } from "../src/backtest/pathb-multi-cohort.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DEFAULT_DB = join(ROOT, ".cache", "selection-agent.sqlite");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const dbPath = arg("db", DEFAULT_DB);
const mode = arg("mode", "survival") as "survival" | "entrants" | "fresh";
if (mode !== "survival" && mode !== "entrants" && mode !== "fresh") {
  process.stderr.write(`Invalid --mode: ${mode}. Expected 'survival', 'entrants', or 'fresh'.\n`);
  process.exit(1);
}

const OUT_DIR =
  mode === "survival"
    ? join(ROOT, "docs", "planning", "pathb-backtest-runs")
    : join(ROOT, "docs", "planning", "pathb-backtest-runs", mode);

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");

// Non-survival modes share the (market, t0) freeze PK with the prior survival
// run. Clear the freezes so the new mode can write its own cohort. Idempotent
// — re-running clears + rewrites.
if (mode !== "survival") {
  db.exec("DELETE FROM cohort_freezes");
}

mkdirSync(OUT_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");

const out = runPathBBacktests(db, { mode });
db.close();

for (const r of out.cohort_reports) {
  const base = `${r.cohort_label}-${ts}`;
  writeFileSync(join(OUT_DIR, `${base}.md`), renderBacktestReportMarkdown(r), "utf8");
  writeFileSync(join(OUT_DIR, `${base}.json`), `${JSON.stringify(r, null, 2)}\n`, "utf8");
}
writeFileSync(
  join(OUT_DIR, `multi-cohort-${ts}.json`),
  `${JSON.stringify(out, null, 2)}\n`,
  "utf8",
);

// Print summary
process.stdout.write(`MODE=${mode}\n\n`);
process.stdout.write(
  `Wrote ${out.cohort_reports.length} cohort reports + 1 aggregate to ${OUT_DIR}\n\n`,
);
process.stdout.write("SEA mean precision@K:\n");
for (const m of out.aggregate.sea_mean) {
  process.stdout.write(
    `  K=${m.k}  v1=${m.v1.toFixed(3)}  locGap=${m.locGap_only.toFixed(3)}  velocity=${m.velocity_only.toFixed(3)}  random=${m.random.toFixed(3)}\n`,
  );
}
process.stdout.write("Tier-1 mean precision@K:\n");
for (const m of out.aggregate.tier1_mean) {
  process.stdout.write(
    `  K=${m.k}  v1=${m.v1.toFixed(3)}  locGap=${m.locGap_only.toFixed(3)}  velocity=${m.velocity_only.toFixed(3)}  random=${m.random.toFixed(3)}\n`,
  );
}
process.stdout.write("Paired delta @ 2025-08-04 (SEA - tier1):\n");
for (const p of out.aggregate.paired_delta_2025_08) {
  process.stdout.write(
    `  K=${p.k}  sea=${p.sea_v1.toFixed(3)}  tier1=${p.tier1_v1.toFixed(3)}  delta=${p.delta.toFixed(3)}\n`,
  );
}
process.stdout.write("Paired delta @ 2026-02-04 (SEA - tier1):\n");
for (const p of out.aggregate.paired_delta_2026_02) {
  process.stdout.write(
    `  K=${p.k}  sea=${p.sea_v1.toFixed(3)}  tier1=${p.tier1_v1.toFixed(3)}  delta=${p.delta.toFixed(3)}\n`,
  );
}
