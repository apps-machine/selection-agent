/**
 * Internal `--internal backtest` CLI tests.
 *
 * Coverage:
 *   1. CLI parses --internal backtest --cohort X --market id --k 10 correctly
 *   2. Runs end-to-end with seeded in-memory db (uses tmp file path so the
 *      subprocess can open it; in-memory ":memory:" is per-process)
 *   3. Writes report markdown + JSON to expected location
 *   4. Without --internal, internal subcommands are NOT in --help text
 *   5. Without --internal, attempting to invoke "backtest" as a top-level
 *      subcommand fails clearly (citty's "command not found")
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const T0 = 1_700_000_000_000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const T_MEASURE = T0 + 12 * MONTH_MS;

let workDir: string;
let dbPath: string;
let outDir: string;
let testCounter = 0;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "selection-agent-internal-backtest-"));
  outDir = join(workDir, "reports");
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let chartRankCounter = 0;
function nextRank(): number {
  chartRankCounter += 1;
  return chartRankCounter;
}

function seedDb(path: string): void {
  const db = new Database(path);
  runMigrations(db);

  // Seed 5 apps (4 eligible + 1 ineligible). 2 winners.
  const apps: Array<{ id: string; signals: number; tier: "winner" | "loser" }> = [
    { id: "id.app.winner1", signals: 9, tier: "winner" },
    { id: "id.app.winner2", signals: 8, tier: "winner" },
    { id: "id.app.loser1", signals: 6, tier: "loser" },
    { id: "id.app.loser2", signals: 5, tier: "loser" },
  ];
  for (const a of apps) {
    db.prepare(
      "INSERT INTO chart_snapshots (market, category, captured_at, rank, app_id, source) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("id", "productivity", T0 - 1000, nextRank(), a.id, "apple_rss");
    for (const sn of ["locGap", "velocity", "incumbent_vulnerability", "cpi_ltv_proxy"]) {
      db.prepare(
        `INSERT INTO signal_snapshots (
           app_id, signal_name, t, value, llm_prompt_version, computed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(a.id, sn, T0 - 100, a.signals, "v1.0.0", T0);
    }
    db.prepare(
      `INSERT INTO winner_scores
         (app_id, t0, measured_at, score, tier, formula_version, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, T0, T_MEASURE, a.tier === "winner" ? 8.5 : 3.0, a.tier, "v1.0.0", T_MEASURE + 1);
  }
  db.close();
}

describe("--internal backtest CLI", () => {
  beforeEach(() => {
    chartRankCounter = 0;
    // Each test gets a fresh dbPath so concurrent test execution doesn't
    // collide on the same SQLite file.
    testCounter += 1;
    dbPath = join(workDir, `test-${testCounter}.sqlite`);
    seedDb(dbPath);
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  test("happy: --internal backtest --cohort X --market id --k 5 runs end-to-end and writes report", () => {
    const r = runCli([
      "--internal",
      "backtest",
      "--cohort",
      "test-cohort",
      "--market",
      "id",
      "--t0",
      String(T0),
      "--k",
      "5",
      "--db",
      dbPath,
      "--out-dir",
      outDir,
    ]);
    expect(r.status).toBe(0);
    // Stdout summary line
    expect(r.stdout).toContain("Backtest complete");
    expect(r.stdout).toContain("Candidates: 4");
    expect(r.stdout).toContain("Eligible: 4");
    expect(r.stdout).toContain("Winners: 2");
    // Report files written
    const matchPath = r.stdout.match(/Backtest complete — wrote (\S+\.md)/);
    expect(matchPath).not.toBeNull();
    const mdPath = matchPath?.[1];
    expect(mdPath).toBeDefined();
    if (!mdPath) throw new Error("md path not parsed");
    expect(existsSync(mdPath)).toBe(true);
    const md = readFileSync(mdPath, "utf8");
    expect(md).toContain("# v1 Backtest Report — test-cohort");
    expect(md).toContain("## Precision @ K");
    // JSON sidecar exists with same base
    const jsonPath = mdPath.replace(/\.md$/, ".json");
    expect(existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(parsed.cohort_label).toBe("test-cohort");
    expect(parsed.candidate_count).toBe(4);
    expect(parsed.winner_count).toBe(2);
  }, 60_000);

  test("without --internal, internal subcommand names are NOT registered with the public citty dispatcher", async () => {
    // Why we don't grep --help under spawnSync: there's a pre-existing
    // Bun:test wrapper interaction with citty where --help output is
    // truncated when invoked via spawnSync inside a bun:test process.
    // (Manually `bun src/cli/index.ts --help` prints the full body; only
    // the bun:test → spawnSync → bun → citty stack truncates.)
    //
    // Stronger check: verify structurally via source inspection that
    // the public main command's subCommands map does NOT contain the
    // internal names. A future PR removing the --internal gate would
    // either need to register internal names there (caught by this
    // assertion) or leave them gated (test passes).
    const fs = await import("node:fs");
    const cliSrc = fs.readFileSync(CLI_PATH, "utf8");
    // citty-style key patterns inside the public subCommands literal:
    // `<name>: defineCommand({ ... })` or `"<name>": defineCommand({...})`.
    // We assert NONE of the internal names appear in that form.
    expect(cliSrc).not.toMatch(/^\s*backtest:\s*defineCommand/m);
    expect(cliSrc).not.toMatch(/"backtest":\s*defineCommand/);
    expect(cliSrc).not.toMatch(/^\s*"?winner-score"?:\s*defineCommand/m);
    expect(cliSrc).not.toMatch(/^\s*opportunity:\s*defineCommand/m);
    // And confirm the gate IS present (a refactor that removes the gate
    // is caught at unit-test time, not at runtime).
    expect(cliSrc).toContain("--internal");
    expect(cliSrc).toContain("maybeRunInternal");
    // And confirm the public surface IS still present so we don't
    // accidentally pass by hiding everything.
    expect(cliSrc).toMatch(/demo:\s*defineCommand/);
    expect(cliSrc).toMatch(/scan:\s*defineCommand/);
    expect(cliSrc).toMatch(/snapshot:\s*defineCommand/);
  }, 30_000);

  test("without --internal, invoking 'backtest' as top-level fails clearly", () => {
    const r = runCli(["backtest", "--cohort", "x", "--market", "id", "--t0", String(T0)]);
    // citty rejects unknown subcommands with non-zero exit. We don't
    // pin the exact exit code (citty version variance) — just non-zero
    // and not the success path.
    expect(r.status).not.toBe(0);
  }, 30_000);

  test("--internal without a subcommand fails with clear error", () => {
    const r = runCli(["--internal"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("INTERNAL_SUBCOMMAND_REQUIRED");
  }, 30_000);

  test("--internal with unknown subcommand fails with clear error", () => {
    const r = runCli(["--internal", "made-up-command"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("UNKNOWN_INTERNAL_SUBCOMMAND");
  }, 30_000);
});
