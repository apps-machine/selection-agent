/**
 * Runbook Discovery — Stage 1 pre-flight data audit checks.
 *
 * Six pure functions, one per check, each returning a {name, status, details}
 * triple. Status is "PASS" | "WARN" | "FAIL" per the runbook rules.
 *
 * The checks are deliberately decoupled from the CLI shell so they can be
 * unit-tested against an in-memory SQLite fixture (see
 * tests/cli/runbook-audit-checks.test.ts). The CLI module composes them and
 * formats the final markdown report.
 *
 * Source of truth for thresholds: docs/runbooks/Runbook-Discovery.md Stage 1.
 */

import type { Database } from "bun:sqlite";

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  details: string;
}

const DAY_MS = 86_400_000;

/** Tier-2 SEA default markets from the Runbook (matches selection-agent v0.7.0+ pivot). */
export const DEFAULT_AUDIT_MARKETS: readonly string[] = ["bd", "th", "vn", "my", "id"] as const;

interface CoverageRow {
  market: string;
  store: string;
  min_dt: number | null;
  max_dt: number | null;
  distinct_days: number;
  rows: number;
}

/**
 * Check #1 — chart_snapshots coverage per (market, store).
 *
 * Rules:
 *   PASS: every market has ≥300 distinct days of data (across union of stores)
 *   WARN: any market 200-299 distinct days
 *   FAIL: any market <200 distinct days
 *
 * Coverage is measured per-market across stores so a market that is
 * googleplay-only (e.g. bd) is not penalised for lacking apple rows. We count
 * DISTINCT calendar days (UTC) rather than wall-clock span so a dataset with
 * rows only at the endpoints (e.g. day 0 and day 350 with 348 missing days)
 * does NOT spuriously pass the 300d threshold — the runbook intent is "300+
 * days of actual data", not "data exists at endpoints 300+ days apart".
 */
export function checkChartCoverage(db: Database, markets: readonly string[]): CheckResult {
  const placeholders = markets.map(() => "?").join(",");
  // Per (market, store, day) we compute the distinct days, then roll up across
  // stores per market by unioning the day sets. To avoid pulling every row
  // into JS, we do a two-step query: first the per-(market,store) min/max/rows,
  // then a separate query for distinct (market, day) pairs that we union in JS.
  const rows = db
    .prepare<CoverageRow, string[]>(
      `SELECT market, store,
              MIN(captured_at) AS min_dt,
              MAX(captured_at) AS max_dt,
              COUNT(DISTINCT date(captured_at/1000, 'unixepoch')) AS distinct_days,
              COUNT(*) AS rows
       FROM chart_snapshots
       WHERE market IN (${placeholders})
       GROUP BY market, store
       ORDER BY market, store`,
    )
    .all(...markets);

  if (rows.length === 0) {
    return {
      name: "chart_snapshots coverage",
      status: "FAIL",
      details: `no chart_snapshots rows found for markets [${markets.join(", ")}]`,
    };
  }

  // Roll up per market across stores. For distinct-day count we need the
  // union of (market, day) tuples, not the sum (apple+google often capture
  // the same day). Pull the distinct day set per market.
  const dayRows = db
    .prepare<{ market: string; day: string }, string[]>(
      `SELECT DISTINCT market, date(captured_at/1000, 'unixepoch') AS day
       FROM chart_snapshots
       WHERE market IN (${placeholders})`,
    )
    .all(...markets);
  const distinctDaysByMarket = new Map<string, Set<string>>();
  for (const dr of dayRows) {
    const cur = distinctDaysByMarket.get(dr.market) ?? new Set<string>();
    cur.add(dr.day);
    distinctDaysByMarket.set(dr.market, cur);
  }

  const perMarket = new Map<string, { minDt: number; maxDt: number; rows: number }>();
  for (const r of rows) {
    if (r.min_dt == null || r.max_dt == null) continue;
    const cur = perMarket.get(r.market);
    if (cur) {
      cur.minDt = Math.min(cur.minDt, r.min_dt);
      cur.maxDt = Math.max(cur.maxDt, r.max_dt);
      cur.rows += r.rows;
    } else {
      perMarket.set(r.market, { minDt: r.min_dt, maxDt: r.max_dt, rows: r.rows });
    }
  }

  const lines: string[] = [];
  let worstStatus: CheckStatus = "PASS";
  for (const m of markets) {
    const v = perMarket.get(m);
    if (!v) {
      lines.push(`  ${m}: MISSING (no rows)`);
      worstStatus = "FAIL";
      continue;
    }
    const distinctDays = distinctDaysByMarket.get(m)?.size ?? 0;
    let status: CheckStatus;
    if (distinctDays < 200) status = "FAIL";
    else if (distinctDays < 300) status = "WARN";
    else status = "PASS";
    if (rankStatus(status) > rankStatus(worstStatus)) worstStatus = status;
    lines.push(
      `  ${m}: ${distinctDays}d coverage (distinct days, ${v.rows} rows, ${formatDate(v.minDt)} → ${formatDate(v.maxDt)}) [${status}]`,
    );
  }

  return {
    name: "chart_snapshots coverage",
    status: worstStatus,
    details: `coverage per market (target ≥300 distinct days):\n${lines.join("\n")}`,
  };
}

