/**
 * `selection-agent audit` — Stage 1 pre-flight data audit (Runbook Discovery).
 *
 * Runs the six pre-flight checks against an existing SQLite cache and emits
 * a Markdown report. Exits 0 if all checks PASS or WARN; exits 1 if any
 * check FAILs.
 *
 * The runbook (`docs/runbooks/Runbook-Discovery.md` Stage 1) documents this
 * step as MANDATORY before any discovery cycle runs. Prior Path B and Path C
 * cycles each shipped on flawed inputs that 5 SQL queries would have caught.
 *
 * Usage:
 *   selection-agent audit
 *   selection-agent audit --db /path/to/db.sqlite
 *   selection-agent audit --markets id,vn,th
 *   selection-agent audit --output report.md
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import pino from "pino";
import { runMigrations } from "../storage/schema.ts";
import {
  type CheckResult,
  type CheckStatus,
  checkAppInvariantsCoverage,
  checkChartCoverage,
  checkMetadataPointInTime,
  checkRankDistribution,
  checkRecentDataWindow,
  checkSignalSnapshotsInventory,
  DEFAULT_AUDIT_MARKETS,
  type MetadataSampleGroup,
  type MetadataSampleReader,
} from "./runbook-audit-checks.ts";

export interface AuditOpts {
  /** Path to the sqlite cache. Defaults to ./.cache/selection-agent.sqlite. */
  dbPath?: string;
  /** Markets to evaluate for chart coverage. Defaults to tier-2 SEA cluster. */
  markets?: readonly string[];
  /** Output path for the markdown report. If omitted, write to stdout. */
  output?: string;
  /** Override "now" for the recent-data-window check (test seam). */
  now?: number;
  /** Inject a metadata sample reader (test seam). Defaults to the file-backed reader. */
  metadataReader?: MetadataSampleReader;
  /**
   * Explicit path to a `metadata.jsonl` (or `.jsonl.gz`) dossier. When set,
   * the default reader uses this path verbatim; when unset, the default
   * reader globs `data/apptweak-*` directories under `dataRoot` and picks
   * the latest by directory name.
   */
  metadataPath?: string;
  /**
   * Root directory for the default metadata glob. Defaults to the process
   * cwd. Exposed as a test seam so tests can point at a tmp dir.
   */
  dataRoot?: string;
  /** Suppress logger output (used by tests). */
  silent?: boolean;
}

export interface AuditResult {
  exitCode: 0 | 1;
  report: string;
}

/**
 * Runs the audit and returns the markdown report + exit code.
 *
 * Caller is responsible for writing the report to its destination and
 * propagating the exit code; this lets the CLI shell stay thin and lets
 * tests assert on the report contents directly.
 */
export async function runAudit(opts: AuditOpts = {}): Promise<AuditResult> {
  const dbPath = opts.dbPath ?? "./.cache/selection-agent.sqlite";
  const markets = opts.markets ?? DEFAULT_AUDIT_MARKETS;
  const now = opts.now ?? Date.now();
  const logger = pino({
    name: "selection-agent-audit",
    level: opts.silent ? "silent" : (process.env.LOG_LEVEL ?? "info"),
  });

  if (!existsSync(dbPath)) {
    const report = renderReport({
      results: [
        {
          name: "database access",
          status: "FAIL",
          details: `database not found at ${dbPath}`,
        },
      ],
      dbPath,
      markets,
      now,
    });
    return { exitCode: 1, report };
  }

  logger.info({ dbPath, markets }, "Running runbook pre-flight audit");
  const db = new Database(dbPath);
  try {
    runMigrations(db);
    const reader =
      opts.metadataReader ??
      defaultMetadataReader({ metadataPath: opts.metadataPath, dataRoot: opts.dataRoot });
    const results: CheckResult[] = [
      checkChartCoverage(db, markets),
      checkRankDistribution(db),
      checkRecentDataWindow(db, now),
      checkMetadataPointInTime(reader),
      checkSignalSnapshotsInventory(db),
      checkAppInvariantsCoverage(db),
    ];
    const report = renderReport({ results, dbPath, markets, now });
    const exitCode: 0 | 1 = results.some((r) => r.status === "FAIL") ? 1 : 0;

    if (opts.output) {
      writeFileSync(opts.output, report, "utf8");
      logger.info({ output: opts.output, exitCode }, "Audit report written");
    }

    return { exitCode, report };
  } finally {
    db.close();
  }
}

