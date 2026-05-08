#!/usr/bin/env bun
/**
 * Path C v3 — precompute the 8 factors per (cohort, app) pair.
 *
 * Cohorts (per `docs/planning/agent-v1-path-c-design.md` § "Cohort design"):
 *   - 9 SEA monthly t0s (2025-05-04 → 2026-01-04, day-of-month=04) × 9
 *     (market, store) cells = 81 SEA cohorts
 *   - 1 tier-1 t0 (2025-08-04) × 10 (market, store) cells = 10 cohorts
 *   - Total: 91 cohort-equivalent runs
 *
 * Factor coverage:
 *   F0  — current rank at t0 (most recent in [t0-6, t0]) — BASELINE
 *   F1  — tenure: distinct days at rank≤100 in [max(2025-05-04, t0-365d), t0]
 *   F2  — rank stability: 1 / STDDEV(rank) over [max(2025-05-04, t0-90d), t0]
 *   F4  — 90d-high proximity: current_rank / MIN(rank) over 90d window
 *   F5  — multi-chart breadth: count distinct (market,store) where app
 *         has rank≤100 in top_grossing within [t0-6, t0]
 *   F7  — publisher tenure (leave-one-out across publisher's portfolio
 *         in same store, trailing 365d). Apple primary, Google sensitivity.
 *   F11 — app age days, capped at 365 (per design doc)
 *   F14 — cross-store presence (binary): app at rank≤100 at t0 in BOTH
 *         apple AND googleplay charts of same market (top_grossing)
 *
 * Output: signal_snapshots rows with:
 *   - signal_name  = 'pathc.f0' .. 'pathc.f14'
 *   - t            = t0 in unix-ms
 *   - llm_prompt_version = 'pathc-v3-{market}-{store}-tg' (tg = top_grossing)
 *   - value        = factor score (REAL) or NULL
 *   - llm_model    = NULL (not LLM-derived)
 *   - llm_response_archived = NULL
 *
 * Idempotence: PRIMARY KEY (app_id, signal_name, t, llm_prompt_version)
 * + INSERT OR REPLACE. Safe to re-run.
 *
 * Usage:
 *   bun run packages/selection-agent/scripts/path-c/precompute-factors.ts \
 *     [--db .cache/selection-agent.sqlite]
 */

import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import pino from "pino";
import { runMigrations } from "../../src/storage/schema.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const DEFAULT_DB = join(ROOT, ".cache", "selection-agent.sqlite");
const DAY_MS = 86_400_000;
const PROMPT_VERSION_PREFIX = "pathc-v3";
const CATEGORY = "top_grossing_overall";
const CHART_DATA_START_MS = Date.parse("2025-05-04T00:00:00Z");
const F11_CAP_DAYS = 365;

const logger = pino({
  name: "precompute-factors",
  level: process.env.LOG_LEVEL ?? "info",
});

type Store = "apple" | "googleplay";

