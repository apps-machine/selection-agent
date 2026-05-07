#!/usr/bin/env bun
/**
 * Import AppTweak chart_snapshots.tsv.gz into the local backtest DB.
 *
 * Safe to re-run (importApptweakCharts uses INSERT OR IGNORE on the PK).
 *
 * Usage:
 *   bun run packages/selection-agent/scripts/import-apptweak-to-db.ts \
 *     [--db .cache/selection-agent.sqlite] \
 *     [--charts data/apptweak-2026-05-04/chart-snapshots.tsv.gz]
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { importApptweakCharts } from "../src/ground-truth/apptweak-import.ts";
import { runMigrations } from "../src/storage/schema.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DEFAULT_DB = join(ROOT, ".cache", "selection-agent.sqlite");
const DEFAULT_CHARTS = join(ROOT, "data", "apptweak-2026-05-04", "chart-snapshots.tsv.gz");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const dbPath = arg("db", DEFAULT_DB);
const chartsPath = arg("charts", DEFAULT_CHARTS);

mkdirSync(dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
runMigrations(db);

process.stdout.write(`Importing ${chartsPath} → ${dbPath}\n`);
const stats = importApptweakCharts(chartsPath, db);
db.close();

process.stdout.write(
  `Done in ${stats.durationMs}ms — read=${stats.rowsRead} inserted=${stats.rowsInserted} duplicate=${stats.rowsDuplicate} invalid=${stats.rowsInvalid}\n`,
);
