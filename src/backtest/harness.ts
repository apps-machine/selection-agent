/**
 * v1 backtest harness — does the v1 signal pipeline actually predict winners?
 *
 * The harness answers ONE question with measurable rigor: take a historical
 * decision date `t0`, recompute v1 opportunity scores from data that was
 * observable at or before `t0`, then check 12 months later (`t_measure`)
 * whether the apps the v1 ranker put in its top-K actually won.
 *
 * Pipeline:
 *
 *   1. freezeCohort(market, t0, candidate_app_ids) — captures the cohort as
 *      it existed at t0. The cohort_freezes row makes the universe immutable
 *      across re-runs (Codex Round 2 #9 — leakage-by-cohort-drift would let a
 *      "successful" backtest hide the fact that we silently dropped losers).
 *
 *   2. getFrozenCohortFeatures(freeze) — reads ONLY signal_snapshots with
 *      `t <= freeze.t0`. The function THROWS if any frozen app has a
 *      signal_snapshot row at `t > freeze.t0`. Surface-not-silently-filter
 *      is the entire point: a row beyond the cutoff means the upstream
 *      signal pipeline is leaking; better to crash the backtest than to
 *      ship a deceptively-good precision number. (See cohort-freeze.ts for
 *      the leakage detection contract.)
 *
 *   3. Group rows by app_id into a synthetic SignalValues. A signal name maps
 *      to the OpportunitySchema field via SIGNAL_NAME_TO_SCHEMA_KEY. Multiple
 *      rows for the same (app, signal) keep the LATEST `t` (closest to t0
 *      without exceeding it). Missing signals stay null — the composer
 *      enforces the N>=3 eligibility rule and returns `eligible: false`
 *      otherwise; ineligible apps are excluded from the ranking.
 *
 *   4. computeOpportunityScore(signalValues) — top-3 robust mean. Same code
 *      production uses; the backtest is the regression net.
 *
 *   5. Rank eligible apps by score descending; take top-K.
 *
 *   6. Join to winner_scores at t_measure. precision@K = (winners in top-K) / K.
 *      "Winner" is the tier produced by computeWinnerScore — apps with no
 *      winner_scores row are tier=null and counted as non-winners (they're
 *      candidates the ground-truth pipeline couldn't label).
 *
 *   7. Baseline rankings — same precision@K computation but ranking on a
 *      single signal:
 *        - locGap_only: the existing v0.7 selection-agent's primary signal
 *        - velocity_only: chart-momentum-only proxy
 *      Apps with that signal == null are excluded from the baseline ranking
 *      (parallel to the eligibility rule). Lift = v1_precision / baseline.
 *
 * Reproducibility (Codex Round 2 #6): the harness NEVER calls a live LLM.
 * Every signal value is read from signal_snapshots, which already archives
 * `llm_response_archived` from the original pipeline run. Same DB rows ⇒
 * same SignalValues ⇒ same computeOpportunityScore output ⇒ same
 * BacktestReport. Two consecutive runs produce identical reports.
 *
 * Lift-formula edge case: when the baseline catches zero winners in top-K,
 * we return Infinity (computed lift) capped at a documented sentinel
 * (`LIFT_INFINITY_SENTINEL = 999`). The sentinel is non-Infinity so the
 * report can be JSON-serialized safely; readers MUST understand the value
 * means "v1 catches winners that the baseline catches zero of," not a
 * literal numeric ratio.
 */

import type { Database } from "bun:sqlite";
import type { OpportunityMarket, SignalValues } from "../opportunities/schema.ts";
import { freezeCohort, getFrozenCohortFeatures } from "../orchestrator/cohort-freeze.ts";
import { computeOpportunityScore } from "../signals/composer.ts";

/**
 * Map signal_snapshots.signal_name → SignalValues field. Centralized so
 * adding a new signal in v2 is a one-line change here + the composer's
 * SIGNAL_KEYS list. signal_names not in this map are silently ignored
 * during backtest assembly (e.g., 'thesis' rows from briefs.ts persistence).
 */
const SIGNAL_NAME_TO_SCHEMA_KEY: Readonly<Record<string, keyof SignalValues>> = Object.freeze({
  locGap: "locGap",
  velocity: "velocity",
  incumbent_vulnerability: "incumbent_vulnerability",
  cpi_ltv_proxy: "cpi_ltv_proxy",
});

