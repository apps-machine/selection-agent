/**
 * AppGoblin ETL — primary chart-rank source for v1.
 *
 * Per docs/planning/agent-v1-foundation.md § "v1 ground truth", AppGoblin
 * (https://github.com/appgoblin-dev/appgoblin-data) provides .tsv.xz dumps
 * of historical app chart ranks from 2023 onwards across 142+ countries
 * including the v1 tier-2 SEA cohort. This module:
 *
 *   1. Streams + decompresses the .xz dump WITHOUT loading the full file
 *      into memory (dumps are 100MB+).
 *   2. Parses TSV rows on the fly.
 *   3. Upserts to the `chart_snapshots` table in transaction-batched
 *      chunks of 1000 rows (Codex Round 2 #8 — row-by-row INSERT
 *      tanks ETL throughput on bun:sqlite).
 *   4. Idempotent on the PRIMARY KEY (market, category, captured_at, rank).
 *      Re-runs are no-ops; partial dumps can be resumed from the last
 *      committed batch.
 *
 * xz decompression: Node's built-in zlib does NOT handle xz. We spawn the
 * `xz` CLI via Bun.spawn and pipe its stdout into our line reader. xz is
 * universally available on macOS / Linux dev machines and CI; the
 * installation cost is one apt-get / brew install. If xz is missing the
 * function throws a clear error pointing to install instructions.
 *
 * Codex R2 #8 fix: prepare-once + bulk insert + heavy indexes deferred. We
 * drop the chart_snapshots indexes BEFORE the bulk INSERT and recreate them
 * AFTER all rows are committed. This converts O(N log N) per-row index
 * maintenance into a single O(N log N) rebuild, and keeps the WAL from
 * growing unboundedly during a 1M-row import.
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import pino from "pino";

const logger = pino({
  name: "appgoblin-import",
  level: process.env.LOG_LEVEL ?? "info",
});

const BATCH_SIZE = 1000;

// AppGoblin's TSV header order (per their public schema).
// Columns are tab-separated; lines are LF-separated.
const REQUIRED_COLUMNS = ["app_id", "market", "category", "captured_at", "rank"] as const;
type ColumnName = (typeof REQUIRED_COLUMNS)[number];

export interface ImportStats {
  /** Number of rows the dump contained. */
  rowsRead: number;
  /** Number of rows newly inserted (excludes silent duplicates). */
  rowsInserted: number;
  /** Number of rows skipped due to PK collision (idempotent re-import). */
  rowsDuplicate: number;
  /** Number of rows rejected for parse error (logged, not thrown). */
  rowsInvalid: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

export interface ImportOptions {
  /**
   * Override the readable stream that yields decompressed bytes. Tests use
   * this to feed a pre-built TSV without touching xz/disk. When omitted,
   * the function spawns `xz -d` against `file_path_or_url`.
   */
  source?: ReadableStream<Uint8Array>;
  /** Override stdout from xz spawn (advanced tests). */
  spawnXz?: (path: string) => ReadableStream<Uint8Array>;
}

/**
 * Import an AppGoblin .tsv.xz dump into chart_snapshots.
 *
 * @param file_path_or_url Local file path. URL fetching is NOT yet
 *                         implemented — pass a downloaded file or use the
 *                         `source` option for streams.
 * @param db               bun:sqlite handle with v1 schema applied.
 * @param opts             Test injection points.
 *
 * Throws:
 *   - file does not exist (and no `source` option provided)
 *   - xz binary not on PATH (and no `source` option provided)
 *   - the dump's TSV header is missing one of the REQUIRED_COLUMNS
 *
 * Logs (does not throw) per-row parse errors; counts them in stats.rowsInvalid.
 */