function renderReport(args: {
  results: CheckResult[];
  dbPath: string;
  markets: readonly string[];
  now: number;
}): string {
  const lines: string[] = [];
  const isoNow = new Date(args.now).toISOString();
  lines.push("# Runbook Discovery — Stage 1 pre-flight audit");
  lines.push("");
  lines.push(`- **DB**: \`${args.dbPath}\``);
  lines.push(`- **Markets**: ${args.markets.join(", ")}`);
  lines.push(`- **As of**: ${isoNow}`);
  lines.push("");

  // Summary line
  const counts = countByStatus(args.results);
  const overall: CheckStatus = counts.FAIL > 0 ? "FAIL" : counts.WARN > 0 ? "WARN" : "PASS";
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `**Overall: ${overall}** — PASS: ${counts.PASS}, WARN: ${counts.WARN}, FAIL: ${counts.FAIL}`,
  );
  lines.push("");
  lines.push("| # | Check | Status |");
  lines.push("|---|---|---|");
  args.results.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.name} | ${r.status} |`);
  });
  lines.push("");

  lines.push("## Details");
  lines.push("");
  args.results.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${r.name} — ${r.status}`);
    lines.push("");
    lines.push("```");
    lines.push(r.details);
    lines.push("```");
    lines.push("");
  });

  if (overall === "FAIL") {
    lines.push("## Next steps");
    lines.push("");
    lines.push(
      "One or more checks FAILed. Per the runbook, do NOT proceed to Stage 2 until the failing checks are resolved (refresh chart data, run app_invariants ingest, or document the gap as a kill criterion).",
    );
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function countByStatus(results: CheckResult[]): Record<CheckStatus, number> {
  const out: Record<CheckStatus, number> = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const r of results) out[r.status] += 1;
  return out;
}

/**
 * Default metadata point-in-time reader.
 *
 * Resolution strategy:
 *   1. If `metadataPath` is provided, use it verbatim (gzip auto-detected by
 *      `.gz` suffix).
 *   2. Otherwise, scan `<dataRoot>/data/apptweak-*` directories, sort
 *      lexicographically (so the latest YYYY-MM-DD wins), and pick the first
 *      that contains `metadata.jsonl` or `metadata.jsonl.gz`.
 *
 * If no file is found, returns an empty list — the check itself handles that
 * case (WARN: cannot evaluate). This avoids a hard fail on fresh clones that
 * have no dossier and keeps the date-stamped private layout out of the
 * published OSS artifact.
 */
export function defaultMetadataReader(
  opts: { metadataPath?: string; dataRoot?: string } = {},
): MetadataSampleReader {
  return (sampleSize: number): MetadataSampleGroup[] => {
    const resolvedPath = resolveMetadataPath(opts);
    if (!resolvedPath) return [];
    const raw = resolvedPath.endsWith(".gz")
      ? gunzipSync(readFileSync(resolvedPath)).toString("utf8")
      : readFileSync(resolvedPath, "utf8");

    // Parse only the first 1000 lines to bound runtime (matches runbook bash
    // sample). We collect t0 + max release_date per (app_id, market, store).
    const groups = new Map<string, { t0: string; maxReleaseDate: string }[]>();
    const lines = raw.split("\n").slice(0, 1000);
    for (const line of lines) {
      if (!line) continue;
      try {
        const d = JSON.parse(line) as {
          app_id?: string;
          market?: string;
          store?: string;
          t0?: string;
          raw?: { metadata?: { versions?: { release_date?: string }[] } };
        };
        const appId = d.app_id;
        const market = d.market;
        const store = d.store;
        const t0 = d.t0;
        if (!appId || !market || !store || !t0) continue;
        const versions = d.raw?.metadata?.versions;
        if (!Array.isArray(versions)) continue;
        let maxRel = "";
        for (const v of versions) {
          const rd = v.release_date ?? "";
          if (rd > maxRel) maxRel = rd;
        }
        const key = `(${appId}, ${market}, ${store})`;
        const cur = groups.get(key) ?? [];
        cur.push({ t0, maxReleaseDate: maxRel });
        groups.set(key, cur);
      } catch {
        // Skip malformed lines.
      }
    }

    const multi: MetadataSampleGroup[] = [];
    for (const [key, records] of groups) {
      if (records.length >= 2) {
        multi.push({ key, records });
        if (multi.length >= sampleSize) break;
      }
    }
    return multi;
  };
}

/**
 * Resolve the metadata file path:
 *   - explicit `metadataPath` wins (auto-decompresses if `.gz`)
 *   - else glob `<dataRoot>/data/apptweak-*` directories, sort by name desc,
 *     return the first that has `metadata.jsonl[.gz]`
 *   - else null (no dossier present)
 *
 * Exported for tests; not part of the package's public API surface.
 */
export function resolveMetadataPath(
  opts: { metadataPath?: string; dataRoot?: string } = {},
): string | null {
  if (opts.metadataPath) {
    return existsSync(opts.metadataPath) ? opts.metadataPath : null;
  }
  const root = opts.dataRoot ?? process.cwd();
  const dataDir = join(root, "data");
  if (!existsSync(dataDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return null;
  }
  // Sort descending so the latest dated directory wins.
  const candidates = entries
    .filter((name) => name.startsWith("apptweak-"))
    .filter((name) => {
      try {
        return statSync(join(dataDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
  for (const name of candidates) {
    const dir = join(dataDir, name);
    const jsonl = join(dir, "metadata.jsonl");
    if (existsSync(jsonl)) return jsonl;
    const gz = join(dir, "metadata.jsonl.gz");
    if (existsSync(gz)) return gz;
  }
  return null;
}