/**
 * Default measurement horizon (12 months). Used when BacktestOptions.t_measure
 * is omitted. Matches the v1 spec's t0+12mo forward-looking ground truth.
 */
const DEFAULT_T_MEASURE_OFFSET_MS = 12 * 30 * 24 * 60 * 60 * 1000;

/**
 * Default precision@K cutoffs. Multiple values in one report so the founder
 * can see whether v1 holds up across narrow (top-5) vs broad (top-50) cuts
 * in a single run.
 */
export const DEFAULT_K_VALUES: readonly number[] = [5, 10, 25, 50] as const;

/**
 * Sentinel returned for lift when the baseline precision@K is zero. Read as
 * "v1 caught winners the baseline missed entirely." Capped at 999 so the
 * field is JSON-serializable; bigger numbers are nonsensical anyway.
 */
export const LIFT_INFINITY_SENTINEL = 999;

export interface BacktestOptions {
  /** Human-readable cohort label (e.g., "2022-2024-tier2-sea"). Echoed into the report. */
  cohort_label: string;
  /** Market the cohort is frozen for. */
  market: OpportunityMarket;
  /** Decision date — unix milliseconds. */
  t0: number;
  /** Measurement date — unix milliseconds. Defaults to t0 + 12mo. */
  t_measure?: number;
  /** Apps to evaluate. Each must have ≥1 chart_snapshots row at or before t0. */
  candidate_app_ids: string[];
  /** Precision@K cutoffs to report. Defaults to DEFAULT_K_VALUES. */
  k_values?: number[];
  /**
   * Skip the freezeCohort write (and use this freeze instead). Used by
   * tests that need to inject a freeze constructed in-test, and by callers
   * that have already frozen the cohort in a prior step.
   */
  existing_freeze?: { t0: number; market: OpportunityMarket; app_ids: string[] };
}

/**
 * One precision-row per K value. v1 = the harness's top-3-mean ranker.
 * locGap_only / velocity_only = single-signal baseline rankers. lift_v1
 * is v1 precision divided by locGap_only precision (the most direct
 * apples-to-apples comparison: what would v0.7 selection-agent have caught?).
 */
export interface PrecisionRow {
  k: number;
  v1: number;
  locGap_only: number;
  velocity_only: number;
  /** v1 precision / locGap_only precision. Sentinel LIFT_INFINITY_SENTINEL when baseline is 0. */
  lift_v1: number;
}

/** One row per app in the v1 top-K ranking, persisted in the report for audit. */
export interface RankedAppRow {
  app_id: string;
  score: number;
  tier: "winner" | "marginal" | "loser" | null;
}

export interface BacktestReport {
  cohort_label: string;
  market: OpportunityMarket;
  t0: number;
  t_measure: number;
  candidate_count: number;
  /** Apps for which the composer returned eligible=true (≥3 non-null signals). */
  eligible_count: number;
  /** Apps tagged tier='winner' in winner_scores at t_measure. */
  winner_count: number;
  precision: PrecisionRow[];
  details: {
    /** Top-K of v1's ranking, where K = max(k_values). */
    top_k_v1: RankedAppRow[];
  };
}

interface RankedApp {
  app_id: string;
  score: number;
}

/**
 * Run a v1 backtest for one cohort.
 *
 * Reads ONLY frozen signal_snapshots (via getFrozenCohortFeatures); never
 * calls a live LLM. Re-running with the same DB + same options produces
 * an identical BacktestReport.
 *
 * Throws when:
 *  - candidate_app_ids is empty (no cohort to evaluate)
 *  - getFrozenCohortFeatures detects a leakage row (post-t0 signal in DB
 *    for a frozen app — bug in upstream signal pipeline)
 *  - existing_freeze is provided but doesn't match (market, t0)
 */
