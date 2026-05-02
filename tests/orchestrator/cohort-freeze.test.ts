import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type CohortFreeze,
  freezeCohort,
  getFrozenCohortFeatures,
} from "../../src/orchestrator/cohort-freeze.ts";
import { runMigrations } from "../../src/storage/schema.ts";

const T0 = 1_700_000_000_000; // arbitrary unix-ms decision date
const MARKET = "id" as const;

// Monotonic rank counter so multiple chart rows in a single test don't
// collide on the (market, category, captured_at, rank) PK.
let rankCounter = 0;
function nextRank(): number {
  rankCounter += 1;
  return rankCounter;
}

function insertChartRow(
  db: Database,
  args: {
    app_id: string;
    captured_at: number;
    market?: string;
    category?: string;
    rank?: number;
    source?: string;
  },
): void {
  db.prepare(
    "INSERT INTO chart_snapshots (market, category, captured_at, rank, app_id, source) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    args.market ?? MARKET,
    args.category ?? "productivity",
    args.captured_at,
    args.rank ?? nextRank(),
    args.app_id,
    args.source ?? "apple_rss",
  );
}

function insertSignalRow(
  db: Database,
  args: { app_id: string; t: number; value?: number | null; signal?: string; prompt?: string },
): void {
  db.prepare(
    `INSERT INTO signal_snapshots (app_id, signal_name, t, value, llm_prompt_version, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    args.app_id,
    args.signal ?? "locGap",
    args.t,
    args.value ?? null,
    args.prompt ?? "v1.0.0",
    args.t + 1,
  );
}

describe("freezeCohort", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  test("persists and returns the frozen cohort", () => {
    insertChartRow(db, { app_id: "a1", captured_at: T0 - 1000 });
    insertChartRow(db, { app_id: "a2", captured_at: T0 - 2000 });

    const freeze = freezeCohort(db, MARKET, T0, ["a1", "a2"], { clock: () => 9999 });

    expect(freeze.t0).toBe(T0);
    expect(freeze.market).toBe(MARKET);
    expect(freeze.app_ids).toEqual(["a1", "a2"]);
    expect(freeze.frozen_at).toBe(9999);

    // Persisted to cohort_freezes
    const row = db
      .prepare<{ app_ids_json: string; frozen_at: number }, [string, number]>(
        "SELECT app_ids_json, frozen_at FROM cohort_freezes WHERE market=? AND t0=?",
      )
      .get(MARKET, T0);
    expect(row?.frozen_at).toBe(9999);
    expect(JSON.parse(row?.app_ids_json ?? "[]")).toEqual(["a1", "a2"]);
  });

  test("rejects empty cohort", () => {
    expect(() => freezeCohort(db, MARKET, T0, [])).toThrow(/empty/i);
  });

  test("rejects when an app has no chart_snapshots row at or before t0", () => {
    insertChartRow(db, { app_id: "a1", captured_at: T0 - 1000 });
    // a2 has NO chart row → must throw
    expect(() => freezeCohort(db, MARKET, T0, ["a1", "a2"])).toThrow(
      /missing from chart_snapshots/,
    );
  });

  test("rejects when an app's chart_snapshots row is post-t0", () => {
    insertChartRow(db, { app_id: "a1", captured_at: T0 - 1000 });
    insertChartRow(db, { app_id: "a2", captured_at: T0 + 1000 });
    expect(() => freezeCohort(db, MARKET, T0, ["a1", "a2"])).toThrow(
      /missing from chart_snapshots/,
    );
  });

  test("accepts app with chart row exactly at t0 (boundary inclusive)", () => {
    insertChartRow(db, { app_id: "a1", captured_at: T0 });
    const freeze = freezeCohort(db, MARKET, T0, ["a1"]);
    expect(freeze.app_ids).toEqual(["a1"]);
  });

  test("rejects re-freezing same (market, t0) with composite-PK collision", () => {
    insertChartRow(db, { app_id: "a1", captured_at: T0 - 1000 });
    freezeCohort(db, MARKET, T0, ["a1"]);
    expect(() => freezeCohort(db, MARKET, T0, ["a1"])).toThrow();
  });
});

describe("getFrozenCohortFeatures", () => {
  let db: Database;
  let freeze: CohortFreeze;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    insertChartRow(db, { app_id: "a1", captured_at: T0 - 5000 });
    insertChartRow(db, { app_id: "a2", captured_at: T0 - 5000 });
    freeze = freezeCohort(db, MARKET, T0, ["a1", "a2"]);
  });

  afterEach(() => {
    db.close();
  });

  test("returns rows with t < t0", () => {
    insertSignalRow(db, { app_id: "a1", t: T0 - 1000, value: 7.5 });
    insertSignalRow(db, { app_id: "a2", t: T0 - 1000, value: 6.0 });

    const rows = getFrozenCohortFeatures(db, freeze);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.t <= freeze.t0)).toBe(true);
  });

  test("returns rows with t == t0 (boundary inclusive)", () => {
    insertSignalRow(db, { app_id: "a1", t: T0, value: 7.5 });
    const rows = getFrozenCohortFeatures(db, freeze);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.t).toBe(T0);
  });

  test("throws on leakage when post-t0 row exists for a frozen app", () => {
    insertSignalRow(db, { app_id: "a1", t: T0 - 1000, value: 7.5 });
    insertSignalRow(db, { app_id: "a1", t: T0 + 1000, value: 8.0 }); // leakage
    expect(() => getFrozenCohortFeatures(db, freeze)).toThrow(/leakage/i);
  });

  test("ignores post-t0 rows for apps NOT in the frozen cohort (no false leakage)", () => {
    insertChartRow(db, { app_id: "a3", captured_at: T0 - 5000 });
    insertSignalRow(db, { app_id: "a3", t: T0 + 1000, value: 9.0 }); // post-t0 but not in cohort
    insertSignalRow(db, { app_id: "a1", t: T0 - 1000, value: 7.5 });

    const rows = getFrozenCohortFeatures(db, freeze);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.app_id).toBe("a1");
  });

  test("returns empty array when freeze.app_ids is empty (defensive)", () => {
    const emptyFreeze: CohortFreeze = {
      t0: T0,
      market: MARKET,
      app_ids: [],
      frozen_at: 0,
    };
    expect(getFrozenCohortFeatures(db, emptyFreeze)).toEqual([]);
  });

  test("preserves LLM provenance columns in result rows", () => {
    db.prepare(
      `INSERT INTO signal_snapshots (
        app_id, signal_name, t, value,
        llm_model, llm_prompt_version, llm_request_hash, llm_response_hash,
        llm_response_archived, source_urls_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "a1",
      "locGap",
      T0 - 1000,
      7.5,
      "claude-opus-4-7",
      "v1.0.0",
      "req-hash-abc",
      "resp-hash-def",
      "raw response text",
      '["https://example.com"]',
      T0,
    );
    const rows = getFrozenCohortFeatures(db, freeze);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.llm_model).toBe("claude-opus-4-7");
    expect(row?.llm_prompt_version).toBe("v1.0.0");
    expect(row?.llm_request_hash).toBe("req-hash-abc");
    expect(row?.llm_response_archived).toBe("raw response text");
    expect(row?.source_urls_json).toBe('["https://example.com"]');
  });
});
