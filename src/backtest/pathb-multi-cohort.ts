/**
 * Multi-cohort Path B' backtest runner.
 *
 * Loops over the (market, t0) measurement points: 5 SEA markets × 12 monthly
 * t0s = 60 SEA cohorts + 5 tier-1 markets × 2 paired t0s = 10 tier-1 cohorts
 * = 70 total cohort runs. The aggregate paired-comparison delta at the
 * 2 paired t0s (2025-08-04 + 2026-02-04) averages across the 5 SEA markets
 * vs the 5 tier-1 markets at those exact dates.
 *
 * Returns per-cohort reports + aggregate stats:
 *   - mean precision@K per tier (sea / tier1)
 *   - paired-comparison delta at 2025-08-04 + 2026-02-04 (the only t0s where
 *     SEA and tier-1 are both enriched)
 *
 * The aggregate is what powers the verdict in agent-v1-path-b-results.md.
 */
import type { Database } from "bun:sqlite";
import { type OpportunityMarket, OpportunityMarketSchema } from "../opportunities/schema.ts";
import { type BacktestReport, DEFAULT_K_VALUES, runBacktest } from "./harness.ts";

const T_MEASURE_MS = Date.parse("2026-05-04T00:00:00Z");

function isoToMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

const SEA_MARKETS = ["id", "vn", "th", "my", "bd"] as const;
const TIER1_MARKETS = ["us", "jp", "kr", "br", "mx"] as const;
const SEA_T0_ISOS = [
  "2025-05-04",
  "2025-06-04",
  "2025-07-04",
  "2025-08-04",
  "2025-09-04",
  "2025-10-04",
  "2025-11-04",
  "2025-12-04",
  "2026-01-04",
  "2026-02-04",
  "2026-03-04",
  "2026-04-04",
] as const;
const TIER1_T0_ISOS = ["2025-08-04", "2026-02-04"] as const;

export type PathBMode = "survival" | "entrants" | "fresh";

export interface RunPathBBacktestsOptions {
  /**
   * Cohort selection mode. Default "survival" (preserves the original
   * verdict's setup: any app with rank ≤ 200 at or before t0).
   *
   * "entrants" filters to apps at rank 101-200 within t0 ± 7 days — the
   * challengers near the top. Tests "do well-localized challengers break
   * into top-100?" (the disruption thesis). NOTE: AppTweak chart_snapshots
   * is top-100 only, so this mode currently returns empty cohorts. Kept
   * for documentation; revisit after pulling deeper chart depth.
   *
   * "fresh" filters to apps WHOSE FIRST chart appearance in this market
   * is ≤ 90 days before t0 AND who are present in top-100 at t0 ± 7 days.
   * Tests "do well-localized fresh entrants STAY in top-100?" — the
   * adaptation of the disruption thesis to top-100-only chart data.
   */
  mode?: PathBMode;
}

const ENTRANT_RANK_MIN = 101;
const ENTRANT_RANK_MAX = 200;
const ENTRANT_T0_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Window over which the app's first chart appearance must fall for the "fresh"
 * cohort. Calibrated to 90 days as a heuristic — apps that climbed into
 * top-100 within the last 90 days are "fresh entrants" still finding their
 * footing; apps with longer chart tenure are entrenched. v2 could parameterize.
 */
const FRESH_FIRST_SEEN_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface CohortDef {
  market: OpportunityMarket;
  t0: number;
  t0Iso: string;
  tier: "sea" | "tier1";
}

export const PATHB_COHORTS: readonly CohortDef[] = [
  ...SEA_MARKETS.flatMap((m) =>
    SEA_T0_ISOS.map<CohortDef>((iso) => ({
      market: OpportunityMarketSchema.parse(m),
      t0: isoToMs(iso),
      t0Iso: iso,
      tier: "sea",
    })),
  ),
  ...TIER1_MARKETS.flatMap((m) =>
    TIER1_T0_ISOS.map<CohortDef>((iso) => ({
      market: OpportunityMarketSchema.parse(m),
      t0: isoToMs(iso),
      t0Iso: iso,
      tier: "tier1",
    })),
  ),
];