export function runBacktest(db: Database, opts: BacktestOptions): BacktestReport {
  const t_measure = opts.t_measure ?? opts.t0 + DEFAULT_T_MEASURE_OFFSET_MS;
  const k_values = opts.k_values ?? [...DEFAULT_K_VALUES];

  if (opts.candidate_app_ids.length === 0) {
    // Empty cohort — return a zero-padded report instead of throwing. Callers
    // batching across many (market, t0) tuples shouldn't crash on empty
    // slices; an empty report is itself a useful negative finding.
    return {
      cohort_label: opts.cohort_label,
      market: opts.market,
      t0: opts.t0,
      t_measure,
      candidate_count: 0,
      eligible_count: 0,
      winner_count: 0,
      precision: k_values.map((k) => ({
        k,
        v1: 0,
        locGap_only: 0,
        velocity_only: 0,
        lift_v1: 0,
      })),
      details: { top_k_v1: [] },
    };
  }

  // Reuse an existing freeze if the caller already produced one (tests do
  // this so they can construct freezes without going through freezeCohort's
  // chart_snapshots prerequisite check; production callers leave this
  // undefined and freeze inline).
  const freeze = opts.existing_freeze
    ? {
        ...opts.existing_freeze,
        frozen_at: Date.now(),
      }
    : freezeCohort(db, opts.market, opts.t0, opts.candidate_app_ids);

  // Read frozen features. Throws on leakage (post-t0 signal_snapshots row
  // for a frozen app). The throw is the leakage guarantee — if this line
  // returns, every row in `rows` has `t <= freeze.t0`.
  const rows = getFrozenCohortFeatures(db, freeze);

  // Assemble per-app SignalValues by picking the LATEST observation per
  // (app, signal). "Latest" honors the time cutoff because rows already
  // satisfy `t <= freeze.t0`.
  const perApp = new Map<string, { signals: SignalValues; latestPerSignal: Map<string, number> }>();
  for (const id of freeze.app_ids) {
    perApp.set(id, { signals: {}, latestPerSignal: new Map() });
  }

  for (const r of rows) {
    const slot = perApp.get(r.app_id);
    if (!slot) continue; // app not in the frozen cohort (shouldn't happen — defensive)
    const schemaKey = SIGNAL_NAME_TO_SCHEMA_KEY[r.signal_name];
    if (!schemaKey) continue; // not a v1 ranking signal (e.g., 'thesis', 'review_count')
    if (r.value === null) continue; // null values can't enter the composer
    const prevT = slot.latestPerSignal.get(r.signal_name);
    if (prevT === undefined || r.t > prevT) {
      slot.signals[schemaKey] = r.value;
      slot.latestPerSignal.set(r.signal_name, r.t);
    }
  }

  // Score every app. Apps with N<3 non-null signals get eligible=false and
  // are excluded from the v1 ranking.
  const v1Ranked: RankedApp[] = [];
  for (const [app_id, { signals }] of perApp) {
    const result = computeOpportunityScore(signals);
    if (result.eligible && result.score !== null) {
      v1Ranked.push({ app_id, score: result.score });
    }
  }
  v1Ranked.sort((a, b) => b.score - a.score);

  // Baselines — single-signal rankers. Apps with that signal null are
  // excluded from the baseline (parallel to the v1 eligibility rule).
  const locGapRanked = singleSignalRanking(perApp, "locGap");
  const velocityRanked = singleSignalRanking(perApp, "velocity");

  // Read winner_scores at t_measure. We tolerate `measured_at != t_measure`
  // because the production winner-score pipeline records the actual
  // measured_at timestamp; backtests across cohorts may align on the
  // closest measurement. v1 keeps it strict: only rows where
  // `winner_scores.measured_at = t_measure AND winner_scores.t0 = freeze.t0`
  // count. v2 may add tolerance once cross-cohort backtests reveal the need.
  const tierByApp = readWinnerTiers(db, freeze.app_ids, freeze.t0, t_measure);

  const winner_count = [...tierByApp.values()].filter((t) => t === "winner").length;

  const precision = k_values.map<PrecisionRow>((k) => {
    const v1 = precisionAtK(v1Ranked, tierByApp, k);
    const locGap_only = precisionAtK(locGapRanked, tierByApp, k);
    const velocity_only = precisionAtK(velocityRanked, tierByApp, k);
    const lift_v1 = computeLift(v1, locGap_only);
    return { k, v1, locGap_only, velocity_only, lift_v1 };
  });

  // top_k_v1 details: K = max(k_values). Caller can slice further at
  // render time. Each row carries (app_id, score, tier) so the report
  // shows WHICH apps the ranker chose.
  const maxK = Math.max(...k_values);
  const top_k_v1: RankedAppRow[] = v1Ranked
    .slice(0, maxK)
    .map((r) => ({ app_id: r.app_id, score: r.score, tier: tierByApp.get(r.app_id) ?? null }));

  return {
    cohort_label: opts.cohort_label,
    market: opts.market,
    t0: opts.t0,
    t_measure,
    candidate_count: freeze.app_ids.length,
    eligible_count: v1Ranked.length,
    winner_count,
    precision,
    details: { top_k_v1 },
  };
}

