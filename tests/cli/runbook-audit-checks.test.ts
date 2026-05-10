/**
 * Runbook Discovery — Stage 1 pre-flight check unit tests.
 *
 * Each check is exercised against an in-memory SQLite fixture seeded with
 * just enough rows to exercise PASS / WARN / FAIL boundaries. Schema is the
 * production schema (via runMigrations) so column constraints match the live
 * DB.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  checkAppInvariantsCoverage,
  checkChartCoverage,
  checkMetadataPointInTime,
  checkRankDistribution,
  checkRecentDataWindow,
  checkSignalSnapshotsInventory,
  type MetadataSampleGroup,
} from "../../src/cli/runbook-audit-checks.ts";
import { runMigrations } from "../../src/storage/schema.ts";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-05-10T00:00:00Z");

function makeDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function insertChartRow(
  db: Database,
  market: string,
  store: "apple" | "googleplay",
  capturedAt: number,
  rank: number,
  appId: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO chart_snapshots
       (market, category, captured_at, rank, app_id, source, store)
     VALUES (?, 'top_grossing_overall', ?, ?, ?, 'test', ?)`,
  ).run(market, capturedAt, rank, appId, store);
}

describe("checkChartCoverage", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  test("FAIL when no rows for any of the markets", () => {
    const r = checkChartCoverage(db, ["id", "vn"]);
    expect(r.status).toBe("FAIL");
    expect(r.details).toContain("no chart_snapshots rows");
  });

  test("PASS when every market has ≥300 days of coverage", () => {
    // 350 days span for both markets
    for (let i = 0; i < 350; i++) {
      const t = NOW - i * DAY_MS;
      insertChartRow(db, "id", "apple", t, 1 + (i % 50), `app_id_${i}`);
      insertChartRow(db, "vn", "googleplay", t, 1 + (i % 50), `app_vn_${i}`);
    }
    const r = checkChartCoverage(db, ["id", "vn"]);
    expect(r.status).toBe("PASS");
    expect(r.details).toContain("id:");
    expect(r.details).toContain("vn:");
  });

  test("WARN when a market has 200-299 days", () => {
    for (let i = 0; i < 350; i++) {
      insertChartRow(db, "id", "apple", NOW - i * DAY_MS, 1, `app_id_${i}`);
    }
    for (let i = 0; i < 250; i++) {
      insertChartRow(db, "vn", "googleplay", NOW - i * DAY_MS, 1, `app_vn_${i}`);
    }
    const r = checkChartCoverage(db, ["id", "vn"]);
    expect(r.status).toBe("WARN");
  });

  test("FAIL when any market <200 days", () => {
    for (let i = 0; i < 350; i++) {
      insertChartRow(db, "id", "apple", NOW - i * DAY_MS, 1, `app_id_${i}`);
    }
    for (let i = 0; i < 100; i++) {
      insertChartRow(db, "vn", "googleplay", NOW - i * DAY_MS, 1, `app_vn_${i}`);
    }
    const r = checkChartCoverage(db, ["id", "vn"]);
    expect(r.status).toBe("FAIL");
  });

  test("FAIL when a target market is missing entirely", () => {
    for (let i = 0; i < 350; i++) {
      insertChartRow(db, "id", "apple", NOW - i * DAY_MS, 1, `app_id_${i}`);
    }
    const r = checkChartCoverage(db, ["id", "vn"]);
    expect(r.status).toBe("FAIL");
    expect(r.details).toContain("vn: MISSING");
  });

  // Boundary tests on distinct-day count. The check counts DISTINCT calendar
  // days, NOT wall-clock span between MIN/MAX. Intent: a dataset with rows at
  // only the endpoints should not pass the 300d threshold.
  test("PASS at exactly 300 distinct days (boundary)", () => {
    for (let i = 0; i < 300; i++) {
      insertChartRow(db, "id", "apple", NOW - i * DAY_MS, 1, `app_${i}`);
    }
    const r = checkChartCoverage(db, ["id"]);
    expect(r.status).toBe("PASS");
    expect(r.details).toContain("300d coverage (distinct days");
  });

  test("WARN at 299 distinct days (boundary)", () => {
    for (let i = 0; i < 299; i++) {
      insertChartRow(db, "id", "apple", NOW - i * DAY_MS, 1, `app_${i}`);
    }
    const r = checkChartCoverage(db, ["id"]);
    expect(r.status).toBe("WARN");
  });

  test("WARN at exactly 200 distinct days (boundary)", () => {
    for (let i = 0; i < 200; i++) {
      insertChartRow(db, "id", "apple", NOW - i * DAY_MS, 1, `app_${i}`);
    }
    const r = checkChartCoverage(db, ["id"]);
    expect(r.status).toBe("WARN");
  });

  test("FAIL at 199 distinct days (boundary)", () => {
    for (let i = 0; i < 199; i++) {
      insertChartRow(db, "id", "apple", NOW - i * DAY_MS, 1, `app_${i}`);
    }
    const r = checkChartCoverage(db, ["id"]);
    expect(r.status).toBe("FAIL");
  });

  test("FAIL when only endpoint days exist (span-of-extremes is large but distinct days is small)", () => {
    // 2 rows: one at NOW, one at NOW - 350d. Span-of-extremes math would say
    // 350d coverage, but distinct-day count is 2 → FAIL.
    insertChartRow(db, "id", "apple", NOW, 1, "app_a");
    insertChartRow(db, "id", "apple", NOW - 350 * DAY_MS, 1, "app_b");
    const r = checkChartCoverage(db, ["id"]);
    expect(r.status).toBe("FAIL");
    expect(r.details).toContain("2d coverage (distinct days");
  });
});

describe("checkRankDistribution", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  test("PASS when ranks are within 1..100", () => {
    insertChartRow(db, "id", "apple", NOW, 1, "app1");
    insertChartRow(db, "id", "apple", NOW - DAY_MS, 100, "app2");
    const r = checkRankDistribution(db);
    expect(r.status).toBe("PASS");
    expect(r.details).toContain("MIN(rank)=1");
    expect(r.details).toContain("MAX(rank)=100");
  });

  test("WARN when max rank exceeds 100", () => {
    insertChartRow(db, "id", "apple", NOW, 1, "app1");
    insertChartRow(db, "id", "apple", NOW - DAY_MS, 250, "app2");
    const r = checkRankDistribution(db);
    expect(r.status).toBe("WARN");
    expect(r.details).toContain("250");
  });

  test("WARN when no rows at all (cannot infer)", () => {
    const r = checkRankDistribution(db);
    expect(r.status).toBe("WARN");
  });
});

describe("checkRecentDataWindow", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  test("FAIL when no rows present", () => {
    const r = checkRecentDataWindow(db, NOW);
    expect(r.status).toBe("FAIL");
  });

  test("PASS when MAX(captured_at) within 30 days", () => {
    insertChartRow(db, "id", "apple", NOW - 5 * DAY_MS, 1, "app1");
    const r = checkRecentDataWindow(db, NOW);
    expect(r.status).toBe("PASS");
    expect(r.details).toContain("5d stale");
  });

  test("WARN when 30-90 days stale", () => {
    insertChartRow(db, "id", "apple", NOW - 60 * DAY_MS, 1, "app1");
    const r = checkRecentDataWindow(db, NOW);
    expect(r.status).toBe("WARN");
  });

  test("FAIL when >90 days stale", () => {
    insertChartRow(db, "id", "apple", NOW - 120 * DAY_MS, 1, "app1");
    const r = checkRecentDataWindow(db, NOW);
    expect(r.status).toBe("FAIL");
  });
});

describe("checkMetadataPointInTime", () => {
  test("WARN when reader returns no groups", () => {
    const r = checkMetadataPointInTime(() => []);
    expect(r.status).toBe("WARN");
  });

  test("WARN when every triple has identical max release_date across t0s", () => {
    const groups: MetadataSampleGroup[] = [
      {
        key: "(app1, id, apple)",
        records: [
          { t0: "2025-05-04", maxReleaseDate: "2024-12-01" },
          { t0: "2025-06-04", maxReleaseDate: "2024-12-01" },
          { t0: "2025-07-04", maxReleaseDate: "2024-12-01" },
        ],
      },
      {
        key: "(app2, vn, googleplay)",
        records: [
          { t0: "2025-05-04", maxReleaseDate: "2025-01-15" },
          { t0: "2025-06-04", maxReleaseDate: "2025-01-15" },
        ],
      },
    ];
    const r = checkMetadataPointInTime(() => groups);
    expect(r.status).toBe("WARN");
    expect(r.details).toContain("DUPLICATED");
  });

  test("PASS when at least one triple has varying max release_date", () => {
    const groups: MetadataSampleGroup[] = [
      {
        key: "(app1, id, apple)",
        records: [
          { t0: "2025-05-04", maxReleaseDate: "2024-12-01" },
          { t0: "2025-06-04", maxReleaseDate: "2025-01-15" },
        ],
      },
    ];
    const r = checkMetadataPointInTime(() => groups);
    expect(r.status).toBe("PASS");
    expect(r.details).toContain("varying");
  });
});

describe("checkSignalSnapshotsInventory", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  test("PASS with 'nothing precomputed' note when empty", () => {
    const r = checkSignalSnapshotsInventory(db);
    expect(r.status).toBe("PASS");
    expect(r.details).toContain("nothing precomputed");
  });

  test("PASS with inventory listing when rows exist", () => {
    db.prepare(
      `INSERT INTO signal_snapshots (app_id, signal_name, t, value, llm_prompt_version, computed_at)
       VALUES ('a', 'pathc.f0', 1, 0.5, 'v1', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO signal_snapshots (app_id, signal_name, t, value, llm_prompt_version, computed_at)
       VALUES ('a', 'pathc.f1', 1, 0.5, 'v1', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO signal_snapshots (app_id, signal_name, t, value, llm_prompt_version, computed_at)
       VALUES ('b', 'pathc.f1', 1, 0.5, 'v1', 1)`,
    ).run();
    const r = checkSignalSnapshotsInventory(db);
    expect(r.status).toBe("PASS");
    expect(r.details).toContain("pathc.f0: 1 rows");
    expect(r.details).toContain("pathc.f1: 2 rows");
  });
});

describe("checkAppInvariantsCoverage", () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  function insertInvariant(
    appId: string,
    store: "apple" | "googleplay",
    publisherId: string | null,
    releaseDate: number | null,
  ): void {
    db.prepare(
      `INSERT INTO app_invariants
         (app_id, store, publisher_id, publisher_name, release_date, source, ingested_at)
       VALUES (?, ?, ?, NULL, ?, 'test', ?)`,
    ).run(appId, store, publisherId, releaseDate, NOW);
  }

  test("FAIL when fewer than 500 rows", () => {
    for (let i = 0; i < 100; i++) {
      insertInvariant(`app_${i}`, "apple", `pub_${i}`, NOW);
    }
    const r = checkAppInvariantsCoverage(db);
    expect(r.status).toBe("FAIL");
  });

  test("WARN when 500-999 rows even with full coverage", () => {
    for (let i = 0; i < 600; i++) {
      insertInvariant(`app_${i}`, "apple", `pub_${i}`, NOW);
    }
    const r = checkAppInvariantsCoverage(db);
    expect(r.status).toBe("WARN");
  });

  test("WARN when ≥1000 rows but publisher_id <70%", () => {
    for (let i = 0; i < 1000; i++) {
      // 50% publisher
      insertInvariant(`app_${i}`, "apple", i % 2 === 0 ? `pub_${i}` : null, NOW);
    }
    const r = checkAppInvariantsCoverage(db);
    expect(r.status).toBe("WARN");
  });

  test("PASS when ≥1000 rows AND ≥70% publisher_id AND ≥70% release_date", () => {
    for (let i = 0; i < 1500; i++) {
      const hasPub = i % 10 < 9; // 90%
      const hasRel = i % 10 < 8; // 80%
      insertInvariant(`app_${i}`, "apple", hasPub ? `pub_${i}` : null, hasRel ? NOW : null);
    }
    const r = checkAppInvariantsCoverage(db);
    expect(r.status).toBe("PASS");
  });
});