export interface MultiCohortReport {
  generated_at: number;
  t_measure: number;
  cohort_reports: BacktestReport[];
  aggregate: {
    /** Mean precision@K per K, per tier — averaged over each tier's cohorts. */
    sea_mean: {
      k: number;
      v1: number;
      locGap_only: number;
      velocity_only: number;
      random: number;
    }[];
    tier1_mean: {
      k: number;
      v1: number;
      locGap_only: number;
      velocity_only: number;
      random: number;
    }[];
    /**
     * Paired-comparison: SEA precision@K minus tier-1 precision@K, computed at
     * 2025-08-04 and 2026-02-04 (the two t0s where both tiers are enriched).
     * Positive deltas = SEA outperforms tier-1 = thesis lives.
     */
    paired_delta_2025_08: { k: number; sea_v1: number; tier1_v1: number; delta: number }[];
    paired_delta_2026_02: { k: number; sea_v1: number; tier1_v1: number; delta: number }[];
  };
}

function selectCandidates(
  db: Database,
  market: OpportunityMarket,
  t0: number,
  mode: PathBMode,
): string[] {
  if (mode === "entrants") {
    const rows = db
      .prepare<{ app_id: string }, [string, number, number, number, number]>(
        `SELECT DISTINCT app_id FROM chart_snapshots
         WHERE market = ?
           AND captured_at BETWEEN ? AND ?
           AND rank >= ? AND rank <= ?
         ORDER BY app_id`,
      )
      .all(
        market,
        t0 - ENTRANT_T0_WINDOW_MS,
        t0 + ENTRANT_T0_WINDOW_MS,
        ENTRANT_RANK_MIN,
        ENTRANT_RANK_MAX,
      );
    return rows.map((r) => r.app_id);
  }
  if (mode === "fresh") {
    // Apps present in top-100 within (t0 - 7d, t0] AND whose first appearance
    // in this market's chart_snapshots is at-or-after t0 - 90d. The presence
    // window stops at t0 (not t0 + 7d) so freezeCohort's "captured_at <= t0"
    // sanity check is satisfied for every candidate.
    const rows = db
      .prepare<{ app_id: string }, [string, number, string, number, number]>(
        `SELECT app_id
         FROM chart_snapshots
         WHERE market = ?
         GROUP BY app_id
         HAVING MIN(captured_at) >= ?
            AND EXISTS (
              SELECT 1 FROM chart_snapshots c2
              WHERE c2.app_id = chart_snapshots.app_id
                AND c2.market = ?
                AND c2.captured_at BETWEEN ? AND ?
                AND c2.rank <= 100
            )
         ORDER BY app_id`,
      )
      .all(market, t0 - FRESH_FIRST_SEEN_WINDOW_MS, market, t0 - ENTRANT_T0_WINDOW_MS, t0);
    return rows.map((r) => r.app_id);
  }
  // Default "survival": existing SQL (any app with rank ≤ 200 at or before t0).
  const rows = db
    .prepare<{ app_id: string }, [string, number]>(
      `SELECT DISTINCT app_id FROM chart_snapshots
       WHERE market = ? AND captured_at <= ? AND rank <= 200
       ORDER BY app_id`,
    )
    .all(market, t0);
  return rows.map((r) => r.app_id);
}

