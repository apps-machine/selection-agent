/**
 * AppTweak ETL — chart-rank loader for the gzipped TSV produced by
 * `packages/selection-agent/scripts/apptweak/pull-charts.ts`.
 *
 * Reads `data/apptweak-2026-05-04/chart-snapshots.tsv.gz` (the gzipped form
 * is canonical; raw .tsv is gitignored under data/apptweak-* dirs) and upserts
 * every row into chart_snapshots with source='apptweak'. The TSV header
 * carries store + source columns natively, so the importer is a thinner
 * wrapper than appgoblin-import.ts (no inferred-store fallback needed).
 *
 * Expected header: app_id\tmarket\tcategory\tcaptured_at\trank\tsource\tstore
 *
 * Idempotence: PRIMARY KEY (market, category, captured_at, rank, store) +
 * INSERT OR IGNORE. Re-running the importer over the same .tsv.gz is a
 * no-op except for the rowsDuplicate counter.
 *
 * Codex R2 #8 fix retained: drop idx_chart_snapshots_app before bulk INSERT,
 * recreate after. Same justification as appgoblin-import — converts O(N log
 * N) per-row B-tree maintenance into a single O(N log N) rebuild.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import pino from "pino";

const logger = pino({
  name: "apptweak-import",
  level: process.env.LOG_LEVEL ?? "info",
});

const BATCH_SIZE = 1000;

const REQUIRED_COLUMNS = [
  "app_id",
  "market",
  "category",
  "captured_at",
  "rank",
  "source",
  "store",
] as const;
type ColumnName = (typeof REQUIRED_COLUMNS)[number];

const VALID_STORES = new Set(["apple", "googleplay"]);

export interface ImportStats {
  rowsRead: number;
  rowsInserted: number;
  rowsDuplicate: number;
  rowsInvalid: number;
  durationMs: number;
}

export interface ImportOptions {
  /**
   * Override the raw TSV bytes (already-decompressed). Tests use this to
   * feed a small in-memory fixture without touching disk.
   */
  rawTsv?: string;
}

/**
 * Import an AppTweak chart-snapshots .tsv.gz into chart_snapshots.
 *
 * @param file_path  Absolute or repo-relative path to the .tsv.gz file.
 * @param db         bun:sqlite handle with v1 schema applied (must include
 *                   v1-2026-05-05-chart-snapshots-add-store migration).
 * @param opts       Test injection point.
 *
 * Throws when:
 *  - file does not exist (and no `rawTsv` option)
 *  - TSV header is missing one of REQUIRED_COLUMNS
 *
 * Logs (does not throw) on per-row parse errors; counts them in
 * stats.rowsInvalid.
 */
export function importApptweakCharts(
  file_path: string,
  db: Database,
  opts: ImportOptions = {},
): ImportStats {
  const startMs = Date.now();
  const stats: ImportStats = {
    rowsRead: 0,
    rowsInserted: 0,
    rowsDuplicate: 0,
    rowsInvalid: 0,
    durationMs: 0,
  };

  const tsv =
    opts.rawTsv ??
    (() => {
      if (!existsSync(file_path)) {
        throw new Error(
          `apptweak-import: file not found: ${file_path}. Provide a chart-snapshots TSV (gz or raw) from your AppTweak chart-rank export.`,
        );
      }
      const buf = readFileSync(file_path);
      // .gz vs .tsv detection: by extension first, gzip-magic byte fallback.
      const isGz = file_path.endsWith(".gz") || (buf[0] === 0x1f && buf[1] === 0x8b);
      return isGz ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    })();

  db.exec("DROP INDEX IF EXISTS idx_chart_snapshots_app");

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO chart_snapshots
     (market, category, captured_at, rank, app_id, source, store)
     VALUES (?, ?, ?, ?, ?, 'apptweak', ?)`,
  );

  const lines = tsv.split("\n");
  if (lines.length === 0) {
    throw new Error("apptweak-import: empty TSV");
  }

  const headerLine = lines[0];
  if (!headerLine) throw new Error("apptweak-import: missing header line");
  const header = headerLine.split("\t") as ColumnName[];
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(`apptweak-import: TSV missing required columns: ${missing.join(", ")}`);
  }
  const idx: Record<ColumnName, number> = {} as Record<ColumnName, number>;
  for (const c of REQUIRED_COLUMNS) {
    idx[c] = header.indexOf(c);
  }

  type Row = {
    market: string;
    category: string;
    captured_at: number;
    rank: number;
    app_id: string;
    store: string;
  };
  const batch: Row[] = [];

  function flushBatch(): void {
    if (batch.length === 0) return;
    db.transaction(() => {
      for (const row of batch) {
        const result = insertStmt.run(
          row.market,
          row.category,
          row.captured_at,
          row.rank,
          row.app_id,
          row.store,
        );
        if (result.changes === 1) stats.rowsInserted += 1;
        else stats.rowsDuplicate += 1;
      }
    })();
    batch.length = 0;
  }

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    stats.rowsRead += 1;
    const cols = line.split("\t");
    const parsed = parseRow(cols, idx);
    if (parsed === null) {
      stats.rowsInvalid += 1;
      logger.warn({ rowIndex: stats.rowsRead }, "apptweak-import: row parse error, skipped");
      continue;
    }
    batch.push(parsed);
    if (batch.length >= BATCH_SIZE) flushBatch();
  }
  flushBatch();

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_chart_snapshots_app ON chart_snapshots(app_id, captured_at)",
  );

  stats.durationMs = Date.now() - startMs;
  return stats;
}

function parseRow(
  cols: string[],
  idx: Record<ColumnName, number>,
): {
  market: string;
  category: string;
  captured_at: number;
  rank: number;
  app_id: string;
  store: string;
} | null {
  const app_id = cols[idx.app_id];
  const market = cols[idx.market];
  const category = cols[idx.category];
  const capturedRaw = cols[idx.captured_at];
  const rankRaw = cols[idx.rank];
  const store = cols[idx.store];
  if (!app_id || !market || !category || !capturedRaw || !rankRaw || !store) return null;
  if (!VALID_STORES.has(store)) return null;
  const captured_at = parseTimestamp(capturedRaw);
  if (captured_at === null) return null;
  const rank = Number(rankRaw);
  if (!Number.isFinite(rank) || rank <= 0) return null;
  return { app_id, market, category, captured_at, rank, store };
}

function parseTimestamp(raw: string | undefined): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (raw.length <= 10) return n * 1000;
    return n;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
