/**
 * Internal CLI subcommands — gated from npm publish.
 *
 * This file lives in `src/backtest/`, which is NOT in package.json `files:`
 * whitelist (verified by tests/cli/internal-publish-boundary.test.ts via
 * `npm pack --dry-run`). The main CLI dispatcher in `src/cli/index.ts`
 * dynamically imports this module ONLY when `--internal` is passed; the
 * dynamic-import path being absent from the published tarball is fine
 * because the founder runs from the full source tree where it exists.
 *
 * Three subcommands:
 *
 *   - `selection-agent --internal backtest --cohort X --market m --k 10`
 *     Runs runBacktest() and writes a markdown + JSON report under
 *     docs/planning/. Prints a summary table to stdout.
 *
 *   - `selection-agent --internal winner-score --app A --t ISO`
 *     Returns the v1 winner_score for an app. Reads from the winner_scores
 *     table if a row exists for (app, t0); otherwise computes fresh via
 *     computeWinnerScore() (which persists on success).
 *
 *   - `selection-agent --internal opportunity --source-app A --target M`
 *     Builds an Opportunity from current signal_snapshots, persists to the
 *     opportunities table, prints the brief to stdout. Supports --dry-run
 *     so tests don't need a live LLM.
 *
 * Per the v1 build's Codex Round 2 #10 fix — these subcommands MUST stay
 * outside the public npm tarball so the backtest internals aren't visible
 * to OSS consumers.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineCommand } from "citty";
import { formatError } from "../cli/errors.ts";
import { computeWinnerScore } from "../ground-truth/winner-score.ts";
import {
  type OpportunityMarket,
  OpportunityMarketSchema,
  type SignalValues,
} from "../opportunities/schema.ts";
import { renderBrief } from "../reporting/briefs.ts";
import { computeOpportunityScore, SCORING_VERSION } from "../signals/composer.ts";
import { runMigrations } from "../storage/schema.ts";
import {
  type BacktestReport,
  DEFAULT_K_VALUES,
  renderBacktestReportMarkdown,
  runBacktest,
} from "./harness.ts";

const DEFAULT_DB_PATH = "./.cache/selection-agent.sqlite";

/**
 * Open a Database with v1 migrations applied. Centralized so each subcommand
 * uses the same initialization sequence and tests can swap the path.
 */
function openDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // Apply pre-v1 cache schemas (Cache.open does this for the scan path; we
  // duplicate here so an internal-only DB doesn't depend on Cache.open).
  // Pulled in via runMigrations which includes the v0.7.0-baseline ledger
  // entry but not the actual DDL (those are applied via ALL_SCHEMAS in
  // Cache.open). For internal CLI use a fresh DB is rare; in practice the
  // DB is created via `selection-agent scan` first.
  runMigrations(db);
  return db;
}

/**
 * Parse an ISO 8601 datetime string OR a unix-ms integer string into ms.
 * Unix-ms is the preferred internal format; ISO is accepted for
 * human-friendly CLI input. Throws with a clear message on neither.
 */
function parseTimestamp(raw: string, label: string): number {
  if (raw.length === 0) {
    throw new Error(`${label}: empty value (need ISO 8601 datetime or unix-ms integer)`);
  }
  // Try integer first (faster, no Date construction)
  const asInt = Number(raw);
  if (Number.isFinite(asInt) && Number.isInteger(asInt) && asInt > 0) {
    return asInt;
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || Number.isNaN(ms)) {
    throw new Error(
      `${label}: "${raw}" is not a valid ISO 8601 datetime or unix-ms integer (try 2024-01-01T00:00:00Z or 1704067200000)`,
    );
  }
  return ms;
}

function parseMarket(raw: string): OpportunityMarket {
  const result = OpportunityMarketSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `unknown market "${raw}" — accepted: ${OpportunityMarketSchema.options.join(", ")}`,
    );
  }
  return result.data;
}

function parseKValues(raw: unknown, fallback: readonly number[]): number[] {
  if (typeof raw !== "string" || raw.length === 0) return [...fallback];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: number[] = [];
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`invalid --k value "${p}" — expected positive integer (e.g. 5,10,25)`);
    }
    out.push(n);
  }
  return out;
}

