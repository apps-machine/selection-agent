/**
 * Internal `--internal opportunity` CLI tests.
 *
 * Coverage:
 *   1. Builds an Opportunity from current signal_snapshots
 *   2. Persists to opportunities table
 *   3. Prints brief to stdout (uses --dry-run so the test doesn't need a
 *      live LLM call for the thesis paragraph)
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "../../src/storage/schema.ts";

const CLI_PATH = resolve(join(import.meta.dir, "..", "..", "src", "cli", "index.ts"));

interface CliResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runCli(argv: string[], env: Record<string, string> = {}): CliResult {
  const r = spawnSync("bun", [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? -1,
  };
}

let workDir: string;
let dbPath: string;
let testCounter = 0;
const NOW = 1_700_000_000_000;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "selection-agent-internal-opp-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function seedSignals(db: Database, app_id: string): void {
  for (const sn of ["locGap", "velocity", "incumbent_vulnerability", "cpi_ltv_proxy"]) {
    db.prepare(
      `INSERT INTO signal_snapshots (
         app_id, signal_name, t, value, llm_prompt_version, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(app_id, sn, NOW - 1000, 7.0, "v1.0.0", NOW - 999);
  }
}

describe("--internal opportunity CLI", () => {
  beforeEach(() => {
    // Each test gets a fresh dbPath. Bun's :memory: isn't shareable across
    // the spawnSync subprocess so we use a per-test file path.
    testCounter += 1;
    dbPath = join(workDir, `test-${testCounter}.sqlite`);
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  test("happy: builds opportunity from current signals, persists, prints brief (dry-run)", () => {
    const db = new Database(dbPath);
    runMigrations(db);
    seedSignals(db, "com.example.calai");
    db.close();

    const r = runCli([
      "--internal",
      "opportunity",
      "--source-app",
      "com.example.calai",
      "--source-market",
      "us",
      "--target",
      "id",
      "--category",
      "health",
      "--dry-run",
      "--db",
      dbPath,
    ]);
    expect(r.status).toBe(0);
    // Brief contains the v1 sections (rendered by renderBrief)
    expect(r.stdout).toContain("**Source:** com.example.calai in us");
    expect(r.stdout).toContain("**Target:** id");
    expect(r.stdout).toContain("**Thesis**");
    expect(r.stdout).toContain("**Signals**");
    expect(r.stdout).toContain("**Predicted economics**");
    // Dry-run thesis placeholder
    expect(r.stdout).toContain("Thesis: [dry-run placeholder]");

    // Verify persisted to opportunities table
    const db2 = new Database(dbPath, { readonly: true });
    const row = db2
      .prepare<
        {
          source_app_id: string;
          target_market: string;
          sig_loc_gap: number | null;
          score: number | null;
          eligible: number;
        },
        [string]
      >(
        "SELECT source_app_id, target_market, sig_loc_gap, score, eligible FROM opportunities WHERE source_app_id = ?",
      )
      .get("com.example.calai");
    expect(row).not.toBeNull();
    expect(row?.target_market).toBe("id");
    expect(row?.sig_loc_gap).toBe(7.0);
    expect(row?.eligible).toBe(1);
    expect(row?.score).toBeCloseTo(7.0);
    db2.close();
  }, 60_000);

  test("ineligible app (N<3 signals) still builds and persists with eligible=0, score=null", () => {
    const db = new Database(dbPath);
    runMigrations(db);
    // Only 2 signals — composer returns eligible=false, score=null
    db.prepare(
      `INSERT INTO signal_snapshots (
           app_id, signal_name, t, value, llm_prompt_version, computed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("com.poor.signals", "locGap", NOW - 1000, 5, "v1.0.0", NOW);
    db.prepare(
      `INSERT INTO signal_snapshots (
           app_id, signal_name, t, value, llm_prompt_version, computed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("com.poor.signals", "velocity", NOW - 1000, 5, "v1.0.0", NOW);
    db.close();

    const r = runCli([
      "--internal",
      "opportunity",
      "--source-app",
      "com.poor.signals",
      "--target",
      "id",
      "--dry-run",
      "--db",
      dbPath,
    ]);
    expect(r.status).toBe(0);

    const db2 = new Database(dbPath, { readonly: true });
    const row = db2
      .prepare<{ score: number | null; eligible: number }, [string]>(
        "SELECT score, eligible FROM opportunities WHERE source_app_id = ?",
      )
      .get("com.poor.signals");
    expect(row?.score).toBeNull();
    expect(row?.eligible).toBe(0);
    db2.close();
  }, 60_000);
});