interface CohortSpec {
  market: string;
  store: Store;
  t0_iso: string;
  t0_ms: number;
  tier: "sea" | "tier1";
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function buildCohorts(): CohortSpec[] {
  const seaT0s = [
    "2025-05-04",
    "2025-06-04",
    "2025-07-04",
    "2025-08-04",
    "2025-09-04",
    "2025-10-04",
    "2025-11-04",
    "2025-12-04",
    "2026-01-04",
  ];
  const tier1T0s = ["2025-08-04"];

  const seaCells: { market: string; store: Store }[] = [
    { market: "id", store: "apple" },
    { market: "id", store: "googleplay" },
    { market: "vn", store: "apple" },
    { market: "vn", store: "googleplay" },
    { market: "th", store: "apple" },
    { market: "th", store: "googleplay" },
    { market: "my", store: "apple" },
    { market: "my", store: "googleplay" },
    { market: "bd", store: "googleplay" }, // bd is googleplay-only
  ];

  const tier1Cells: { market: string; store: Store }[] = [
    { market: "us", store: "apple" },
    { market: "us", store: "googleplay" },
    { market: "jp", store: "apple" },
    { market: "jp", store: "googleplay" },
    { market: "kr", store: "apple" },
    { market: "kr", store: "googleplay" },
    { market: "br", store: "apple" },
    { market: "br", store: "googleplay" },
    { market: "mx", store: "apple" },
    { market: "mx", store: "googleplay" },
  ];

  const out: CohortSpec[] = [];
  for (const t0_iso of seaT0s) {
    const t0_ms = Date.parse(`${t0_iso}T00:00:00Z`);
    for (const c of seaCells) out.push({ ...c, t0_iso, t0_ms, tier: "sea" });
  }
  for (const t0_iso of tier1T0s) {
    const t0_ms = Date.parse(`${t0_iso}T00:00:00Z`);
    for (const c of tier1Cells) out.push({ ...c, t0_iso, t0_ms, tier: "tier1" });
  }
  return out;
}

function promptVersion(c: CohortSpec): string {
  return `${PROMPT_VERSION_PREFIX}-${c.market}-${c.store}-tg`;
}

interface FactorRow {
  app_id: string;
  signal_name: string;
  t: number;
  llm_prompt_version: string;
  value: number | null;
}

// ─────────────────────────────────────────────────────────────────────
// Per-cohort factor computation (chart-cell scoped: F0, F1, F2, F4)
// ─────────────────────────────────────────────────────────────────────

interface CellFactorScores {
  f0: number | null;
  f1: number;
  f2: number | null;
  f4: number | null;
}

function computeCellFactors(
  db: Database,
  cohort: CohortSpec,
): Map<string, CellFactorScores> {
  // Cohort apps: rank ≤ 100 in (market, store, top_grossing_overall) within [t0-6d, t0]
  const cohortStart = cohort.t0_ms - 6 * DAY_MS;
  const cohortEnd = cohort.t0_ms;
  const tenureStart = Math.max(CHART_DATA_START_MS, cohort.t0_ms - 365 * DAY_MS);
  const stab90Start = Math.max(CHART_DATA_START_MS, cohort.t0_ms - 90 * DAY_MS);

  // F0: latest rank per app in cohort window. Group on app, take MIN(rank) at MAX(captured_at).
  // Easier: load all rows in [t0-6, t0] for cohort cell, compute per-app most recent rank in TS.
  const cohortRows = db
    .prepare<
      { app_id: string; rank: number; captured_at: number },
      [string, Store, number, number]
    >(
      `SELECT app_id, rank, captured_at FROM chart_snapshots
       WHERE market = ? AND store = ? AND category = '${CATEGORY}'
         AND captured_at BETWEEN ? AND ?
         AND rank <= 100
       ORDER BY app_id, captured_at DESC`,
    )
    .all(cohort.market, cohort.store, cohortStart, cohortEnd);

  const cohortApps = new Map<string, number>(); // app → most recent rank in [t0-6, t0]
  for (const r of cohortRows) {
    if (!cohortApps.has(r.app_id)) cohortApps.set(r.app_id, r.rank);
  }

  if (cohortApps.size === 0) {
    return new Map();
  }

  // F1: tenure_365d. distinct days at rank ≤ 100 in [tenureStart, t0]
  const tenureRows = db
    .prepare<
      { app_id: string; days: number },
      [string, Store, number, number, ...string[]]
    >(
      `SELECT app_id, COUNT(DISTINCT date(captured_at/1000, 'unixepoch')) AS days
       FROM chart_snapshots
       WHERE market = ? AND store = ? AND category = '${CATEGORY}'
         AND captured_at BETWEEN ? AND ?
         AND rank <= 100
         AND app_id IN (${Array.from(cohortApps.keys()).map(() => "?").join(",")})
       GROUP BY app_id`,
    )
    .all(cohort.market, cohort.store, tenureStart, cohortEnd, ...cohortApps.keys());
  const tenureByApp = new Map<string, number>();
  for (const r of tenureRows) tenureByApp.set(r.app_id, r.days);

  // F2 + F4: per-app rank stats over [stab90Start, t0]
  // Need: COUNT(*), AVG(rank), SUM(rank*rank) for variance; MIN(rank) for F4
  const stab90Rows = db
    .prepare<
      {
        app_id: string;
        n: number;
        mean_rank: number;
        sum_sq: number;
        min_rank: number;
      },
      [string, Store, number, number, ...string[]]
    >(
      `SELECT app_id,
              COUNT(*) AS n,
              AVG(rank * 1.0) AS mean_rank,
              SUM(rank * rank * 1.0) AS sum_sq,
              MIN(rank) AS min_rank
       FROM chart_snapshots
       WHERE market = ? AND store = ? AND category = '${CATEGORY}'
         AND captured_at BETWEEN ? AND ?
         AND app_id IN (${Array.from(cohortApps.keys()).map(() => "?").join(",")})
       GROUP BY app_id`,
    )
    .all(cohort.market, cohort.store, stab90Start, cohortEnd, ...cohortApps.keys());
  const stab90ByApp = new Map<string, (typeof stab90Rows)[number]>();
  for (const r of stab90Rows) stab90ByApp.set(r.app_id, r);

  const out = new Map<string, CellFactorScores>();
  for (const [app_id, currentRank] of cohortApps) {
    const tenure = tenureByApp.get(app_id) ?? 0;
    const stab = stab90ByApp.get(app_id);

    let f2: number | null = null;
    if (stab && stab.n >= 2) {
      const variance = stab.sum_sq / stab.n - stab.mean_rank * stab.mean_rank;
      // Numerical guard: variance can be -ε due to float math; clamp to 0+
      const safeVar = Math.max(0, variance);
      const stddev = Math.sqrt(safeVar);
      f2 = stddev > 0 ? 1.0 / stddev : null; // null if perfectly stable (cannot divide)
    }

    let f4: number | null = null;
    if (stab && stab.min_rank > 0) {
      f4 = currentRank / stab.min_rank; // 1.0 = at all-time-high; >1 = below
    }

    out.set(app_id, {
      f0: currentRank,
      f1: tenure,
      f2,
      f4,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Cross-cell factor: F5 (multi-chart breadth)
// ─────────────────────────────────────────────────────────────────────
//
// For each app in any cohort, count distinct (market, store) pairs where
// the app has rank ≤ 100 in top_grossing_overall within [t0-6d, t0]. We
// need this aggregated GLOBALLY — not just within the eligible 19 cells —
// because the v3 doc defines breadth as "across markets where app holds
// top-100 slots", which is a measure of PMF independent of cohort design.

function computeF5(
  db: Database,
  appsInCohort: Set<string>,
  t0_ms: number,
): Map<string, number> {
  const cohortStart = t0_ms - 6 * DAY_MS;
  const cohortEnd = t0_ms;
  // For perf: query just the apps we care about across all (market, store).
  const appList = Array.from(appsInCohort);
  if (appList.length === 0) return new Map();

  const rows = db
    .prepare<
      { app_id: string; cells: number },
      [number, number, ...string[]]
    >(
      `SELECT app_id, COUNT(DISTINCT market || '|' || store) AS cells
       FROM chart_snapshots
       WHERE category = '${CATEGORY}'
         AND captured_at BETWEEN ? AND ?
         AND rank <= 100
         AND app_id IN (${appList.map(() => "?").join(",")})
       GROUP BY app_id`,
    )
    .all(cohortStart, cohortEnd, ...appList);

  const out = new Map<string, number>();
  for (const r of rows) out.set(r.app_id, r.cells);
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// F11: app age days, capped at F11_CAP_DAYS
// ─────────────────────────────────────────────────────────────────────

function computeF11(
  releaseDateByAppStore: Map<string, number | null>,
  app_id: string,
  store: Store,
  t0_ms: number,
): number | null {
  const release = releaseDateByAppStore.get(`${app_id}|${store}`);
  if (release == null) return null;
  const ageDays = Math.floor((t0_ms - release) / DAY_MS);
  if (ageDays < 0) return null; // app released after t0 → invariant violation, drop
  return Math.min(ageDays, F11_CAP_DAYS);
}

// ─────────────────────────────────────────────────────────────────────
// F14: cross-store presence (binary)
// ─────────────────────────────────────────────────────────────────────
//
// For (app, market, store) at t0: is the SAME app_id at rank ≤ 100 in the
// OTHER store of the same market in [t0-6, t0]?
//
// bd has only googleplay → counterpart query returns no rows → F14 = NULL
// (per design, F14 dropped from bd cohorts).

function computeF14ForCohort(
  db: Database,
  cohort: CohortSpec,
  cohortApps: Iterable<string>,
): Map<string, number | null> {
  const counterpart: Store = cohort.store === "apple" ? "googleplay" : "apple";
  const cohortStart = cohort.t0_ms - 6 * DAY_MS;
  const cohortEnd = cohort.t0_ms;

  const counterpartHasMarket = db
    .prepare<{ n: number }, [string, Store]>(
      `SELECT COUNT(*) AS n FROM chart_snapshots
       WHERE market = ? AND store = ? AND category = '${CATEGORY}'
       LIMIT 1`,
    )
    .get(cohort.market, counterpart);
  if (!counterpartHasMarket || counterpartHasMarket.n === 0) {
    // No counterpart store data for this market (e.g., bd has no apple).
    const out = new Map<string, number | null>();
    for (const app of cohortApps) out.set(app, null);
    return out;
  }

  const apps = Array.from(cohortApps);
  if (apps.length === 0) return new Map();

  const rows = db
    .prepare<
      { app_id: string },
      [string, Store, number, number, ...string[]]
    >(
      `SELECT DISTINCT app_id FROM chart_snapshots
       WHERE market = ? AND store = ? AND category = '${CATEGORY}'
         AND captured_at BETWEEN ? AND ?
         AND rank <= 100
         AND app_id IN (${apps.map(() => "?").join(",")})`,
    )
    .all(cohort.market, counterpart, cohortStart, cohortEnd, ...apps);
  const presentInCounterpart = new Set(rows.map((r) => r.app_id));

  const out = new Map<string, number | null>();
  for (const app of apps) {
    out.set(app, presentInCounterpart.has(app) ? 1 : 0);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// F7: publisher tenure (leave-one-out)
// ─────────────────────────────────────────────────────────────────────
//
// Per (publisher_id, store, t0): sum of trailing-365d top-100 days across
// the publisher's apps, EXCLUDING the focal (app, market, store) row's
// contribution.
//
// We compute per (app, market, store, t0) tenure (= F1 over the same 365d
// window — but that's already cached in cellFactorScores PER cohort_cell).
// For F7 we also need tenure of OTHER publisher apps in OTHER (market,store)
// cells. So: pull tenure for ALL (publisher's apps, all markets, store)
// trailing-365d at this t0.
//
// Implementation: build a per-(app, store, t0) tenure cache by running F1's
// query globally (across all markets) once per t0. Aggregate by publisher.

function computePublisherTenureLOO(
  db: Database,
  publisherByAppStore: Map<string, string | null>,
  t0_ms: number,
): {
  /** For (app, store): publisher portfolio mean tenure leave-one-out (NaN if publisher has only this app, NULL if no publisher_id) */
  perAppStore: Map<string, number | null>;
} {
  const tenureStart = Math.max(CHART_DATA_START_MS, t0_ms - 365 * DAY_MS);
  const tenureEnd = t0_ms;

  // Pull tenure per (app, market, store) over trailing 365d for ALL apps.
  // ~9k cohort apps * 200 markets * 2 stores worst-case → bounded by chart_snapshots
  // size in window (~ 11.7M rows in worst case but bounded).
  // To bound: limit to apps that have publisher_id (i.e., apps in our app_invariants).
  const knownAppStores = Array.from(publisherByAppStore.keys()); // 'app|store'
  if (knownAppStores.length === 0) return { perAppStore: new Map() };

  // Build chunked query — IN list capped to keep SQL small.
  // Approach: for each store separately, pull tenure across markets per app.
  const perAppStoreTenure = new Map<string, Map<string, number>>(); // 'app|store' → market → days
  for (const store of ["apple", "googleplay"] as const) {
    const apps = knownAppStores
      .filter((k) => k.endsWith(`|${store}`))
      .map((k) => k.split("|")[0])
      .filter((s): s is string => s !== undefined);
    if (apps.length === 0) continue;

    // Chunk to avoid SQL length limits
    const CHUNK = 500;
    for (let i = 0; i < apps.length; i += CHUNK) {
      const chunk = apps.slice(i, i + CHUNK);
      const rows = db
        .prepare<
          { app_id: string; market: string; days: number },
          [Store, number, number, ...string[]]
        >(
          `SELECT app_id, market, COUNT(DISTINCT date(captured_at/1000, 'unixepoch')) AS days
           FROM chart_snapshots
           WHERE store = ? AND category = '${CATEGORY}'
             AND captured_at BETWEEN ? AND ?
             AND rank <= 100
             AND app_id IN (${chunk.map(() => "?").join(",")})
           GROUP BY app_id, market`,
        )
        .all(store, tenureStart, tenureEnd, ...chunk);
      for (const r of rows) {
        const key = `${r.app_id}|${store}`;
        const inner = perAppStoreTenure.get(key) ?? new Map<string, number>();
        inner.set(r.market, r.days);
        perAppStoreTenure.set(key, inner);
      }
    }
  }

  // Aggregate by publisher (publisher_id, store): list of (app, market, days).
  // Then for each (app, store) compute LOO mean of OTHER (app, market) tenures.
  const publisherIndex = new Map<
    string,
    { app_id: string; market: string; days: number }[]
  >(); // 'publisher_id|store' → list

  for (const [appStore, marketTenures] of perAppStoreTenure) {
    const [app_id, store] = appStore.split("|") as [string, Store];
    const publisher_id = publisherByAppStore.get(appStore);
    if (!publisher_id) continue;
    const pubKey = `${publisher_id}|${store}`;
    const list = publisherIndex.get(pubKey) ?? [];
    for (const [market, days] of marketTenures) {
      list.push({ app_id, market, days });
    }
    publisherIndex.set(pubKey, list);
  }

  // Per (app, store): LOO mean
  const perAppStoreLOO = new Map<string, number | null>();
  for (const appStore of knownAppStores) {
    const [app_id, store] = appStore.split("|") as [string, Store];
    const publisher_id = publisherByAppStore.get(appStore);
    if (!publisher_id) {
      perAppStoreLOO.set(appStore, null);
      continue;
    }
    const list = publisherIndex.get(`${publisher_id}|${store}`) ?? [];
    const others = list.filter((e) => e.app_id !== app_id);
    if (others.length === 0) {
      perAppStoreLOO.set(appStore, null); // single-app publisher → LOO undefined
      continue;
    }
    const meanDays = others.reduce((s, e) => s + e.days, 0) / others.length;
    perAppStoreLOO.set(appStore, meanDays);
  }

  return { perAppStore: perAppStoreLOO };
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

function main(): void {
  const dbPath = arg("db", DEFAULT_DB);
  logger.info({ dbPath }, "starting precompute");
  const tStart = Date.now();

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);

  // Load app_invariants → maps for F7, F11
  const invRows = db
    .prepare<
      { app_id: string; store: Store; publisher_id: string | null; release_date: number | null },
      []
    >(`SELECT app_id, store, publisher_id, release_date FROM app_invariants`)
    .all();
  const publisherByAppStore = new Map<string, string | null>();
  const releaseDateByAppStore = new Map<string, number | null>();
  for (const r of invRows) {
    publisherByAppStore.set(`${r.app_id}|${r.store}`, r.publisher_id);
    releaseDateByAppStore.set(`${r.app_id}|${r.store}`, r.release_date);
  }
  logger.info({ invRows: invRows.length }, "loaded app_invariants");

  const cohorts = buildCohorts();
  logger.info({ cohorts: cohorts.length }, "built cohort specs");

  // Pre-pass: compute F7 LOO per t0 (only depends on t0, not cohort cell)
  const distinctT0s = Array.from(new Set(cohorts.map((c) => c.t0_ms))).sort();
  const f7ByT0 = new Map<number, Map<string, number | null>>();
  for (const t0 of distinctT0s) {
    const t0Iso = new Date(t0).toISOString().slice(0, 10);
    logger.info({ t0: t0Iso }, "computing F7 publisher tenure LOO");
    const { perAppStore } = computePublisherTenureLOO(db, publisherByAppStore, t0);
    f7ByT0.set(t0, perAppStore);
  }

  // Per-cohort: compute cell factors + F5 + F11 + F14, write all in one transaction per cohort.
  const insertSignal = db.prepare<
    [],
    [string, string, number, number | null, string, string, number]
  >(
    `INSERT OR REPLACE INTO signal_snapshots
     (app_id, signal_name, t, value, llm_model, llm_prompt_version, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const computedAt = Date.now();
  let totalRowsWritten = 0;
  const cohortStats: { cohort: string; apps: number }[] = [];

  for (const cohort of cohorts) {
    const cellScores = computeCellFactors(db, cohort);
    if (cellScores.size === 0) {
      cohortStats.push({ cohort: `${cohort.market}-${cohort.store}@${cohort.t0_iso}`, apps: 0 });
      continue;
    }
    const cohortApps = new Set(cellScores.keys());
    const f5Map = computeF5(db, cohortApps, cohort.t0_ms);
    const f14Map = computeF14ForCohort(db, cohort, cohortApps);
    const f7Map = f7ByT0.get(cohort.t0_ms) ?? new Map();
    const pv = promptVersion(cohort);

    db.exec("BEGIN");
    try {
      for (const [app_id, scores] of cellScores) {
        const writes: [string, number | null][] = [
          ["pathc.f0", scores.f0],
          ["pathc.f1", scores.f1],
          ["pathc.f2", scores.f2],
          ["pathc.f4", scores.f4],
          ["pathc.f5", f5Map.get(app_id) ?? null],
          ["pathc.f7", f7Map.get(`${app_id}|${cohort.store}`) ?? null],
          ["pathc.f11", computeF11(releaseDateByAppStore, app_id, cohort.store, cohort.t0_ms)],
          ["pathc.f14", f14Map.get(app_id) ?? null],
        ];
        for (const [signal_name, value] of writes) {
          insertSignal.run(app_id, signal_name, cohort.t0_ms, value, "", pv, computedAt);
          totalRowsWritten += 1;
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    cohortStats.push({
      cohort: `${cohort.market}-${cohort.store}@${cohort.t0_iso}`,
      apps: cellScores.size,
    });
  }

  const durationMs = Date.now() - tStart;
  logger.info(
    {
      cohorts: cohorts.length,
      totalRowsWritten,
      durationMs,
      avgAppsPerCohort: Math.round(
        cohortStats.reduce((s, c) => s + c.apps, 0) / cohortStats.length,
      ),
    },
    "precompute complete",
  );

  // Coverage report: per signal, count rows + non-null
  const coverage = db
    .prepare<
      { signal_name: string; total: number; non_null: number },
      []
    >(
      `SELECT signal_name, COUNT(*) AS total, SUM(CASE WHEN value IS NOT NULL THEN 1 ELSE 0 END) AS non_null
       FROM signal_snapshots
       WHERE signal_name LIKE 'pathc.%'
       GROUP BY signal_name
       ORDER BY signal_name`,
    )
    .all();
  for (const c of coverage) {
    const pct = c.total > 0 ? ((100 * c.non_null) / c.total).toFixed(1) : "?";
    logger.info({ signal: c.signal_name, total: c.total, non_null: c.non_null, pct }, "coverage");
  }

  db.close();
}

main();