const VALID_SIGNAL_KEYS: ReadonlySet<keyof SignalValues> = new Set([
  "locGap",
  "velocity",
  "incumbent_vulnerability",
  "cpi_ltv_proxy",
]);

function parseExcludeSignals(raw: unknown): (keyof SignalValues)[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: (keyof SignalValues)[] = [];
  for (const p of parts) {
    if (!VALID_SIGNAL_KEYS.has(p as keyof SignalValues)) {
      throw new Error(
        `invalid --exclude-signal "${p}" — accepted: ${[...VALID_SIGNAL_KEYS].join(", ")}`,
      );
    }
    out.push(p as keyof SignalValues);
  }
  return out;
}

function parseAppIdsList(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Selects candidate app_ids when --apps wasn't passed: every distinct app_id
 * with at least one chart_snapshots row at or before t0 in the given market.
 */
function selectCandidatesFromCharts(db: Database, market: OpportunityMarket, t0: number): string[] {
  const rows = db
    .prepare<{ app_id: string }, [string, number]>(
      `SELECT DISTINCT app_id FROM chart_snapshots
       WHERE market = ? AND captured_at <= ?
       ORDER BY app_id`,
    )
    .all(market, t0);
  return rows.map((r) => r.app_id);
}

// ─── Subcommand: backtest ─────────────────────────────────────────────

export const backtestCommand = defineCommand({
  meta: {
    name: "backtest",
    description:
      "[INTERNAL] Run v1 backtest harness for a (market, t0) cohort and write a report under docs/planning/",
  },
  args: {
    cohort: {
      type: "string",
      description: "Human-readable cohort label (e.g. 2022-2024-tier2-sea)",
      required: true,
    },
    market: {
      type: "string",
      description: "Market ISO alpha-2 lowercase (id, vn, th, my, ph, bd, us, jp, ...)",
      required: true,
    },
    t0: {
      type: "string",
      description: "Decision date — ISO 8601 datetime or unix-ms integer",
      required: true,
    },
    "t-measure": {
      type: "string",
      description: "Measurement date (default t0 + 12 months) — ISO 8601 or unix-ms",
    },
    apps: {
      type: "string",
      description:
        "Comma-separated candidate app_ids; defaults to every app with chart_snapshots in market at/before t0",
    },
    k: {
      type: "string",
      description: `Comma-separated K values for precision@K (default ${DEFAULT_K_VALUES.join(",")})`,
    },
    db: {
      type: "string",
      description: `SQLite DB path (default ${DEFAULT_DB_PATH})`,
    },
    "out-dir": {
      type: "string",
      description: "Directory to write the report (default docs/planning)",
      default: "docs/planning",
    },
    "exclude-signal": {
      type: "string",
      description:
        "Comma-separated signals to drop from the v1 ranker before scoring (one of: locGap, velocity, incumbent_vulnerability, cpi_ltv_proxy). Used for ablation studies.",
    },
  },
  async run({ args }) {
    try {
      const cohort = String(args.cohort);
      const market = parseMarket(String(args.market));
      const t0 = parseTimestamp(String(args.t0), "--t0");
      const t_measure =
        typeof args["t-measure"] === "string" && args["t-measure"].length > 0
          ? parseTimestamp(args["t-measure"], "--t-measure")
          : undefined;
      const k_values = parseKValues(args.k, DEFAULT_K_VALUES);
      const dbPath =
        (typeof args.db === "string" && args.db.length > 0
          ? args.db
          : process.env.SELECTION_AGENT_DB) ?? DEFAULT_DB_PATH;
      const outDir = String(args["out-dir"] ?? "docs/planning");

      const db = openDb(dbPath);
      let report: BacktestReport;
      try {
        const candidateIds = parseAppIdsList(args.apps);
        const candidate_app_ids =
          candidateIds.length > 0 ? candidateIds : selectCandidatesFromCharts(db, market, t0);
        const exclude_signals = parseExcludeSignals(args["exclude-signal"]);
        report = runBacktest(db, {
          cohort_label: cohort,
          market,
          t0,
          t_measure,
          candidate_app_ids,
          k_values,
          exclude_signals,
        });
      } finally {
        db.close();
      }

      // Write report. Markdown for human reading, JSON sidecar for tooling.
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const baseName = `agent-v1-backtest-${cohort}-${market}-${ts}`;
      const mdPath = resolve(outDir, `${baseName}.md`);
      const jsonPath = resolve(outDir, `${baseName}.json`);
      mkdirSync(dirname(mdPath), { recursive: true });
      writeFileSync(mdPath, renderBacktestReportMarkdown(report), "utf8");
      writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

      // Print summary to stdout
      process.stdout.write(`Backtest complete — wrote ${mdPath}\n`);
      process.stdout.write(
        `Candidates: ${report.candidate_count} | Eligible: ${report.eligible_count} | Winners: ${report.winner_count}\n`,
      );
      for (const row of report.precision) {
        const lift = row.lift_v1 === 999 ? "∞" : row.lift_v1.toFixed(2);
        process.stdout.write(
          `  K=${row.k}  v1=${row.v1.toFixed(2)}  locGap=${row.locGap_only.toFixed(2)}  velocity=${row.velocity_only.toFixed(2)}  random=${row.random_baseline.toFixed(2)}  lift=${lift}\n`,
        );
      }
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${formatError({
          code: "BACKTEST_FAILED",
          message,
          cause: "runBacktest threw before producing a report.",
          fix: "Check --t0 / --market values, ensure DB has signal_snapshots + chart_snapshots seeded.",
          docs: "docs/planning/agent-v1-foundation.md § v1 backtest harness",
        })}\n`,
      );
      process.exit(1);
    }
  },
});

// ─── Subcommand: winner-score ────────────────────────────────────────

export const winnerScoreCommand = defineCommand({
  meta: {
    name: "winner-score",
    description:
      "[INTERNAL] Compute or fetch the v1 winner_score (forward-looking ground-truth label) for an app.",
  },
  args: {
    app: {
      type: "string",
      description: "App identifier (Apple bundle id or Google package name)",
      required: true,
    },
    t: {
      type: "string",
      description: "Decision date t0 — ISO 8601 datetime or unix-ms integer",
      required: true,
    },
    "t-measure": {
      type: "string",
      description: "Measurement date (default t0 + 12 months) — ISO 8601 or unix-ms",
    },
    db: {
      type: "string",
      description: `SQLite DB path (default ${DEFAULT_DB_PATH})`,
    },
  },
  async run({ args }) {
    try {
      const app = String(args.app);
      const t0 = parseTimestamp(String(args.t), "--t");
      const t_measure =
        typeof args["t-measure"] === "string" && args["t-measure"].length > 0
          ? parseTimestamp(args["t-measure"], "--t-measure")
          : t0 + 12 * 30 * 24 * 60 * 60 * 1000;
      const dbPath =
        (typeof args.db === "string" && args.db.length > 0
          ? args.db
          : process.env.SELECTION_AGENT_DB) ?? DEFAULT_DB_PATH;

      const db = openDb(dbPath);
      try {
        // Existing row?
        const existing = db
          .prepare<
            { score: number; tier: string; formula_version: string; computed_at: number },
            [string, number]
          >(
            "SELECT score, tier, formula_version, computed_at FROM winner_scores WHERE app_id = ? AND t0 = ?",
          )
          .get(app, t0);
        if (existing) {
          process.stdout.write(
            `${JSON.stringify(
              {
                app_id: app,
                t0,
                t_measure,
                source: "winner_scores cache",
                score: existing.score,
                tier: existing.tier,
                formula_version: existing.formula_version,
                computed_at: existing.computed_at,
              },
              null,
              2,
            )}\n`,
          );
          process.exit(0);
          return;
        }
        const result = computeWinnerScore(db, app, t0, t_measure);
        if (result === null) {
          process.stderr.write(
            `${formatError({
              code: "NO_DATA",
              message: `app ${app} has zero observable data at or before t_measure=${new Date(t_measure).toISOString()}`,
              cause:
                "computeWinnerScore returned null — no chart_snapshots or signal_snapshots rows for this app at t<=t_measure.",
              fix: "Seed chart_snapshots and/or signal_snapshots for this app, then retry.",
              docs: "docs/planning/agent-v1-foundation.md § v1 ground truth",
            })}\n`,
          );
          process.exit(2);
          return;
        }
        process.stdout.write(
          `${JSON.stringify(
            {
              app_id: app,
              t0,
              t_measure,
              source: "fresh computation",
              score: result.score,
              tier: result.tier,
            },
            null,
            2,
          )}\n`,
        );
        process.exit(0);
      } finally {
        db.close();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${formatError({
          code: "WINNER_SCORE_FAILED",
          message,
          cause: "computeWinnerScore threw before producing a result.",
          fix: "Verify --app + --t arguments and DB integrity.",
          docs: "docs/planning/agent-v1-foundation.md § v1 ground truth",
        })}\n`,
      );
      process.exit(1);
    }
  },
});

