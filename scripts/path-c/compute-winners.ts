#!/usr/bin/env bun
/**
 * Path C v3 — compute per-cohort winner labels under H1 horizon.
 *
 * Reads cohort apps from `signal_snapshots` (rows where signal_name =
 * 'pathc.f0' uniquely identify the eligible cohort apps populated by
 * `precompute-factors.ts`). For each (app, market, store, t0):
 *
 *   - t_measure = t0 + 90 days (per design v3 § Cohort design)
 *   - winner_exact: 1 iff rank ≤ 100 at exactly captured_at = t_measure
 *     in (market, store, top_grossing_overall)
 *   - winner_window_7d: 1 iff rank ≤ 100 anywhere in
 *     [t_measure - 6d, t_measure] (same chart cell)
 *
 * Backward-only window (Codex v2 finding #B6): chart_snapshots ends at
 * 2026-05-04 so any t_measure ≤ that date can be evaluated. The latest
 * eligible t0 is 2026-01-04 → t_measure = 2026-04-04 — well within the
 * data window.
 *
 * Idempotence: PK (app_id, market, store, t0) + INSERT OR REPLACE.
 *
 * Usage:
 *   bun run packages/selection-agent/scripts/path-c/compute-winners.ts \
 *     [--db .cache/selection-agent.sqlite]
 */

import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import pino from "pino";
import { runMigrations } from "../../src/storage/schema.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const DEFAULT_DB = join(ROOT, ".cache", "selection-agent.sqlite");
const DAY_MS = 86_400_000;
const FORWARD_DAYS = 90;
const SENSITIVITY_BACKWARD_DAYS = 6; // window = [t_measure - 6d, t_measure] inclusive (7 days)
const CATEGORY = "top_grossing_overall";
const PROMPT_VERSION_PREFIX = "pathc-v3";

const logger = pino({
  name: "compute-winners",
  level: process.env.LOG_LEVEL ?? "info",
});

type Store = "apple" | "googleplay";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

interface CohortAppRow {
  app_id: string;
  t0: number;
  llm_prompt_version: string;
}

function parseCohortFromPromptVersion(pv: string): { market: string; store: Store } | null {
  // Format: 'pathc-v3-{market}-{store}-tg'
  const expectedPrefix = `${PROMPT_VERSION_PREFIX}-`;
  if (!pv.startsWith(expectedPrefix)) return null;
  const tail = pv.slice(expectedPrefix.length); // '{market}-{store}-tg'
  const parts = tail.split("-");
  // Last part should be 'tg', the part before is store, before that is market.
  if (parts.length < 3) return null;
  if (parts[parts.length - 1] !== "tg") return null;
  const store = parts[parts.length - 2];
  if (store !== "apple" && store !== "googleplay") return null;
  // Market is everything except the last two parts (some markets like 'us-east' are unlikely
  // but join with '-' to be safe — currently all our markets are 2-letter codes).
  const market = parts.slice(0, parts.length - 2).join("-");
  if (!market) return null;
  return { market, store };
}

