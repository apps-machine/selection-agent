import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../../src/storage/cache.ts";
import { runMigrations, V1_MIGRATIONS } from "../../src/storage/schema.ts";

interface TableInfoRow {
  name: string;
}

interface IndexInfoRow {
  name: string;
}

interface MigrationRow {
  version: string;
  applied_at: number;
  checksum: string;
}

function listTables(db: Database): string[] {
  return db
    .prepare<TableInfoRow, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
}

function listIndexes(db: Database, table: string): string[] {
  return db
    .prepare<IndexInfoRow, [string]>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name",
    )
    .all(table)
    .map((r) => r.name);
}

describe("runMigrations — fresh in-memory db", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("creates schema_migrations table", () => {
    expect(listTables(db)).toContain("schema_migrations");
  });

  test("creates opportunities table", () => {
    expect(listTables(db)).toContain("opportunities");
  });

  test("creates winner_scores table", () => {
    expect(listTables(db)).toContain("winner_scores");
  });

  test("creates signal_snapshots table", () => {
    expect(listTables(db)).toContain("signal_snapshots");
  });

  test("creates chart_snapshots table", () => {
    expect(listTables(db)).toContain("chart_snapshots");
  });

  test("creates app_metadata_snapshots table", () => {
    expect(listTables(db)).toContain("app_metadata_snapshots");
  });

  test("creates cohort_freezes table", () => {
    expect(listTables(db)).toContain("cohort_freezes");
  });

  test("opportunities indexes exist (target_market, category, score-partial)", () => {
    const idx = listIndexes(db, "opportunities");
    expect(idx).toContain("idx_opportunities_target_market");
    expect(idx).toContain("idx_opportunities_category");
    expect(idx).toContain("idx_opportunities_score");
  });

  test("winner_scores idx_winner_scores_tier exists", () => {
    expect(listIndexes(db, "winner_scores")).toContain("idx_winner_scores_tier");
  });

  test("signal_snapshots idx_signal_snapshots_signal exists", () => {
    expect(listIndexes(db, "signal_snapshots")).toContain("idx_signal_snapshots_signal");
  });

  test("chart_snapshots idx_chart_snapshots_app exists", () => {
    expect(listIndexes(db, "chart_snapshots")).toContain("idx_chart_snapshots_app");
  });

  test("schema_migrations seeded with every v1 migration version", () => {
    const rows = db
      .prepare<MigrationRow, []>(
        "SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version",
      )
      .all();
    const versions = new Set(rows.map((r) => r.version));
    for (const m of V1_MIGRATIONS) {
      expect(versions.has(m.version)).toBe(true);
    }
    // Each migration row carries a 64-hex sha256 checksum.
    for (const r of rows) {
      expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(r.applied_at).toBeGreaterThan(0);
    }
  });
});

describe("runMigrations — idempotency", () => {
  test("running twice on same db is a no-op (no throw, no duplicate rows)", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const firstCount = db
      .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations")
      .get();
    expect(firstCount?.count).toBe(V1_MIGRATIONS.length);

    expect(() => runMigrations(db)).not.toThrow();

    const secondCount = db
      .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations")
      .get();
    expect(secondCount?.count).toBe(V1_MIGRATIONS.length);
    db.close();
  });
});

describe("runMigrations — DDL constraints work", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("opportunities rejects bad kill_metric_direction", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO opportunities (
            id, generated_at, source_app_id, source_market, target_market, category,
            kill_metric_name, kill_metric_threshold, kill_metric_direction,
            eligible, thesis, evidence_json, signal_pipeline_version, scoring_version
          ) VALUES (?, 1, 'a', 'us', 'id', 'productivity',
            'roas_d14', 0.5, 'sideways',
            0, 't', '[]', 'v1', 'v1')`,
        )
        .run("00000000-0000-0000-0000-000000000001"),
    ).toThrow();
  });

  test("opportunities accepts well-formed insert (and partial-index path)", () => {
    db.prepare(
      `INSERT INTO opportunities (
        id, generated_at, source_app_id, source_market, target_market, category,
        sig_loc_gap, sig_velocity,
        kill_metric_name, kill_metric_threshold, kill_metric_direction,
        score, eligible, thesis, evidence_json, signal_pipeline_version, scoring_version
      ) VALUES (?, 1700000000000, 'com.foo', 'us', 'id', 'productivity',
        7.5, 6.0,
        'roas_d14', 0.5, 'below',
        7.2, 1, 't', '[{}]', 'v1', 'v1')`,
    ).run("00000000-0000-0000-0000-000000000002");

    const row = db
      .prepare<{ score: number; eligible: number }, []>(
        "SELECT score, eligible FROM opportunities LIMIT 1",
      )
      .get();
    expect(row?.score).toBe(7.2);
    expect(row?.eligible).toBe(1);
  });

  test("winner_scores enforces tier check + composite PK (app_id, t0)", () => {
    db.prepare(
      `INSERT INTO winner_scores (app_id, t0, measured_at, score, tier, formula_version, computed_at)
       VALUES ('a', 100, 200, 7.5, 'winner', 'v1', 1700000000000)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO winner_scores (app_id, t0, measured_at, score, tier, formula_version, computed_at)
           VALUES ('a', 100, 300, 8.5, 'winner', 'v1', 1700000000000)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO winner_scores (app_id, t0, measured_at, score, tier, formula_version, computed_at)
           VALUES ('b', 100, 200, 5.0, 'champion', 'v1', 1700000000000)`,
        )
        .run(),
    ).toThrow();
  });

  test("signal_snapshots PK includes llm_prompt_version (different prompts coexist)", () => {
    db.prepare(
      `INSERT INTO signal_snapshots (app_id, signal_name, t, llm_prompt_version, computed_at)
       VALUES ('a', 'locGap', 100, 'v1.0.0', 1700000000000)`,
    ).run();
    db.prepare(
      `INSERT INTO signal_snapshots (app_id, signal_name, t, llm_prompt_version, computed_at)
       VALUES ('a', 'locGap', 100, 'v1.1.0', 1700000000000)`,
    ).run();
    const count = db
      .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM signal_snapshots")
      .get();
    expect(count?.count).toBe(2);
  });

  test("app_metadata_snapshots source check enforced", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO app_metadata_snapshots (app_id, market, captured_at, source, parsed_json)
           VALUES ('a', 'id', 100, 'unknown_source', '{}')`,
        )
        .run(),
    ).toThrow();
    db.prepare(
      `INSERT INTO app_metadata_snapshots (app_id, market, captured_at, source, parsed_json)
       VALUES ('a', 'id', 100, '42matters', '{}')`,
    ).run();
  });
});

describe("runMigrations — integrates with Cache.open", () => {
  test("Cache.open(:memory:) creates v1 tables alongside legacy ones", () => {
    const cache = Cache.open(":memory:");
    const db = cache.rawDb();
    const tables = listTables(db);
    expect(tables).toContain("scrape_cache");
    expect(tables).toContain("app_snapshot");
    expect(tables).toContain("judge_result");
    expect(tables).toContain("opportunities");
    expect(tables).toContain("winner_scores");
    expect(tables).toContain("signal_snapshots");
    expect(tables).toContain("chart_snapshots");
    expect(tables).toContain("app_metadata_snapshots");
    expect(tables).toContain("cohort_freezes");
    expect(tables).toContain("schema_migrations");
    cache.close();
  });
});