// ─── Subcommand: opportunity ─────────────────────────────────────────

export const opportunityCommand = defineCommand({
  meta: {
    name: "opportunity",
    description:
      "[INTERNAL] Build an Opportunity from current signal_snapshots, persist to opportunities table, print brief to stdout.",
  },
  args: {
    "source-app": {
      type: "string",
      description: "Source app id (the incumbent/inspiration)",
      required: true,
    },
    target: {
      type: "string",
      description: "Target market ISO alpha-2 lowercase",
      required: true,
    },
    "source-market": {
      type: "string",
      description: "Source market ISO alpha-2 lowercase (default us)",
      default: "us",
    },
    category: {
      type: "string",
      description: "Opportunity category (default productivity)",
      default: "productivity",
    },
    t: {
      type: "string",
      description: "Reference timestamp for signal lookup — ISO 8601 or unix-ms (default now)",
    },
    "dry-run": {
      type: "boolean",
      description:
        "Skip the LLM thesis call (placeholder text); avoids ANTHROPIC_API_KEY dependency in tests",
      default: false,
    },
    db: {
      type: "string",
      description: `SQLite DB path (default ${DEFAULT_DB_PATH})`,
    },
  },
  async run({ args }) {
    try {
      const sourceApp = String(args["source-app"]);
      const targetMarket = parseMarket(String(args.target));
      const sourceMarket = parseMarket(String(args["source-market"] ?? "us"));
      const category = String(args.category ?? "productivity");
      const t =
        typeof args.t === "string" && args.t.length > 0
          ? parseTimestamp(args.t, "--t")
          : Date.now();
      const dryRun = args["dry-run"] === true;
      const dbPath =
        (typeof args.db === "string" && args.db.length > 0
          ? args.db
          : process.env.SELECTION_AGENT_DB) ?? DEFAULT_DB_PATH;

      const db = openDb(dbPath);
      try {
        // Pull latest signal values for the source app (latest per signal at t<=ref).
        const signalRows = db
          .prepare<{ signal_name: string; value: number | null; t: number }, [string, number]>(
            `SELECT signal_name, value, t
               FROM signal_snapshots
               WHERE app_id = ? AND t <= ?
               ORDER BY t DESC`,
          )
          .all(sourceApp, t);
        const signal_values: Record<string, number | null> = {};
        const seen = new Set<string>();
        for (const row of signalRows) {
          if (seen.has(row.signal_name)) continue;
          seen.add(row.signal_name);
          if (row.value === null) continue;
          if (
            row.signal_name === "locGap" ||
            row.signal_name === "velocity" ||
            row.signal_name === "incumbent_vulnerability" ||
            row.signal_name === "cpi_ltv_proxy"
          ) {
            signal_values[row.signal_name] = row.value;
          }
        }
        const composer = computeOpportunityScore(signal_values);
        const id = crypto.randomUUID();
        const generated_at_ms = Date.now();
        const opportunity = {
          id,
          generated_at: new Date(generated_at_ms).toISOString(),
          source_app_id: sourceApp,
          source_market: sourceMarket,
          target_market: targetMarket,
          category,
          signal_values: signal_values,
          predicted: { validation_budget_usd: 500 },
          kill_metric: { metric: "roas_d14", threshold: 0.4, direction: "below" as const },
          score: composer.score,
          eligible: composer.eligible,
          thesis: `Opportunity built from latest signal_snapshots for ${sourceApp} → ${targetMarket}. Composer score: ${composer.score === null ? "n/a (N<3 signals)" : composer.score.toFixed(2)}/10.`,
          evidence: [
            {
              url: `https://internal.local/${sourceApp}`,
              claim: "Internal pipeline-built opportunity (no external citations).",
            },
          ],
          metadata: {
            signal_pipeline_version: "v1.0.0",
            scoring_version: SCORING_VERSION,
            built_via: "internal-cli-opportunity",
          },
        };

        // Persist to opportunities table
        db.prepare(
          `INSERT INTO opportunities (
             id, generated_at, source_app_id, source_market, target_market, category,
             sig_loc_gap, sig_velocity, sig_incumbent_vuln, sig_cpi_ltv_proxy,
             pred_cpi_low, pred_cpi_high, pred_ltv_low, pred_ltv_high, pred_validation_budget,
             kill_metric_name, kill_metric_threshold, kill_metric_direction,
             outcome_measured_at, outcome_metric_value, outcome_label, outcome_revenue_proven,
             score, eligible, thesis, evidence_json, metadata_json,
             signal_pipeline_version, scoring_version
           ) VALUES (
             ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?,
             ?, ?, ?, ?, ?,
             ?, ?, ?,
             ?, ?, ?, ?,
             ?, ?, ?, ?, ?,
             ?, ?
           )`,
        ).run(
          opportunity.id,
          generated_at_ms,
          opportunity.source_app_id,
          opportunity.source_market,
          opportunity.target_market,
          opportunity.category,
          opportunity.signal_values.locGap ?? null,
          opportunity.signal_values.velocity ?? null,
          opportunity.signal_values.incumbent_vulnerability ?? null,
          opportunity.signal_values.cpi_ltv_proxy ?? null,
          opportunity.predicted.validation_budget_usd ?? null,
          null,
          null,
          null,
          null, // pred_cpi_high, pred_ltv_low, pred_ltv_high, pred_validation_budget reordered
          opportunity.kill_metric.metric,
          opportunity.kill_metric.threshold,
          opportunity.kill_metric.direction,
          null,
          null,
          null,
          null,
          opportunity.score,
          opportunity.eligible ? 1 : 0,
          opportunity.thesis,
          JSON.stringify(opportunity.evidence),
          JSON.stringify(opportunity.metadata),
          "v1.0.0",
          SCORING_VERSION,
        );

        // Render brief — dryRun bypasses the LLM call
        const brief = await renderBrief(
          {
            ...opportunity,
            signal_values: opportunity.signal_values as Record<string, number | null>,
          } as Parameters<typeof renderBrief>[0],
          { dryRun },
        );
        process.stdout.write(`${brief}\n`);
        process.exit(0);
      } finally {
        db.close();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${formatError({
          code: "OPPORTUNITY_FAILED",
          message,
          cause: "Opportunity assembly threw before persisting.",
          fix: "Verify --source-app + --target arguments and DB integrity. Use --dry-run to skip LLM.",
          docs: "docs/planning/agent-v1-foundation.md § Opportunity contract",
        })}\n`,
      );
      process.exit(1);
    }
  },
});

// ─── Dispatcher ───────────────────────────────────────────────────────

/**
 * Get a subcommand by name. Returns undefined for unknown names so the
 * caller can render a clear error rather than crashing on a missing
 * subcommand. Centralized so tests can iterate the available list.
 */
export const INTERNAL_SUBCOMMANDS = Object.freeze({
  backtest: backtestCommand,
  "winner-score": winnerScoreCommand,
  opportunity: opportunityCommand,
}) as Record<string, ReturnType<typeof defineCommand>>;

export type InternalSubcommandName = keyof typeof INTERNAL_SUBCOMMANDS;
