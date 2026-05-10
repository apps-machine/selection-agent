/**
 * Unit tests for the Path E `buildShortlist` pipeline.
 *
 * Each test seeds an in-memory SQLite fixture (chart_snapshots + app_invariants)
 * and a synthetic metadata.jsonl, then asserts the funnel + shortlist output.
 *
 * The LLM client is injected as a stub so tests run without network or API key.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShortlist, type LlmClient } from "../../src/path-e/build-shortlist.ts";
import { runMigrations } from "../../src/storage/schema.ts";

const DAY_MS = 86_400_000;
const DATA_END = Date.parse("2026-05-04T00:00:00Z");
const TRAILING_YEAR_START = Date.parse("2025-05-04T00:00:00Z");

let workDir: string;
let dbPath: string;
let metaPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "shortlist-test-"));
  dbPath = join(workDir, "selection-agent.sqlite");
  metaPath = join(workDir, "metadata.jsonl");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function seedDb(): Database {
  const db = new Database(dbPath);
  runMigrations(db);
  return db;
}

function insertChart(
  db: Database,
  appId: string,
  store: "apple" | "googleplay",
  market: string,
  capturedAt: number,
  rank: number,
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
  publisherId: string,
  publisherName: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO app_invariants
       (app_id, store, publisher_id, publisher_name, release_date, source, ingested_at)
     VALUES (?, ?, ?, ?, ?, 'test', ?)`,
  ).run(appId, store, publisherId, publisherName, DATA_END, DATA_END);
}

interface MetaSeed {
  app_id: string;
  store: "apple" | "googleplay";
  title?: string;
  dna_class?: string;
  description?: string;
}

function writeMetadata(seeds: MetaSeed[]): void {
  const lines = seeds.map((s) =>
    JSON.stringify({
      app_id: s.app_id,
      store: s.store,
      market: "id",
      t0: "2025-05-04",
      raw: {
        metadata: {
          title: s.title ?? `App ${s.app_id}`,
          subtitle: null,
          description: s.description ?? "A useful productivity app for busy people.",
          short_description: null,
          long_description: null,
          icon: null,
          dna: { class_label: s.dna_class ?? "Productivity & Tools", subclass_label: null },
          categories: [],
          in_app_purchases: [{ is_subscription: true }],
        },
      },
    }),
  );
  writeFileSync(metaPath, `${lines.join("\n")}\n`, "utf8");
}

/** Seed a durable cross-market app: present in 2 markets ≥180d, recent activity. */
function seedDurableApp(
  db: Database,
  appId: string,
  store: "apple" | "googleplay",
  markets: string[],
  daysCovered = 200,
  rank = 10,
): void {
  for (const m of markets) {
    for (let i = 0; i < daysCovered; i++) {
      const t = DATA_END - i * DAY_MS;
      if (t < TRAILING_YEAR_START) break;
      insertChart(db, appId, store, m, t, rank);
    }
  }
  insertInvariant(db, appId, store, `pub_${appId}`, `Pub ${appId}`);
}

const STUB_CLONE: LlmClient = {
  async classify(_prompt: string): Promise<string> {
    return "CLONE: simple variant — a habit tracker UI";
  },
};

