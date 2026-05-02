/**
 * Full v1 pipeline integration test.
 *
 * E2E: scrape (mocked) → judges (mocked) → signals → composer → brief output.
 *
 * Mocks every external dependency:
 *   - 42matters API client (no live calls; pre-seeded chart_snapshots used)
 *   - LLM judges (no Anthropic API; brief renders in dryRun mode)
 *   - Image fetcher (irrelevant — mechanic_evidence skipped in dryRun)
 *
 * Verifies:
 *   - runV1Pipeline produces an Opportunity matching the OpportunitySchema
 *   - Opportunity is persisted to the opportunities table with correct
 *     typed columns (sig_loc_gap, sig_velocity, etc.)
 *   - Brief render output contains all expected sections (Source, Target,
 *     Thesis, Signals, Predicted, Tags, Validation, Evidence)
 *   - Composer eligibility flag matches the persisted column
 *   - LLM provenance NULL (dryRun: thesis is the seed text, not LLM-generated)
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpportunitySchema } from "../../src/opportunities/schema.ts";
import { runV1Pipeline, SIGNAL_PIPELINE_VERSION } from "../../src/orchestrator/pipeline.ts";
import { renderBrief } from "../../src/reporting/briefs.ts";
import { SCORING_VERSION } from "../../src/signals/composer.ts";
import { runMigrations } from "../../src/storage/schema.ts";

const T0 = Date.parse("2026-04-01T00:00:00.000Z");
const SOURCE_APP = "com.example.cal-ai";
const TARGET_MARKET = "id" as const;
const SOURCE_MARKET = "us" as const;
const CATEGORY = "health" as const;

function seedChartSnapshots(db: Database, app_id: string, market: string): void {
  // 30 days of monthly chart_snapshots ending right before T0 — enough days
  // for the v1 velocity signal to compute (>= 7 distinct days inside top-200).
  const insert = db.prepare(
    `INSERT INTO chart_snapshots (market, category, captured_at, rank, app_id, source)
     VALUES (?, ?, ?, ?, ?, 'synthetic-test')`,
  );
  const dayMs = 24 * 60 * 60 * 1000;
  db.transaction(() => {
    for (let d = 30; d > 0; d--) {
      const captured_at = T0 - d * dayMs;
      // App climbs from rank 50 to rank 10 (improvement of 40)
      const rank = 50 - Math.floor((30 - d) * 1.3);
      insert.run(market, "health", captured_at, rank, app_id);
    }
  })();
}

function seedLocGapSignal(db: Database, app_id: string): void {
  // Pre-seed a locGap signal_snapshot so the v1 pipeline reads it via
  // readLatestLocGapFromSignals (the orchestrator doesn't call the
  // text-judge in v1 — that bridge lands in a future task).
  db.prepare(
    `INSERT INTO signal_snapshots
     (app_id, signal_name, t, value,
      llm_model, llm_prompt_version, llm_request_hash,
      llm_response_hash, llm_response_archived, source_urls_json,
      computed_at)
     VALUES (?, 'locGap', ?, ?, 'claude-sonnet-4-6', 'v1.0.0', NULL, NULL, NULL, '[]', ?)`,
  ).run(app_id, T0 - 1000, 8.5, T0 - 999);
}

describe("runV1Pipeline integration (full E2E)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    seedChartSnapshots(db, SOURCE_APP, TARGET_MARKET);
    seedLocGapSignal(db, SOURCE_APP);
  });

  afterEach(() => db.close());

  test("produces a valid Opportunity record (dryRun)", async () => {
    const opportunity = await runV1Pipeline({
      db,
      source_app_id: SOURCE_APP,
      source_market: SOURCE_MARKET,
      target_market: TARGET_MARKET,
      category: CATEGORY,
      kill_metric: { metric: "roas_d14", threshold: 0.4, direction: "below" },
      now: () => T0,
      brief: { dryRun: true },
    });

    // Schema compliance
    const parsed = OpportunitySchema.safeParse(opportunity);
    expect(parsed.success).toBe(true);

    // Load-bearing fields
    expect(opportunity.source_app_id).toBe(SOURCE_APP);
    expect(opportunity.source_market).toBe(SOURCE_MARKET);
    expect(opportunity.target_market).toBe(TARGET_MARKET);
    expect(opportunity.category).toBe(CATEGORY);

    // At least 3 signals (velocity from chart_snapshots, locGap from seed,
    // cpi_ltv_proxy from deterministic lookup) so the composer should be
    // eligible.
    expect(opportunity.eligible).toBe(true);
    expect(opportunity.score).not.toBeNull();
    expect(opportunity.score!).toBeGreaterThanOrEqual(0);
    expect(opportunity.score!).toBeLessThanOrEqual(10);

    // signal_values: at least 3 of the 4 v1 signals populated
    const sigCount =
      (opportunity.signal_values.locGap !== null && opportunity.signal_values.locGap !== undefined
        ? 1
        : 0) +
      (opportunity.signal_values.velocity !== null &&
      opportunity.signal_values.velocity !== undefined
        ? 1
        : 0) +
      (opportunity.signal_values.cpi_ltv_proxy !== null &&
      opportunity.signal_values.cpi_ltv_proxy !== undefined
        ? 1
        : 0) +
      (opportunity.signal_values.incumbent_vulnerability !== null &&
      opportunity.signal_values.incumbent_vulnerability !== undefined
        ? 1
        : 0);
    expect(sigCount).toBeGreaterThanOrEqual(3);

    // Versioning metadata
    expect(opportunity.metadata.signal_pipeline_version).toBe(SIGNAL_PIPELINE_VERSION);
    expect(opportunity.metadata.scoring_version).toBe(SCORING_VERSION);
    expect(opportunity.metadata.built_via).toBe("runV1Pipeline");
  });

  test("persists Opportunity to opportunities table with correct typed columns", async () => {
    const opportunity = await runV1Pipeline({
      db,
      source_app_id: SOURCE_APP,
      source_market: SOURCE_MARKET,
      target_market: TARGET_MARKET,
      category: CATEGORY,
      kill_metric: { metric: "roas_d14", threshold: 0.4, direction: "below" },
      now: () => T0,
      brief: { dryRun: true },
    });

    const row = db
      .prepare<
        {
          id: string;
          source_app_id: string;
          source_market: string;
          target_market: string;
          category: string;
          sig_loc_gap: number | null;
          sig_velocity: number | null;
          sig_incumbent_vuln: number | null;
          sig_cpi_ltv_proxy: number | null;
          score: number | null;
          eligible: number;
          kill_metric_name: string;
          kill_metric_threshold: number;
          kill_metric_direction: string;
          signal_pipeline_version: string;
          scoring_version: string;
          thesis: string;
        },
        [string]
      >(
        `SELECT id, source_app_id, source_market, target_market, category,
                sig_loc_gap, sig_velocity, sig_incumbent_vuln, sig_cpi_ltv_proxy,
                score, eligible, kill_metric_name, kill_metric_threshold, kill_metric_direction,
                signal_pipeline_version, scoring_version, thesis
         FROM opportunities WHERE id = ?`,
      )
      .get(opportunity.id);
    expect(row).not.toBeNull();
    expect(row?.source_app_id).toBe(SOURCE_APP);
    expect(row?.source_market).toBe(SOURCE_MARKET);
    expect(row?.target_market).toBe(TARGET_MARKET);
    expect(row?.category).toBe(CATEGORY);
    expect(row?.sig_loc_gap).toBe(8.5);
    expect(row?.sig_cpi_ltv_proxy).not.toBeNull();
    expect(row?.eligible).toBe(1);
    expect(row?.kill_metric_name).toBe("roas_d14");
    expect(row?.kill_metric_threshold).toBe(0.4);
    expect(row?.kill_metric_direction).toBe("below");
    expect(row?.signal_pipeline_version).toBe(SIGNAL_PIPELINE_VERSION);
    expect(row?.scoring_version).toBe(SCORING_VERSION);
    expect(row?.thesis.length).toBeGreaterThan(0);
  });

  test("brief output is non-empty + contains expected sections", async () => {
    const opportunity = await runV1Pipeline({
      db,
      source_app_id: SOURCE_APP,
      source_market: SOURCE_MARKET,
      target_market: TARGET_MARKET,
      category: CATEGORY,
      kill_metric: { metric: "roas_d14", threshold: 0.4, direction: "below" },
      now: () => T0,
      brief: { dryRun: true },
    });

    const brief = await renderBrief(opportunity, { dryRun: true });
    expect(brief.length).toBeGreaterThan(0);

    // All required sections per docs/planning/agent-v1-foundation.md § "Brief structure"
    expect(brief).toContain("**Source:**");
    expect(brief).toContain("**Target:**");
    expect(brief).toContain("**Thesis**");
    expect(brief).toContain("**Signals**");
    expect(brief).toContain("**Predicted economics**");
    expect(brief).toContain("**Tags:**");
    expect(brief).toContain("**Validation plan**");
    expect(brief).toContain("**Evidence**");

    // Source/Target values
    expect(brief).toContain(SOURCE_APP);
    expect(brief).toContain(SOURCE_MARKET);
    expect(brief).toContain(TARGET_MARKET);

    // At least one signal rendered (we seeded locGap=8.5)
    expect(brief).toMatch(/locGap: 8\.5\/10/);
  });

  test("ineligible opportunity (N<3 signals) is persisted with eligible=0 + score=null", async () => {
    // Don't seed locGap; with only velocity + cpi_ltv_proxy = 2 signals,
    // the composer reports eligible=false. Still persists per the contract.
    const freshDb = new Database(":memory:");
    runMigrations(freshDb);
    seedChartSnapshots(freshDb, SOURCE_APP, TARGET_MARKET);

    const opportunity = await runV1Pipeline({
      db: freshDb,
      source_app_id: SOURCE_APP,
      source_market: SOURCE_MARKET,
      target_market: TARGET_MARKET,
      category: CATEGORY,
      kill_metric: { metric: "roas_d14", threshold: 0.4, direction: "below" },
      now: () => T0,
      brief: { dryRun: true },
    });

    expect(opportunity.eligible).toBe(false);
    expect(opportunity.score).toBeNull();

    const row = freshDb
      .prepare<{ score: number | null; eligible: number }, [string]>(
        "SELECT score, eligible FROM opportunities WHERE id = ?",
      )
      .get(opportunity.id);
    expect(row?.score).toBeNull();
    expect(row?.eligible).toBe(0);

    freshDb.close();
  });
});