function main(): void {
  const dbPath = arg("db", DEFAULT_DB);
  logger.info({ dbPath }, "starting compute-winners");
  const tStart = Date.now();

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);

  // Pull cohort apps from signal_snapshots (F0 is 100% coverage so it's the canonical anchor).
  const cohortAppRows = db
    .prepare<CohortAppRow, []>(
      `SELECT app_id, t AS t0, llm_prompt_version
       FROM signal_snapshots
       WHERE signal_name = 'pathc.f0'`,
    )
    .all();

  logger.info({ rows: cohortAppRows.length }, "loaded cohort apps from signal_snapshots");

  // Index cohort apps by (market, store, t0) for batched winner queries
  type CohortKey = string; // 'market|store|t0'
  const byKey = new Map<CohortKey, { market: string; store: Store; t0: number; apps: string[] }>();
  let parseErrors = 0;
  for (const r of cohortAppRows) {
    const parsed = parseCohortFromPromptVersion(r.llm_prompt_version);
    if (!parsed) {
      parseErrors += 1;
      continue;
    }
    const key = `${parsed.market}|${parsed.store}|${r.t0}`;
    const entry = byKey.get(key) ?? {
      market: parsed.market,
      store: parsed.store,
      t0: r.t0,
      apps: [],
    };
    entry.apps.push(r.app_id);
    byKey.set(key, entry);
  }
  if (parseErrors > 0) {
    logger.warn({ parseErrors }, "skipped rows with unparseable prompt_version");
  }
  logger.info({ cohorts: byKey.size }, "indexed cohort apps");

  const insertWinner = db.prepare<
    [],
    [string, string, Store, number, number, number, number, number]
  >(
    `INSERT OR REPLACE INTO path_c_winners
     (app_id, market, store, t0, t_measure, winner_exact, winner_window_7d, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const computedAt = Date.now();
  let totalWritten = 0;
  let totalWinnersExact = 0;
  let totalWinnersWindow = 0;

  for (const [, cohort] of byKey) {
    const t_measure = cohort.t0 + FORWARD_DAYS * DAY_MS;
    const windowStart = t_measure - SENSITIVITY_BACKWARD_DAYS * DAY_MS;

    // Sanity: t_measure must be within data window. Skip if not (defense-in-depth;
    // cohort spec already filters this but the check is cheap).
    const dataMaxRow = db
      .prepare<{ max_dt: number | null }, [string, Store]>(
        `SELECT MAX(captured_at) AS max_dt FROM chart_snapshots
         WHERE market = ? AND store = ? AND category = '${CATEGORY}'`,
      )
      .get(cohort.market, cohort.store);
    if (!dataMaxRow || dataMaxRow.max_dt === null || dataMaxRow.max_dt < t_measure) {
      logger.warn(
        {
          market: cohort.market,
          store: cohort.store,
          t0: new Date(cohort.t0).toISOString().slice(0, 10),
          t_measure: new Date(t_measure).toISOString().slice(0, 10),
          dataMax: dataMaxRow?.max_dt
            ? new Date(dataMaxRow.max_dt).toISOString().slice(0, 10)
            : "none",
        },
        "cohort skipped — t_measure beyond data window",
      );
      continue;
    }

    if (cohort.apps.length === 0) continue;

    // Batch queries: one for exact-day, one for window.
    // Exact: app_id IN (cohort apps) AND captured_at = t_measure AND rank <= 100
    const exactRows = db
      .prepare<{ app_id: string }, [string, Store, number, ...string[]]>(
        `SELECT DISTINCT app_id FROM chart_snapshots
         WHERE market = ? AND store = ? AND category = '${CATEGORY}'
           AND captured_at = ?
           AND rank <= 100
           AND app_id IN (${cohort.apps.map(() => "?").join(",")})`,
      )
      .all(cohort.market, cohort.store, t_measure, ...cohort.apps);
    const winnersExact = new Set(exactRows.map((r) => r.app_id));

    // Window: app_id IN (cohort apps) AND captured_at IN [windowStart, t_measure] AND rank <= 100
    const windowRows = db
      .prepare<{ app_id: string }, [string, Store, number, number, ...string[]]>(
        `SELECT DISTINCT app_id FROM chart_snapshots
         WHERE market = ? AND store = ? AND category = '${CATEGORY}'
           AND captured_at BETWEEN ? AND ?
           AND rank <= 100
           AND app_id IN (${cohort.apps.map(() => "?").join(",")})`,
      )
      .all(cohort.market, cohort.store, windowStart, t_measure, ...cohort.apps);
    const winnersWindow = new Set(windowRows.map((r) => r.app_id));

    db.exec("BEGIN");
    try {
      for (const app_id of cohort.apps) {
        const we = winnersExact.has(app_id) ? 1 : 0;
        const ww = winnersWindow.has(app_id) ? 1 : 0;
        insertWinner.run(
          app_id,
          cohort.market,
          cohort.store,
          cohort.t0,
          t_measure,
          we,
          ww,
          computedAt,
        );
        totalWritten += 1;
        totalWinnersExact += we;
        totalWinnersWindow += ww;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  const durationMs = Date.now() - tStart;
  logger.info(
    {
      totalWritten,
      totalWinnersExact,
      totalWinnersWindow,
      exactPct: totalWritten > 0 ? ((100 * totalWinnersExact) / totalWritten).toFixed(1) : "?",
      windowPct: totalWritten > 0 ? ((100 * totalWinnersWindow) / totalWritten).toFixed(1) : "?",
      durationMs,
    },
    "compute-winners complete",
  );

  db.close();
}

main();