/**
 * Check #2 — rank distribution.
 *
 * Rules:
 *   PASS: rank range is 1..100 (current cap, expected)
 *   WARN: rank extends beyond 100 (broader coverage; methodology may need update)
 *   never FAIL
 */
export function checkRankDistribution(db: Database): CheckResult {
  const row = db
    .prepare<{ min_rank: number | null; max_rank: number | null }, []>(
      "SELECT MIN(rank) AS min_rank, MAX(rank) AS max_rank FROM chart_snapshots",
    )
    .get();
  if (!row || row.min_rank == null || row.max_rank == null) {
    return {
      name: "rank distribution",
      status: "WARN",
      details: "no chart_snapshots rows present (cannot infer rank distribution)",
    };
  }
  const status: CheckStatus = row.max_rank > 100 ? "WARN" : "PASS";
  const note =
    status === "WARN"
      ? " (extends beyond 100; broader coverage — methodology may need update)"
      : " (top-100 cap, expected)";
  return {
    name: "rank distribution",
    status,
    details: `MIN(rank)=${row.min_rank}, MAX(rank)=${row.max_rank}${note}`,
  };
}

/**
 * Check #3 — recent-data window.
 *
 * Rules (per anti-pattern A7: stale data invalidates race-window math):
 *   PASS: MAX(captured_at) within 30 days of `now`
 *   WARN: 30-90 days stale
 *   FAIL: >90 days stale
 */
export function checkRecentDataWindow(db: Database, now: number = Date.now()): CheckResult {
  const row = db
    .prepare<{ max_dt: number | null }, []>(
      "SELECT MAX(captured_at) AS max_dt FROM chart_snapshots",
    )
    .get();
  if (!row || row.max_dt == null) {
    return {
      name: "recent-data window",
      status: "FAIL",
      details: "no chart_snapshots rows present",
    };
  }
  const ageDays = Math.floor((now - row.max_dt) / DAY_MS);
  let status: CheckStatus;
  if (ageDays > 90) status = "FAIL";
  else if (ageDays > 30) status = "WARN";
  else status = "PASS";
  return {
    name: "recent-data window",
    status,
    details: `MAX(captured_at)=${formatDate(row.max_dt)} (${ageDays}d stale, threshold: ≤30d PASS / ≤90d WARN / >90d FAIL)`,
  };
}

/**
 * Sample shape for metadata point-in-time reader. The reader returns a list of
 * (key, t0Records) groups for triples that have ≥2 t0 records. Each t0Record
 * carries the t0 label and the list of release_date strings observed in
 * `versions[]` for that record.
 */
export interface MetadataSampleGroup {
  key: string; // human-readable composite "(app_id, market, store)"
  records: { t0: string; maxReleaseDate: string }[];
}

export type MetadataSampleReader = (sampleSize: number) => MetadataSampleGroup[];

/**
 * Check #4 — metadata point-in-time validity.
 *
 * Rules:
 *   PASS: distinct max release_date per t0 (truly point-in-time)
 *   WARN: identical max across all t0s for sampled triples (current dataset
 *         shape — see anti-pattern A2)
 *   never FAIL
 *
 * The reader is injected so tests can mock it without needing a real
 * metadata.jsonl file.
 */
