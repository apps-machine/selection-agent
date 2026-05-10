/**
 * Integration tests for `runAudit()` — composes the 6 checks, formats the
 * markdown report, and computes the exit code.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultMetadataReader, resolveMetadataPath, runAudit } from "../../src/cli/audit.ts";
import { runMigrations } from "../../src/storage/schema.ts";

const CLI_PATH = resolve(join(import.meta.dir, "..", "..", "src", "cli", "index.ts"));

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-05-10T00:00:00Z");

let workDir: string;
let dbPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "audit-test-"));
  dbPath = join(workDir, "selection-agent.sqlite");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function seed(): Database {
  const db = new Database(dbPath);
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

function insertInvariant(
  db: Database,
  appId: string,
  store: "apple" | "googleplay",
  publisherId: string | null,
  releaseDate: number | null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO app_invariants
       (app_id, store, publisher_id, publisher_name, release_date, source, ingested_at)
     VALUES (?, ?, ?, NULL, ?, 'test', ?)`,
  ).run(appId, store, publisherId, releaseDate, NOW);
}

describe("runAudit", () => {
  test("FAIL exit code when DB is missing", async () => {
    const result = await runAudit({
      dbPath: "/nonexistent/path/that/does/not/exist.sqlite",
      now: NOW,
      silent: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.report).toContain("database not found");
  });

  test("PASS when all checks pass on a healthy DB", async () => {
    const db = seed();
    try {
      const markets = ["id", "vn"];
      // 350 days of fresh data per market
      for (let i = 0; i < 350; i++) {
        const t = NOW - i * DAY_MS;
        for (const m of markets) {
          insertChartRow(db, m, "apple", t, 1 + (i % 50), `${m}_app_${i}`);
        }
      }
      // ≥1000 invariants with full publisher/release coverage
      for (let i = 0; i < 1500; i++) {
        insertInvariant(db, `app_${i}`, "apple", `pub_${i}`, NOW);
      }
    } finally {
      db.close();
    }

    const result = await runAudit({
      dbPath,
      markets: ["id", "vn"],
      now: NOW,
      metadataReader: () => [
        {
          key: "(app1, id, apple)",
          records: [
            { t0: "2025-05-04", maxReleaseDate: "2024-12-01" },
            { t0: "2025-06-04", maxReleaseDate: "2025-01-15" },
          ],
        },
      ],
      silent: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("Overall: PASS");
    expect(result.report).toContain("# Runbook Discovery — Stage 1 pre-flight audit");
  });

  test("WARN-only run still exits 0", async () => {
    const db = seed();
    try {
      // 350 days for id (PASS), 250 days for vn (WARN)
      for (let i = 0; i < 350; i++) {
        insertChartRow(db, "id", "apple", NOW - i * DAY_MS, 1, `id_app_${i}`);
      }
      for (let i = 0; i < 250; i++) {
        insertChartRow(db, "vn", "apple", NOW - i * DAY_MS, 1, `vn_app_${i}`);
      }
      for (let i = 0; i < 1500; i++) {
        insertInvariant(db, `app_${i}`, "apple", `pub_${i}`, NOW);
      }
    } finally {
      db.close();
    }

    const result = await runAudit({
      dbPath,
      markets: ["id", "vn"],
      now: NOW,
      // Duplicated metadata → WARN per anti-pattern A2
      metadataReader: () => [
        {
          key: "(app1, id, apple)",
          records: [
            { t0: "2025-05-04", maxReleaseDate: "2024-12-01" },
            { t0: "2025-06-04", maxReleaseDate: "2024-12-01" },
          ],
        },
      ],
      silent: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.report).toContain("Overall: WARN");
  });

  test("FAIL exit code when any check FAILs", async () => {
    const db = seed();
    try {
      // Missing market vn entirely → coverage FAIL
      for (let i = 0; i < 350; i++) {
        insertChartRow(db, "id", "apple", NOW - i * DAY_MS, 1, `id_app_${i}`);
      }
      for (let i = 0; i < 1500; i++) {
        insertInvariant(db, `app_${i}`, "apple", `pub_${i}`, NOW);
      }
    } finally {
      db.close();
    }

    const result = await runAudit({
      dbPath,
      markets: ["id", "vn"],
      now: NOW,
      metadataReader: () => [],
      silent: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.report).toContain("Overall: FAIL");
    expect(result.report).toContain("Next steps");
  });

  test("--output writes the report to a file and returns the same content", async () => {
    const db = seed();
    try {
      for (let i = 0; i < 350; i++) {
        insertChartRow(db, "id", "apple", NOW - i * DAY_MS, 1, `id_app_${i}`);
      }
      for (let i = 0; i < 1500; i++) {
        insertInvariant(db, `app_${i}`, "apple", `pub_${i}`, NOW);
      }
    } finally {
      db.close();
    }

    const outPath = join(workDir, "report.md");
    const result = await runAudit({
      dbPath,
      markets: ["id"],
      now: NOW,
      output: outPath,
      metadataReader: () => [],
      silent: true,
    });
    const onDisk = readFileSync(outPath, "utf8");
    expect(onDisk).toBe(result.report);
  });

  test("metadataPath option threads through to the default reader", async () => {
    const db = seed();
    db.close();
    // Write a single-line metadata.jsonl with two t0 records sharing the same
    // (app_id, market, store) so the reader returns one group.
    const metaPath = join(workDir, "custom-metadata.jsonl");
    const lines = [
      JSON.stringify({
        app_id: "app1",
        market: "id",
        store: "apple",
        t0: "2025-05-04",
        raw: { metadata: { versions: [{ release_date: "2024-12-01" }] } },
      }),
      JSON.stringify({
        app_id: "app1",
        market: "id",
        store: "apple",
        t0: "2025-06-04",
        raw: { metadata: { versions: [{ release_date: "2025-01-15" }] } },
      }),
    ];
    writeFileSync(metaPath, `${lines.join("\n")}\n`, "utf8");

    const result = await runAudit({
      dbPath,
      markets: ["id"],
      now: NOW,
      metadataPath: metaPath,
      silent: true,
    });
    // Two distinct release_dates → varying (PASS) for that check
    expect(result.report).toContain("metadata point-in-time validity — PASS");
  });

  test("composes all 6 checks in fixed order", async () => {
    const db = seed();
    db.close();
    const result = await runAudit({
      dbPath,
      markets: ["id"],
      now: NOW,
      metadataReader: () => [],
      silent: true,
    });
    // Each check appears as a "### N. <name>" header in fixed numerical order
    const expected = [
      "1. chart_snapshots coverage",
      "2. rank distribution",
      "3. recent-data window",
      "4. metadata point-in-time validity",
      "5. existing precomputes inventory",
      "6. app_invariants coverage",
    ];
    let lastIdx = -1;
    for (const e of expected) {
      const idx = result.report.indexOf(`### ${e}`);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});

describe("resolveMetadataPath", () => {
  test("returns null when no data dir exists", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-glob-"));
    try {
      expect(resolveMetadataPath({ dataRoot: root })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit metadataPath is returned verbatim when it exists", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-glob-"));
    try {
      const p = join(root, "custom.jsonl");
      writeFileSync(p, "{}\n", "utf8");
      expect(resolveMetadataPath({ metadataPath: p })).toBe(p);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit metadataPath returns null when missing", () => {
    expect(resolveMetadataPath({ metadataPath: "/nope/does/not/exist.jsonl" })).toBeNull();
  });

  test("globs apptweak-* dirs and picks the latest by name (lex desc)", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-glob-"));
    try {
      // Two dated dirs; we expect the later one to win.
      mkdirSync(join(root, "data", "apptweak-2025-01-01"), { recursive: true });
      mkdirSync(join(root, "data", "apptweak-2026-05-04"), { recursive: true });
      writeFileSync(join(root, "data", "apptweak-2025-01-01", "metadata.jsonl"), "{}\n");
      writeFileSync(join(root, "data", "apptweak-2026-05-04", "metadata.jsonl"), "{}\n");

      const resolved = resolveMetadataPath({ dataRoot: root });
      expect(resolved).toBe(join(root, "data", "apptweak-2026-05-04", "metadata.jsonl"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to .jsonl.gz if .jsonl is missing in the latest dir", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-glob-"));
    try {
      mkdirSync(join(root, "data", "apptweak-2026-05-04"), { recursive: true });
      writeFileSync(join(root, "data", "apptweak-2026-05-04", "metadata.jsonl.gz"), "");
      const resolved = resolveMetadataPath({ dataRoot: root });
      expect(resolved).toBe(join(root, "data", "apptweak-2026-05-04", "metadata.jsonl.gz"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("default reader returns [] when no dossier present (preserves WARN behavior)", () => {
    const root = mkdtempSync(join(tmpdir(), "audit-glob-"));
    try {
      const reader = defaultMetadataReader({ dataRoot: root });
      expect(reader(3)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("audit CLI markets validation", () => {
  test("INVALID_MARKETS exits 2 on non-ISO-alpha-2 token", () => {
    const r = spawnSync("bun", [CLI_PATH, "audit", "--markets", "abc,id"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("INVALID_MARKETS");
    expect(r.stderr).toContain("abc");
  });

  test("uppercase market token is rejected (must be lowercase)", () => {
    const r = spawnSync("bun", [CLI_PATH, "audit", "--markets", "ID,VN"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("INVALID_MARKETS");
  });
});