export function runPathBBacktests(
  db: Database,
  opts: RunPathBBacktestsOptions = {},
): MultiCohortReport {
  const mode = opts.mode ?? "survival";
  const reports: BacktestReport[] = [];
  for (const c of PATHB_COHORTS) {
    const candidates = selectCandidates(db, c.market, c.t0, mode);
    if (candidates.length === 0) {
      reports.push({
        cohort_label: `pathb-${mode}-${c.tier}-${c.market}-${c.t0Iso}`,
        market: c.market,
        t0: c.t0,
        t_measure: T_MEASURE_MS,
        candidate_count: 0,
        eligible_count: 0,
        winner_count: 0,
        precision: DEFAULT_K_VALUES.map((k) => ({
          k,
          v1: 0,
          locGap_only: 0,
          velocity_only: 0,
          random_baseline: 0,
          lift_v1: 0,
        })),
        details: { top_k_v1: [] },
      });
      continue;
    }
    const r = runBacktest(db, {
      cohort_label: `pathb-${mode}-${c.tier}-${c.market}-${c.t0Iso}`,
      market: c.market,
      t0: c.t0,
      t_measure: T_MEASURE_MS,
      candidate_app_ids: candidates,
      // locGap is market-specific (one signal_snapshots row per (app, market, t0)
      // under prompt_version `v1.0.0-apptweak-{market}`). Without this filter
      // the harness would silently mix in another market's locGap when the same
      // app appears in multiple markets at the same t0 — Spotify in `id` would
      // see the English listing's locGap and rank as if there were no gap.
      signal_prompt_version_filter: { locGap: `v1.0.0-apptweak-${c.market}` },
      // signal_snapshots holds a precomputed grid for 70 (market, t0) cohorts —
      // an app frozen at an early t0 will have post-t0 rows belonging to LATER
      // cohorts. Those are not leakage; the SELECT cutoff (t<=t0) still applies.
      // See GetFrozenCohortFeaturesOptions.skip_leakage_check.
      skip_leakage_check: true,
    });
    reports.push(r);
  }
  return {
    generated_at: Date.now(),
    t_measure: T_MEASURE_MS,
    cohort_reports: reports,
    aggregate: aggregate(reports),
  };
}

function aggregate(reports: readonly BacktestReport[]): MultiCohortReport["aggregate"] {
  const seaReports = reports.filter((r) =>
    SEA_MARKETS.includes(r.market as (typeof SEA_MARKETS)[number]),
  );
  const t1Reports = reports.filter((r) =>
    TIER1_MARKETS.includes(r.market as (typeof TIER1_MARKETS)[number]),
  );
  const ks = DEFAULT_K_VALUES;
  const meanForK = (rs: readonly BacktestReport[]) =>
    ks.map((k) => {
      const rows = rs.flatMap((r) => r.precision.filter((p) => p.k === k));
      const mean = (sel: (p: (typeof rows)[number]) => number): number =>
        rows.length === 0 ? 0 : rows.reduce((s, p) => s + sel(p), 0) / rows.length;
      return {
        k,
        v1: mean((p) => p.v1),
        locGap_only: mean((p) => p.locGap_only),
        velocity_only: mean((p) => p.velocity_only),
        random: mean((p) => p.random_baseline),
      };
    });
  const t08 = isoToMs("2025-08-04");
  const t02 = isoToMs("2026-02-04");
  const pairedDelta = (t0: number) =>
    ks.map((k) => {
      const seaP = seaReports
        .filter((r) => r.t0 === t0)
        .flatMap((r) => r.precision.filter((p) => p.k === k));
      const t1P = t1Reports
        .filter((r) => r.t0 === t0)
        .flatMap((r) => r.precision.filter((p) => p.k === k));
      const sea_v1 = seaP.length === 0 ? 0 : seaP.reduce((s, p) => s + p.v1, 0) / seaP.length;
      const tier1_v1 = t1P.length === 0 ? 0 : t1P.reduce((s, p) => s + p.v1, 0) / t1P.length;
      return { k, sea_v1, tier1_v1, delta: sea_v1 - tier1_v1 };
    });
  return {
    sea_mean: meanForK(seaReports),
    tier1_mean: meanForK(t1Reports),
    paired_delta_2025_08: pairedDelta(t08),
    paired_delta_2026_02: pairedDelta(t02),
  };
}
