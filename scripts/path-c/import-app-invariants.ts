#!/usr/bin/env bun
/**
 * Path C — ingest invariant fields from metadata.jsonl into app_invariants.
 *
 * Pre-flight verification (2026-05-07) confirmed that
 * `data/apptweak-2026-05-04/metadata.jsonl` is NOT temporally valid: every
 * (app_id, market, store) triple has identical `versions[]`, `rating`, and
 * recommendation graph across all 12 monthly t0 labels. The 2026-05-04 pull
 * was attached to historical t0 labels for the locGap LLM judge run.
 *
 * Path C v3 (`docs/planning/agent-v1-path-c-design.md`) keeps only fields
 * that ARE invariant across the 12 t0s and across markets:
 *   - `release_date` — original launch date, doesn't change
 *   - `developer.id` (Apple) / `developer` (Google) — publisher identity
 *
 * This script extracts those two fields per (app_id, store), deduplicating
 * across the 12,010 records into ~2,810 unique (app_id, store) rows.
 * Market is intentionally NOT in the PK because the invariants don't vary
 * by market; the same Apple app has the same release_date and developer.id
 * in id/vn/th/etc.
 *
 * Idempotence: INSERT OR IGNORE on PK (app_id, store). Safe to re-run.
 *
 * Usage:
 *   bun run packages/selection-agent/scripts/path-c/import-app-invariants.ts \
 *     [--db .cache/selection-agent.sqlite] \
 *     [--metadata data/apptweak-2026-05-04/metadata.jsonl.gz]
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import pino from "pino";
import { runMigrations } from "../../src/storage/schema.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const DEFAULT_DB = join(ROOT, ".cache", "selection-agent.sqlite");
const DEFAULT_METADATA_GZ = join(ROOT, "data", "apptweak-2026-05-04", "metadata.jsonl.gz");
const DEFAULT_METADATA_RAW = join(ROOT, "data", "apptweak-2026-05-04", "metadata.jsonl");
const SOURCE_TAG = "apptweak-2026-05-04";

const logger = pino({
  name: "import-app-invariants",
  level: process.env.LOG_LEVEL ?? "info",
});

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function readJsonlMaybeGzipped(path: string): string {
  if (path.endsWith(".gz")) {
    return gunzipSync(readFileSync(path)).toString("utf8");
  }
  return readFileSync(path, "utf8");
}

function resolveMetadataPath(explicit: string): string {
  if (existsSync(explicit)) return explicit;
  if (existsSync(DEFAULT_METADATA_GZ)) return DEFAULT_METADATA_GZ;
  if (existsSync(DEFAULT_METADATA_RAW)) return DEFAULT_METADATA_RAW;
  throw new Error(`metadata.jsonl(.gz) not found — looked at ${explicit} and defaults`);
}

interface InvariantRow {
  app_id: string;
  store: "apple" | "googleplay";
  publisher_id: string | null;
  publisher_name: string | null;
  release_date_ms: number | null;
}

function extractInvariants(line: string, lineNo: number): InvariantRow | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      { line: lineNo, err: err instanceof Error ? err.message : String(err) },
      "JSON parse error",
    );
    return null;
  }

  const app_id = typeof obj.app_id === "string" ? obj.app_id : null;
  const storeRaw = obj.store;
  if (storeRaw !== "apple" && storeRaw !== "googleplay") return null;
  if (!app_id) return null;

  const rawField = obj.raw as Record<string, unknown> | undefined;
  const md = rawField?.metadata as Record<string, unknown> | undefined;

  // 422 ValidationError records have raw.metadata.error — skip; no invariants.
  if (!md || typeof md !== "object" || "error" in md) {
    return { app_id, store: storeRaw, publisher_id: null, publisher_name: null, release_date_ms: null };
  }

  let publisher_id: string | null = null;
  let publisher_name: string | null = null;

  const dev = md.developer as Record<string, unknown> | string | undefined;
  if (typeof dev === "string") {
    // Google Play: `developer` is the publisher name string. Use the name as
    // both id and name; F7 self-joins are best-effort on Google because there
    // is no normalized publisher key.
    publisher_id = dev || null;
    publisher_name = dev || null;
  } else if (dev && typeof dev === "object") {
    // Apple: `developer = { id: number, name: string }`. id is normalized.
    const devId = dev.id;
    if (typeof devId === "number" || typeof devId === "string") {
      publisher_id = String(devId);
    }
    if (typeof dev.name === "string") publisher_name = dev.name;
  }

  let release_date_ms: number | null = null;
  const releaseDateRaw = md.release_date;
  if (typeof releaseDateRaw === "string") {
    const parsed = Date.parse(releaseDateRaw);
    if (Number.isFinite(parsed)) release_date_ms = parsed;
  }

  return {
    app_id,
    store: storeRaw,
    publisher_id,
    publisher_name,
    release_date_ms,
  };
}

function main(): void {
  const dbPath = arg("db", DEFAULT_DB);
  const metadataPath = resolveMetadataPath(arg("metadata", DEFAULT_METADATA_GZ));

  logger.info({ dbPath, metadataPath }, "starting ingest");
  const t0 = Date.now();

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);

  const raw = readJsonlMaybeGzipped(metadataPath);
  const lines = raw.split("\n");

  const seen = new Set<string>(); // `${app_id}|${store}` — dedupe on first occurrence
  const rows: InvariantRow[] = [];
  let parsedCount = 0;
  let skippedNonRecord = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    const rec = extractInvariants(line, i + 1);
    if (!rec) {
      skippedNonRecord += 1;
      continue;
    }
    parsedCount += 1;
    const key = `${rec.app_id}|${rec.store}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(rec);
  }

  logger.info(
    { parsedCount, uniqueAppStore: rows.length, skippedNonRecord },
    "parsed metadata.jsonl",
  );

  // Bulk insert in a single transaction. ~2,810 rows expected — small.
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO app_invariants
     (app_id, store, publisher_id, publisher_name, release_date, source, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const ingestedAt = Date.now();

  let inserted = 0;
  let duplicate = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const result = insertStmt.run(
        r.app_id,
        r.store,
        r.publisher_id,
        r.publisher_name,
        r.release_date_ms,
        SOURCE_TAG,
        ingestedAt,
      );
      if (result.changes > 0) inserted += 1;
      else duplicate += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Report coverage of populated fields.
  const coverageRow = db
    .prepare<
      {
        total: number;
        with_publisher: number;
        with_publisher_apple: number;
        with_publisher_google: number;
        with_release: number;
      },
      []
    >(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN publisher_id IS NOT NULL THEN 1 ELSE 0 END) AS with_publisher,
         SUM(CASE WHEN publisher_id IS NOT NULL AND store = 'apple' THEN 1 ELSE 0 END) AS with_publisher_apple,
         SUM(CASE WHEN publisher_id IS NOT NULL AND store = 'googleplay' THEN 1 ELSE 0 END) AS with_publisher_google,
         SUM(CASE WHEN release_date IS NOT NULL THEN 1 ELSE 0 END) AS with_release
       FROM app_invariants`,
    )
    .get();

  const durationMs = Date.now() - t0;
  logger.info(
    {
      inserted,
      duplicate,
      durationMs,
      coverage: coverageRow,
    },
    "ingest complete",
  );

  db.close();
}

main();