export function checkMetadataPointInTime(
  reader: MetadataSampleReader,
  sampleSize = 3,
): CheckResult {
  const groups = reader(sampleSize);
  if (groups.length === 0) {
    return {
      name: "metadata point-in-time validity",
      status: "WARN",
      details: "no multi-t0 sample groups available (cannot evaluate)",
    };
  }
  let allDuplicated = true;
  const lines: string[] = [];
  for (const g of groups) {
    const distinct = new Set(g.records.map((r) => r.maxReleaseDate));
    const duplicated = distinct.size === 1;
    if (!duplicated) allDuplicated = false;
    lines.push(
      `  ${g.key}: ${g.records.length} t0s, ${distinct.size} distinct max release_date${duplicated ? " (DUPLICATED)" : " (varying)"}`,
    );
  }
  const status: CheckStatus = allDuplicated ? "WARN" : "PASS";
  const note = allDuplicated
    ? "metadata is duplicated across t0 labels (anti-pattern A2; only release_date + publisher_id are usable invariants)"
    : "metadata varies across t0 labels (point-in-time)";
  return {
    name: "metadata point-in-time validity",
    status,
    details: `${note}\n${lines.join("\n")}`,
  };
}

/**
 * Check #5 — existing precomputes inventory. Informational, always PASS.
 */
export function checkSignalSnapshotsInventory(db: Database): CheckResult {
  const rows = db
    .prepare<{ signal_name: string; rows: number }, []>(
      "SELECT signal_name, COUNT(*) AS rows FROM signal_snapshots GROUP BY signal_name ORDER BY signal_name",
    )
    .all();
  if (rows.length === 0) {
    return {
      name: "existing precomputes inventory",
      status: "PASS",
      details: "no signal_snapshots rows (informational; nothing precomputed yet)",
    };
  }
  const lines = rows.map((r) => `  ${r.signal_name}: ${r.rows} rows`);
  return {
    name: "existing precomputes inventory",
    status: "PASS",
    details: `signal_snapshots inventory:\n${lines.join("\n")}`,
  };
}

/**
 * Check #6 — app_invariants coverage.
 *
 * Rules:
 *   PASS: ≥1000 rows AND ≥70% publisher_id AND ≥70% release_date
 *   WARN: any below threshold but ≥500 rows
 *   FAIL: <500 rows (table needs ingest)
 */
export function checkAppInvariantsCoverage(db: Database): CheckResult {
  const row = db
    .prepare<{ total: number; with_publisher: number; with_release: number }, []>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN publisher_id IS NOT NULL THEN 1 ELSE 0 END) AS with_publisher,
              SUM(CASE WHEN release_date IS NOT NULL THEN 1 ELSE 0 END) AS with_release
       FROM app_invariants`,
    )
    .get();
  const total = row?.total ?? 0;
  const withPublisher = row?.with_publisher ?? 0;
  const withRelease = row?.with_release ?? 0;
  const pubPct = total > 0 ? (withPublisher / total) * 100 : 0;
  const relPct = total > 0 ? (withRelease / total) * 100 : 0;

  let status: CheckStatus;
  if (total < 500) status = "FAIL";
  else if (total < 1000 || pubPct < 70 || relPct < 70) status = "WARN";
  else status = "PASS";

  const fix =
    status === "FAIL"
      ? " — run `bun run packages/selection-agent/scripts/path-c/import-app-invariants.ts` to ingest"
      : "";
  return {
    name: "app_invariants coverage",
    status,
    details:
      `total=${total} rows, publisher_id=${withPublisher} (${pubPct.toFixed(1)}%), release_date=${withRelease} (${relPct.toFixed(1)}%)` +
      ` (target: ≥1000 rows AND ≥70% on both)${fix}`,
  };
}

function rankStatus(s: CheckStatus): number {
  return s === "PASS" ? 0 : s === "WARN" ? 1 : 2;
}

function formatDate(ms: number): string {
  // YYYY-MM-DD
  return new Date(ms).toISOString().slice(0, 10);
}
