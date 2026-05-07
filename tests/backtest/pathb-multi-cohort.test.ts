import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { PATHB_COHORTS, runPathBBacktests } from "../../src/backtest/pathb-multi-cohort.ts";
import { runMigrations } from "../../src/storage/schema.ts";

function openTestDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

describe("runPathBBacktests", () => {
  test("PATHB_COHORTS contains 70 measurement points (5 SEA × 12 + 5 tier1 × 2)", () => {
    expect(PATHB_COHORTS.length).toBe(70);
    const sea = PATHB_COHORTS.filter((c) => c.tier === "sea").length;
    const t1 = PATHB_COHORTS.filter((c) => c.tier === "tier1").length;
    expect(sea).toBe(60);
    expect(t1).toBe(10);
  });

  test("returns empty per-cohort report when DB has no chart_snapshots", () => {
    const db = openTestDb();
    const out = runPathBBacktests(db);
    expect(out.cohort_reports.length).toBe(70);
    for (const r of out.cohort_reports) {
      expect(r.candidate_count).toBe(0);
      expect(r.cohort_label).toContain("pathb-survival-");
    }
    db.close();
  });

  test("returns 70 cohort reports in entrants mode (no DB rows = empty)", () => {
    const db = openTestDb();
    const out = runPathBBacktests(db, { mode: "entrants" });
    expect(out.cohort_reports.length).toBe(70);
    for (const r of out.cohort_reports) {
      expect(r.candidate_count).toBe(0);
      expect(r.cohort_label).toContain("pathb-entrants-");
    }
    db.close();
  });
});
