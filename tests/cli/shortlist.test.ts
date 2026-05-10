/**
 * `selection-agent shortlist` CLI integration tests.
 *
 * Spawns the CLI as a subprocess (mirroring the audit-command pattern) and
 * asserts on exit code + stdout/stderr. Pipeline correctness is covered by
 * the unit tests in tests/path-e/build-shortlist.test.ts.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "../../src/storage/schema.ts";

const CLI_PATH = resolve(join(import.meta.dir, "..", "..", "src", "cli", "index.ts"));

const DAY_MS = 86_400_000;
const DATA_END = Date.parse("2026-05-04T00:00:00Z");
const TRAILING_YEAR_START = Date.parse("2025-05-04T00:00:00Z");

let workDir: string;
let dbPath: string;
let metaPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "shortlist-cli-test-"));
  dbPath = join(workDir, "selection-agent.sqlite");
  metaPath = join(workDir, "metadata.jsonl");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function seedFixture(): void {
  const db = new Database(dbPath);
  runMigrations(db);
  // Two durable cross-market apps
  for (const [appId, market, rank] of [
    ["app1", "id", 10],
    ["app1", "vn", 10],
    ["app2", "id", 11],
    ["app2", "th", 11],
  ] as const) {
    for (let i = 0; i < 200; i++) {
      const t = DATA_END - i * DAY_MS;
      if (t < TRAILING_YEAR_START) break;
      db.prepare(
        `INSERT OR REPLACE INTO chart_snapshots
           (market, category, captured_at, rank, app_id, source, store)
         VALUES (?, 'top_grossing_overall', ?, ?, ?, 'test', 'apple')`,
      ).run(market, t, rank, appId);
    }
  }
  for (const appId of ["app1", "app2"]) {
    db.prepare(
      `INSERT OR REPLACE INTO app_invariants
         (app_id, store, publisher_id, publisher_name, release_date, source, ingested_at)
       VALUES (?, 'apple', ?, ?, ?, 'test', ?)`,
    ).run(appId, `pub_${appId}`, `Pub ${appId}`, DATA_END, DATA_END);
  }
  db.close();
  const metaLines = ["app1", "app2"].map((appId) =>
    JSON.stringify({
      app_id: appId,
      store: "apple",
      market: "id",
      t0: "2025-05-04",
      raw: {
        metadata: {
          title: `App ${appId}`,
          subtitle: null,
          description: "A useful productivity app",
          dna: { class_label: "Productivity & Tools", subclass_label: null },
          categories: [],
          in_app_purchases: [{ is_subscription: true }],
        },
      },
    }),
  );
  writeFileSync(metaPath, `${metaLines.join("\n")}\n`, "utf8");
}

describe("selection-agent shortlist CLI", () => {
  test("--no-llm exits 0 and writes csv+json under --output", () => {
    seedFixture();
    const outDir = join(workDir, "out");
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "shortlist",
        "--db",
        dbPath,
        "--metadata",
        metaPath,
        "--no-llm",
        "--output",
        outDir,
      ],
      { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", LOG_LEVEL: "silent" } },
    );
    expect(r.status).toBe(0);
    expect(existsSync(outDir)).toBe(true);
    // Should contain one timestamped subdir with shortlist.csv + json
    const subdirs = readdirSync(outDir);
    expect(subdirs.length).toBe(1);
    const sub = join(outDir, subdirs[0] ?? "");
    expect(existsSync(join(sub, "shortlist.csv"))).toBe(true);
    expect(existsSync(join(sub, "shortlist.json"))).toBe(true);
    expect(r.stdout).toContain("shortlist");
  });

  test("--markets invalid token exits 2 with INVALID_MARKETS", () => {
    const r = spawnSync(
      "bun",
      [CLI_PATH, "shortlist", "--db", dbPath, "--markets", "abc,id", "--no-llm"],
      { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("INVALID_MARKETS");
    expect(r.stderr).toContain("abc");
  });

  test("missing DB exits 1 with a clear error", () => {
    const r = spawnSync(
      "bun",
      [CLI_PATH, "shortlist", "--db", "/nonexistent/no/such/db.sqlite", "--no-llm"],
      { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("SHORTLIST_FAILED");
    expect(r.stderr).toContain("database not found");
  });

  test("--shortlist-size truncates the final output", () => {
    seedFixture();
    const outDir = join(workDir, "out");
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "shortlist",
        "--db",
        dbPath,
        "--metadata",
        metaPath,
        "--no-llm",
        "--output",
        outDir,
        "--shortlist-size",
        "1",
      ],
      { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", LOG_LEVEL: "silent" } },
    );
    expect(r.status).toBe(0);
    const subdirs = readdirSync(outDir);
    const sub = subdirs[0] ?? "";
    const json = JSON.parse(readFileSync(join(outDir, sub, "shortlist.json"), "utf8"));
    expect(json.shortlist.length).toBe(1);
  });

  test("--no-llm without ANTHROPIC_API_KEY still succeeds (no LLM dependency)", () => {
    seedFixture();
    const env: Record<string, string | undefined> = {
      ...process.env,
      NO_COLOR: "1",
      LOG_LEVEL: "silent",
    };
    delete env.ANTHROPIC_API_KEY;
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "shortlist",
        "--db",
        dbPath,
        "--metadata",
        metaPath,
        "--no-llm",
        "--output",
        join(workDir, "out2"),
      ],
      { encoding: "utf8", env },
    );
    expect(r.status).toBe(0);
  });

  test("(no --no-llm, no ANTHROPIC_API_KEY) → exits 2 with MISSING_API_KEY", () => {
    seedFixture();
    const env: Record<string, string | undefined> = {
      ...process.env,
      NO_COLOR: "1",
      LOG_LEVEL: "silent",
    };
    delete env.ANTHROPIC_API_KEY;
    const r = spawnSync("bun", [CLI_PATH, "shortlist", "--db", dbPath, "--metadata", metaPath], {
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("MISSING_API_KEY");
  });
});
