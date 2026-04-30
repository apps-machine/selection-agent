import type { JudgeResult, TextJudgeResult, VisionJudgeResult } from "../judges/schemas.ts";
import type { CompositeOutput } from "../scoring/composite.ts";
import type { RawAppData, Store } from "../types/raw-app-data.ts";
import type { WriteSnapshotResult } from "../velocity/snapshot.ts";

/**
 * Per-app result the ranker consumes. Built by the pipeline.
 *
 * `enrichmentSource` records how the app's RawAppData was produced:
 *  - `"enriched"`  scrapeApps returned a per-app detail record (rich
 *                  description + ratings); composite is computed on real data.
 *  - `"chart-only"` scrapeApps failed for this slot — the chart entry
 *                  was used as fallback. Composite is on thin data.
 *  - `"skipped"`   scan ran with `--no-enrich`; no enrichment attempted.
 *
 * The brief renders a per-app `(chart-only)` tag whenever the source is
 * `"chart-only"` so the founder knows which scores to distrust.
 */
export interface ScoredCandidate {
  app: RawAppData;
  composite: CompositeOutput;
  /** null when scan ran with --no-llm, or when the text judge errored. */
  textJudge: TextJudgeResult | null;
  /** null when --no-llm, when no screenshots, or when vision-judge errored. */
  visionJudge: VisionJudgeResult | null;
  enrichmentSource: "enriched" | "chart-only" | "skipped";
}

/** Adds the final 1-based rank assigned by `rank()`. */
export interface RankedCandidate extends ScoredCandidate {
  rank: number;
}

/** A market+store slice that produced zero candidates because the scrape failed. */
export interface FailedSlice {
  store: Store;
  market: string;
  reason: string;
}

export interface ScanResult {
  /** Stable id for this scan run, used as `judge_result.run_id`. */
  runId: string;
  /** ISO timestamp when the scan started. */
  generatedAt: string;
  markets: string[];
  /** Total apps surveyed across all surviving slices (pre-rank). */
  appsScanned: number;
  /** USD spent across both judges. 0 when --no-llm. */
  costUsd: number;
  candidates: RankedCandidate[];
  /** All judge calls that produced a result this run. Used by compareJudges. */
  judgeResults: JudgeResult[];
  /** Outcome of the M5 writeSnapshot call. Always present (snapshot runs even when judges error). */
  snapshotResult: WriteSnapshotResult;
  /** Slices (store × market) whose scrape failed; reported in the brief footer. */
  failedSlices: FailedSlice[];
  /**
   * Number of chart entries whose enrichment scrape failed. The pipeline falls
   * back to the chart entry for those apps; the brief surfaces this number in
   * the header and tags each fallback candidate `(chart-only)`. Zero when
   * enrichment was skipped.
   */
  enrichmentFailedCount: number;
  /** True when scan ran with `--no-enrich`; scrapeApps was not called. */
  enrichmentSkipped: boolean;
}