describe("buildShortlist", () => {
  test("empty cohort (no markets in db) returns empty shortlist with zero funnel counts", async () => {
    const db = seedDb();
    db.close();
    writeMetadata([]);

    const result = await buildShortlist({
      dbPath,
      metadataPath: metaPath,
      skipLLM: true,
      silent: true,
    });

    expect(result.shortlist).toEqual([]);
    expect(result.funnel.f1_post_durability).toBe(0);
    expect(result.funnel.f1_post_rollup_app_store_pairs).toBe(0);
    expect(result.funnel.final_candidates).toBe(0);
  });

  test("skipLLM=true keeps all dna-clonable candidates that survive F1-F5", async () => {
    const db = seedDb();
    seedDurableApp(db, "app1", "apple", ["id", "vn"], 200, 10);
    seedDurableApp(db, "app2", "apple", ["id", "th"], 200, 11);
    db.close();
    writeMetadata([
      { app_id: "app1", store: "apple", title: "App One" },
      { app_id: "app2", store: "apple", title: "App Two" },
    ]);

    const result = await buildShortlist({
      dbPath,
      metadataPath: metaPath,
      skipLLM: true,
      silent: true,
    });

    expect(result.shortlist.length).toBe(2);
    // No LLM ran → no clonability_hypothesis annotation
    for (const c of result.shortlist) {
      expect(c.clonability_hypothesis).toBeUndefined();
    }
    expect(result.funnel.final_candidates).toBe(2);
  });

  test("market spread filter drops apps present in only one market", async () => {
    const db = seedDb();
    seedDurableApp(db, "app1", "apple", ["id"], 200, 10); // only one market
    seedDurableApp(db, "app2", "apple", ["id", "vn"], 200, 11);
    db.close();
    writeMetadata([
      { app_id: "app1", store: "apple" },
      { app_id: "app2", store: "apple" },
    ]);

    const result = await buildShortlist({
      dbPath,
      metadataPath: metaPath,
      skipLLM: true,
      silent: true,
    });

    expect(result.shortlist.length).toBe(1);
    expect(result.shortlist[0]?.app_id).toBe("app2");
  });

  test("dna_class filter drops not-clonable mechanic", async () => {
    const db = seedDb();
    seedDurableApp(db, "app1", "apple", ["id", "vn"], 200, 10);
    seedDurableApp(db, "app2", "apple", ["id", "th"], 200, 11);
    db.close();
    writeMetadata([
      { app_id: "app1", store: "apple", dna_class: "Social Networking" }, // NOT_CLONABLE
      { app_id: "app2", store: "apple", dna_class: "Productivity & Tools" }, // AUTO
    ]);

    const result = await buildShortlist({
      dbPath,
      metadataPath: metaPath,
      skipLLM: true,
      silent: true,
    });

    expect(result.shortlist.length).toBe(1);
    expect(result.shortlist[0]?.app_id).toBe("app2");
    expect(result.funnel.dropped_not_clonable).toBe(1);
  });

  test("finalShortlistSize truncates the post-LLM pool", async () => {
    const db = seedDb();
    for (let i = 0; i < 5; i++) {
      seedDurableApp(db, `app${i}`, "apple", ["id", "vn"], 200, 10 + i);
    }
    db.close();
    writeMetadata(
      Array.from({ length: 5 }, (_, i) => ({ app_id: `app${i}`, store: "apple" as const })),
    );

    const result = await buildShortlist({
      dbPath,
      metadataPath: metaPath,
      skipLLM: true,
      finalShortlistSize: 2,
      silent: true,
    });

    expect(result.shortlist.length).toBe(2);
    expect(result.funnel.final_candidates).toBe(5);
  });

  test("LLM client is called once per candidate when skipLLM=false", async () => {
    const db = seedDb();
    seedDurableApp(db, "app1", "apple", ["id", "vn"], 200, 10);
    seedDurableApp(db, "app2", "apple", ["id", "th"], 200, 11);
    db.close();
    writeMetadata([
      { app_id: "app1", store: "apple" },
      { app_id: "app2", store: "apple" },
    ]);

    let calls = 0;
    const stub: LlmClient = {
      async classify(_p: string): Promise<string> {
        calls += 1;
        // First half CLONE, second half SKIP
        return calls === 1 ? "CLONE: ok" : "SKIP: not for solo";
      },
    };

    const result = await buildShortlist({
      dbPath,
      metadataPath: metaPath,
      skipLLM: false,
      llmClient: stub,
      silent: true,
    });

    expect(calls).toBe(2);
    // Only the CLONE-tagged one survives the post-LLM filter
    expect(result.shortlist.length).toBe(1);
    expect(result.shortlist[0]?.clonability_hypothesis).toMatch(/^CLONE:/);
  });

  test("outputDir writes csv + json files and returns the same shortlist", async () => {
    const db = seedDb();
    seedDurableApp(db, "app1", "apple", ["id", "vn"], 200);
    db.close();
    writeMetadata([{ app_id: "app1", store: "apple" }]);

    const outDir = join(workDir, "out");
    const result = await buildShortlist({
      dbPath,
      metadataPath: metaPath,
      skipLLM: true,
      outputDir: outDir,
      silent: true,
    });

    expect(existsSync(result.csvPath ?? "")).toBe(true);
    expect(existsSync(result.jsonPath ?? "")).toBe(true);
    const csv = readFileSync(result.csvPath ?? "", "utf8");
    expect(csv.split("\n")[0]).toContain("rank,score");
    const json = JSON.parse(readFileSync(result.jsonPath ?? "", "utf8"));
    expect(json.shortlist.length).toBe(1);
    expect(json.config.tier2_sea_markets).toEqual(["id", "vn", "th", "my", "bd"]);
  });

  test("missing metadata file produces an empty cohort (no metadata-matched candidates)", async () => {
    const db = seedDb();
    seedDurableApp(db, "app1", "apple", ["id", "vn"], 200);
    db.close();
    // Do not write metadata file
    const result = await buildShortlist({
      dbPath,
      metadataPath: join(workDir, "nope.jsonl"),
      skipLLM: true,
      silent: true,
    });
    expect(result.shortlist).toEqual([]);
    expect(result.funnel.dropped_no_meta).toBeGreaterThanOrEqual(1);
  });
});

// Re-export STUB_CLONE so other test files can reuse it.
export { STUB_CLONE };