// ─── Internals ────────────────────────────────────────────────────────

function singleSignalRanking(
  perApp: Map<string, { signals: SignalValues; latestPerSignal: Map<string, number> }>,
  key: keyof SignalValues,
): RankedApp[] {
  const out: RankedApp[] = [];
  for (const [app_id, { signals }] of perApp) {
    const v = signals[key];
    if (v == null || !Number.isFinite(v)) continue;
    out.push({ app_id, score: v });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function precisionAtK(
  ranked: RankedApp[],
  tierByApp: Map<string, "winner" | "marginal" | "loser">,
  k: number,
): number {
  if (k <= 0) return 0;
  const topK = ranked.slice(0, k);
  if (topK.length === 0) return 0;
  let winners = 0;
  for (const r of topK) {
    if (tierByApp.get(r.app_id) === "winner") winners += 1;
  }
  // Denominator is the requested K, NOT topK.length. precision@10 with only
  // 4 ranked apps is "we promised 10 winners; how many of the requested 10
  // did we deliver?" Padding the denominator avoids gaming the metric by
  // shrinking the eligible set.
  return winners / k;
}

function computeLift(v1: number, baseline: number): number {
  if (baseline <= 0) {
    // v1 catches a winner the baseline missed entirely. Return 0 if v1 also
    // missed (no lift to report); else return the documented sentinel so
    // the JSON-serialized report stays finite.
    return v1 <= 0 ? 0 : LIFT_INFINITY_SENTINEL;
  }
  return v1 / baseline;
}

function readWinnerTiers(
  db: Database,
  app_ids: readonly string[],
  t0: number,
  t_measure: number,
): Map<string, "winner" | "marginal" | "loser"> {
  if (app_ids.length === 0) return new Map();
  const placeholders = app_ids.map(() => "?").join(",");
  const rows = db
    .prepare<{ app_id: string; tier: "winner" | "marginal" | "loser" }, (string | number)[]>(
      `SELECT app_id, tier FROM winner_scores
       WHERE app_id IN (${placeholders}) AND t0 = ? AND measured_at = ?`,
    )
    .all(...app_ids, t0, t_measure);
  const out = new Map<string, "winner" | "marginal" | "loser">();
  for (const r of rows) out.set(r.app_id, r.tier);
  return out;
}

// ─── Report rendering ─────────────────────────────────────────────────

/**
 * Render a BacktestReport into a markdown digest for human reading +
 * archival in docs/planning/. The same report is also written as a JSON
 * sidecar by the CLI so downstream tooling can parse it without scraping.
 */
export function renderBacktestReportMarkdown(report: BacktestReport): string {
  const lines: string[] = [];
  lines.push(`# v1 Backtest Report — ${report.cohort_label}`);
  lines.push("");
  lines.push(`- Market: ${report.market}`);
  lines.push(`- t0: ${new Date(report.t0).toISOString()} (${report.t0})`);
  lines.push(`- t_measure: ${new Date(report.t_measure).toISOString()} (${report.t_measure})`);
  lines.push(`- Candidates: ${report.candidate_count}`);
  lines.push(`- Eligible (N≥3 signals): ${report.eligible_count}`);
  lines.push(`- Winners (winner_score tier=winner at t_measure): ${report.winner_count}`);
  lines.push("");
  lines.push("## Precision @ K");
  lines.push("");
  lines.push("| K | v1 | locGap_only | velocity_only | lift over locGap |");
  lines.push("|---|----|-------------|----------------|------------------|");
  for (const row of report.precision) {
    const lift = row.lift_v1 === LIFT_INFINITY_SENTINEL ? "∞ (baseline=0)" : row.lift_v1.toFixed(2);
    lines.push(
      `| ${row.k} | ${row.v1.toFixed(2)} | ${row.locGap_only.toFixed(2)} | ${row.velocity_only.toFixed(2)} | ${lift} |`,
    );
  }
  lines.push("");
  lines.push(`## Top ${report.details.top_k_v1.length} v1 picks`);
  lines.push("");
  lines.push("| Rank | App | Score | Tier |");
  lines.push("|------|-----|-------|------|");
  report.details.top_k_v1.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.app_id} | ${r.score.toFixed(2)} | ${r.tier ?? "(unlabelled)"} |`);
  });
  lines.push("");
  return lines.join("\n");
}
