/**
 * Internal `--internal winner-score` CLI tests.
 *
 * Coverage:
 *   1. Returns the winner_score (cached or fresh) for an app with seeded data
 *   2. Returns clear error when the app has no observable data at t_measure
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

const T0 = 1_700_000_000_000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

let workDir: string;
let dbPath: string;
let testCounter = 0;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "selection-agent-internal-winnerscore-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function seedAppWithData(
  db: Database,
  app_id: string,
  tier: "winner" | "marginal" | "loser",
): void {
  // Insert chart rows so the app has observable data at t_measure.
  // The captured_at values span 12 months from T0 — winner_score's
  // months_in_top_100 component reads them; rank determines the tier.
  for (let m = 0; m < 12; m++) {
    db.prepare(
      "INSERT INTO chart_snapshots (market, category, captured_at, rank, app_id, source) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "id",
      "productivity",
      T0 + m * MONTH_MS,
      tier === "winner" ? 5 : tier === "marginal" ? 80 : 150,
      app_id,
      "apple_rss",
    );
  }
}

describe("--internal winner-score CLI", () => {
  beforeEach(() => {
    testCounter += 1;
    dbPath = join(workDir, `test-${testCounter}.sqlite`);
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  test("returns winner_score for an app with seeded data (computes fresh + persists)", () => {
    const db = new Database(dbPath);
    runMigrations(db);
    seedAppWithData(db, "id.winner.app", "winner");
    db.close();

    const r = runCli([
      "--internal",
      "winner-score",
      "--app",
      "id.winner.app",
      "--t",
      String(T0),
      "--db",
      dbPath,
    ]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.app_id).toBe("id.winner.app");
    expect(parsed.t0).toBe(T0);
    expect(typeof parsed.score).toBe("number");
    expect(["winner", "marginal", "loser"]).toContain(parsed.tier);
    // Was computed fresh (no winner_scores row yet)
    expect(parsed.source).toBe("fresh computation");

    // Re-running uses the cache
    const r2 = runCli([
      "--internal",
      "winner-score",
      "--app",
      "id.winner.app",
      "--t",
      String(T0),
      "--db",
      dbPath,
    ]);
    expect(r2.status).toBe(0);
    const parsed2 = JSON.parse(r2.stdout);
    expect(parsed2.source).toBe("winner_scores cache");
    expect(parsed2.score).toBe(parsed.score);
  }, 60_000);

  test("returns clear error for app with no data (NO_DATA exit code 2)", () => {
    const db = new Database(dbPath);
    runMigrations(db);
    db.close();

    const r = runCli([
      "--internal",
      "winner-score",
      "--app",
      "ghost.app.no.data",
      "--t",
      String(T0),
      "--db",
      dbPath,
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("NO_DATA");
    expect(r.stderr).toContain("ghost.app.no.data");
  }, 60_000);
});