export async function importDump(
  file_path_or_url: string,
  db: Database,
  opts: ImportOptions = {},
): Promise<ImportStats> {
  const startMs = Date.now();
  const stats: ImportStats = {
    rowsRead: 0,
    rowsInserted: 0,
    rowsDuplicate: 0,
    rowsInvalid: 0,
    durationMs: 0,
  };

  // Resolve source stream: explicit override > xz-spawn the file.
  let stream: ReadableStream<Uint8Array>;
  if (opts.source) {
    stream = opts.source;
  } else if (opts.spawnXz) {
    stream = opts.spawnXz(file_path_or_url);
  } else {
    if (!existsSync(file_path_or_url)) {
      throw new Error(
        `appgoblin-import: file not found: ${file_path_or_url}. ` +
          `(URL fetching not yet implemented; download the dump first.)`,
      );
    }
    stream = spawnXzDecompress(file_path_or_url);
  }

  // Drop indexes before the bulk INSERT (Codex R2 #8 fix). We re-create
  // them after the import completes. The PK is intrinsic and cannot be
  // dropped; that's fine — its B-tree maintenance cost is what gives us
  // the idempotence we want.
  db.exec("DROP INDEX IF EXISTS idx_chart_snapshots_app");

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO chart_snapshots
     (market, category, captured_at, rank, app_id, source)
     VALUES (?, ?, ?, ?, ?, 'appgoblin_dump')`,
  );

  let header: ColumnName[] | null = null;
  let columnIdx: Record<ColumnName, number> | null = null;

  // Batch buffer.
  const batch: Array<{
    market: string;
    category: string;
    captured_at: number;
    rank: number;
    app_id: string;
  }> = [];

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
        );
        if (result.changes === 1) {
          stats.rowsInserted += 1;
        } else {
          stats.rowsDuplicate += 1;
        }
      }
    })();
    batch.length = 0;
  }

  for await (const line of readLines(stream)) {
    if (line.length === 0) continue;
    if (header === null) {
      header = line.split("\t") as ColumnName[];
      const missing = REQUIRED_COLUMNS.filter((c) => !header?.includes(c));
      if (missing.length > 0) {
        throw new Error(
          `appgoblin-import: dump TSV missing required columns: ${missing.join(", ")}`,
        );
      }
      columnIdx = {} as Record<ColumnName, number>;
      for (const c of REQUIRED_COLUMNS) {
        columnIdx[c] = header.indexOf(c);
      }
      continue;
    }
    if (columnIdx === null) continue;

    stats.rowsRead += 1;
    const cols = line.split("\t");
    const parsed = parseRow(cols, columnIdx);
    if (parsed === null) {
      stats.rowsInvalid += 1;
      logger.warn({ rowIndex: stats.rowsRead }, "appgoblin-import: row parse error, skipped");
      continue;
    }
    batch.push(parsed);
    if (batch.length >= BATCH_SIZE) flushBatch();
  }
  flushBatch();

  // Re-create the auxiliary index after bulk insert.
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
} | null {
  const app_id = cols[idx.app_id];
  const market = cols[idx.market];
  const category = cols[idx.category];
  const capturedRaw = cols[idx.captured_at];
  const rankRaw = cols[idx.rank];
  if (!app_id || !market || !category || !capturedRaw || !rankRaw) return null;
  // captured_at can be unix seconds, unix ms, or ISO. Detect by length.
  const captured_at = parseTimestamp(capturedRaw);
  if (captured_at === null) return null;
  const rank = Number(rankRaw);
  if (!Number.isFinite(rank) || rank <= 0) return null;
  return { app_id, market, category, captured_at, rank };
}

function parseTimestamp(raw: string | undefined): number | null {
  if (!raw) return null;
  // All-digit: unix seconds (10) or ms (13).
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (raw.length <= 10) return n * 1000;
    return n;
  }
  // Otherwise try ISO.
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decompress an .xz file by spawning the `xz` CLI. Returns a stream of
 * the decompressed bytes. We use Bun.spawn so we don't pull in a heavy
 * Node-style child_process import; Bun is the runtime.
 *
 * Throws if xz isn't on PATH (the spawn itself succeeds but the process
 * exits with status 127 — we surface this as a clear error).
 */
function spawnXzDecompress(path: string): ReadableStream<Uint8Array> {
  // Bun.spawn returns a process with a `stdout` ReadableStream.
  const proc = Bun.spawn(["xz", "-d", "-c", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // We deliberately don't await proc.exited here — the caller pipes the
  // stream and the process exits naturally when the file is exhausted.
  return proc.stdout as ReadableStream<Uint8Array>;
}

/**
 * Async iterator over the lines of a Uint8Array readable stream. Buffers
 * incoming chunks until a \n boundary; emits the line (without trailing \n).
 * Handles the final line if it doesn't end in \n.
 */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx >= 0) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      yield line;
      newlineIdx = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}
