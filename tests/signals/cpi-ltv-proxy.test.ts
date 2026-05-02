/**
 * Tests for src/signals/cpi-ltv-proxy.ts.
 *
 * Coverage required by docs/planning/agent-v1-foundation.md task 4 part B:
 *   - Happy: known (category, market) in seed → expected score in expected band
 *   - Unknown category in known market → fallback to family if defined, else null
 *   - Unknown market entirely → null
 *   - Score band correctness: ratio 20 → 8-10, 12 → 5-7, 7 → 2-4, 3 → 0-1
 *   - Seed file loads + parses + has 30+ entries
 *   - Persistence: signal_snapshots row written with the expected provenance
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CPI_LTV_ESTIMATES,
  CPI_LTV_PROXY_VERSION,
  CPI_LTV_SEED_VERSION,
  computeAndPersistCpiLtvProxy,
  computeCpiLtvProxy,
  lookupCpiLtvEstimate,
  persistCpiLtvProxySignal,
  SIGNAL_NAME,
  scoreFromRatio,
} from "../../src/signals/cpi-ltv-proxy.ts";
import { runMigrations } from "../../src/storage/schema.ts";

describe("scoreFromRatio — band correctness", () => {
  test("ratio = 20 → score in 8-10 band", () => {
    const s = scoreFromRatio(20);
    expect(s).toBeGreaterThanOrEqual(8);
    expect(s).toBeLessThanOrEqual(10);
  });

  test("ratio = 12 → score in 5-7 band", () => {
    const s = scoreFromRatio(12);
    expect(s).toBeGreaterThanOrEqual(5);
    expect(s).toBeLessThanOrEqual(7);
  });

  test("ratio = 7 → score in 2-4 band", () => {
    const s = scoreFromRatio(7);
    expect(s).toBeGreaterThanOrEqual(2);
    expect(s).toBeLessThanOrEqual(4);
  });

  test("ratio = 3 → score in 0-1 band", () => {
    const s = scoreFromRatio(3);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  test("boundary: ratio just below 5 → score in 0-1 band (top of band ≈ 1)", () => {
    // Spec ranges are open at the lower end of the next band; values at the
    // exact boundary (e.g., 5) jump up into the next band. Tests pin both
    // sides so the boundary semantics are explicit.
    expect(scoreFromRatio(4.999)).toBeCloseTo(1, 2);
    expect(scoreFromRatio(5)).toBeCloseTo(2, 5); // entry into 2-4 band
  });

  test("boundary: ratio just below 10 → score top of 2-4 band; at 10 → bottom of 5-7", () => {
    expect(scoreFromRatio(9.999)).toBeCloseTo(4, 2);
    expect(scoreFromRatio(10)).toBeCloseTo(5, 5);
  });

  test("boundary: ratio = 15 → top of 5-7 band (still inside the closed upper edge)", () => {
    // Spec writes "10 ≤ ratio ≤ 15 → 5-7" — inclusive at 15, so value at 15
    // is the band ceiling 7, not the next band entry 8.
    expect(scoreFromRatio(15)).toBeCloseTo(7, 5);
    expect(scoreFromRatio(15.001)).toBeCloseTo(8, 2); // first step into 8-10
  });

  test("ratio > 25 → capped at 10", () => {
    expect(scoreFromRatio(50)).toBe(10);
    expect(scoreFromRatio(1000)).toBe(10);
  });

  test("ratio = 0 → 0", () => {
    expect(scoreFromRatio(0)).toBe(0);
  });

  test("negative or non-finite ratio → 0 (defensive)", () => {
    expect(scoreFromRatio(-3)).toBe(0);
    expect(scoreFromRatio(Number.NaN)).toBe(0);
    expect(scoreFromRatio(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("monotonic: higher ratio always produces higher score", () => {
    const samples = [1, 2, 4, 5, 7, 9, 10, 12, 14, 15, 18, 22];
    for (let i = 1; i < samples.length; i++) {
      const a = scoreFromRatio(samples[i - 1]!);
      const b = scoreFromRatio(samples[i]!);
      expect(b).toBeGreaterThanOrEqual(a);
    }
  });
});

describe("seed file — loads + parses + has ≥30 entries", () => {
  test("CPI_LTV_SEED_VERSION matches the v1 seed contract", () => {
    expect(CPI_LTV_SEED_VERSION).toMatch(/^v\d+\.\d+\.\d+/);
    expect(CPI_LTV_SEED_VERSION).toBe("v1.0.0-seed");
  });

  test("seed has at least 30 estimate rows", () => {
    expect(CPI_LTV_ESTIMATES.length).toBeGreaterThanOrEqual(30);
  });

  test("seed covers id/vn/th/my/ph/bd × 5 categories each", () => {
    const required = ["id", "vn", "th", "my", "ph", "bd"];
    const cats = ["health", "productivity", "finance", "lifestyle", "social"];
    for (const m of required) {
      for (const c of cats) {
        const row = CPI_LTV_ESTIMATES.find((e) => e.market === m && e.category === c);
        expect(row, `missing seed row for ${m}/${c}`).not.toBeUndefined();
      }
    }
  });

  test("every seed row has cpi_low ≤ cpi_high and ltv_low ≤ ltv_high", () => {
    for (const e of CPI_LTV_ESTIMATES) {
      expect(e.cpi_low, `cpi_low > cpi_high for ${e.market}/${e.category}`).toBeLessThanOrEqual(
        e.cpi_high,
      );
      expect(e.ltv_low, `ltv_low > ltv_high for ${e.market}/${e.category}`).toBeLessThanOrEqual(
        e.ltv_high,
      );
    }
  });

  test("every seed row has positive cpi + ltv", () => {
    for (const e of CPI_LTV_ESTIMATES) {
      expect(e.cpi_low).toBeGreaterThan(0);
      expect(e.ltv_low).toBeGreaterThan(0);
    }
  });
});

describe("lookupCpiLtvEstimate — direct + family fallback", () => {
  test("direct hit: id/health → returns id/health row", () => {
    const e = lookupCpiLtvEstimate("health", "id");
    expect(e).not.toBeNull();
    expect(e?.market).toBe("id");
    expect(e?.category).toBe("health");
  });

  test("case-insensitive market and category", () => {
    const e1 = lookupCpiLtvEstimate("HEALTH", "ID");
    const e2 = lookupCpiLtvEstimate("Health", "Id");
    expect(e1?.market).toBe("id");
    expect(e2?.market).toBe("id");
  });

  test("unknown category in known market → family fallback used", () => {
    // utilities → falls back to productivity → exists
    const e = lookupCpiLtvEstimate("utilities", "id");
    expect(e).not.toBeNull();
    expect(e?.market).toBe("id");
    expect(e?.category).toBe("productivity");
  });

  test("fallback chain: education → productivity in id", () => {
    const e = lookupCpiLtvEstimate("education", "id");
    expect(e?.category).toBe("productivity");
  });

  test("fallback chain: shopping → lifestyle in id", () => {
    const e = lookupCpiLtvEstimate("shopping", "id");
    expect(e?.category).toBe("lifestyle");
  });

  test("unknown market entirely → null (no fallback)", () => {
    expect(lookupCpiLtvEstimate("health", "zz")).toBeNull();
    // even with a category that exists in other markets
    expect(lookupCpiLtvEstimate("productivity", "fr")).toBeNull();
  });

  test("totally unknown category in known market without family → null", () => {
    // A category not in CATEGORY_FAMILY at all
    expect(lookupCpiLtvEstimate("nonsense-cat-xyz", "id")).toBeNull();
  });
});

describe("computeCpiLtvProxy — full pipeline", () => {
  test("happy: id/health returns score in expected band with metadata", () => {
    const out = computeCpiLtvProxy("health", "id");
    expect(out.score).not.toBeNull();
    expect(out.score!).toBeGreaterThanOrEqual(0);
    expect(out.score!).toBeLessThanOrEqual(10);
    expect(out.estimate).not.toBeNull();
    expect(out.ratio).not.toBeNull();
    expect(out.ratio!).toBeGreaterThan(0);
    expect(out.fallback).toBe(false);
  });

  test("happy: id/health expected ratio matches midpoint math", () => {
    // From seed: cpi 0.30-0.80 (mid 0.55), ltv 3.50-8.00 (mid 5.75)
    // ratio = 5.75 / 0.55 ≈ 10.45 → score in 5-7 band
    const out = computeCpiLtvProxy("health", "id");
    expect(out.ratio).toBeCloseTo(5.75 / 0.55, 4);
    expect(out.score!).toBeGreaterThanOrEqual(5);
    expect(out.score!).toBeLessThanOrEqual(7);
  });

  test("fallback flag: utilities in id resolves via family + sets fallback=true", () => {
    const out = computeCpiLtvProxy("utilities", "id");
    expect(out.score).not.toBeNull();
    expect(out.fallback).toBe(true);
    expect(out.estimate?.category).toBe("productivity");
  });

  test("unknown market → score null, estimate null, fallback false", () => {
    const out = computeCpiLtvProxy("health", "xx");
    expect(out.score).toBeNull();
    expect(out.estimate).toBeNull();
    expect(out.ratio).toBeNull();
    expect(out.fallback).toBe(false);
  });

  test("unknown category with no family path → score null", () => {
    const out = computeCpiLtvProxy("nonsense-cat-zzz", "id");
    expect(out.score).toBeNull();
  });

  test("smoke: every (market, category) covered by seed produces a score", () => {
    const required = ["id", "vn", "th", "my", "ph", "bd"];
    const cats = ["health", "productivity", "finance", "lifestyle", "social"];
    for (const m of required) {
      for (const c of cats) {
        const out = computeCpiLtvProxy(c, m);
        expect(out.score, `null score for ${m}/${c}`).not.toBeNull();
      }
    }
  });
});

describe("persistCpiLtvProxySignal — signal_snapshots provenance", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });
  afterEach(() => db.close());

  test("writes a row with all LLM provenance NULL except version sentinel", () => {
    const t = Date.parse("2026-04-30T00:00:00.000Z");
    persistCpiLtvProxySignal(db, "a1", 5.5, t, { clock: () => t + 1 });
    const row = db
      .prepare<
        {
          app_id: string;
          signal_name: string;
          t: number;
          value: number | null;
          llm_model: string | null;
          llm_prompt_version: string;
          llm_request_hash: string | null;
          llm_response_hash: string | null;
          llm_response_archived: string | null;
          source_urls_json: string | null;
          computed_at: number;
        },
        [string]
      >("SELECT * FROM signal_snapshots WHERE signal_name = ?")
      .get(SIGNAL_NAME);
    expect(row?.app_id).toBe("a1");
    expect(row?.signal_name).toBe(SIGNAL_NAME);
    expect(row?.value).toBe(5.5);
    expect(row?.llm_prompt_version).toBe(CPI_LTV_PROXY_VERSION);
    expect(row?.source_urls_json).toBe("[]");
  });

  test("null score persists as NULL (not 0)", () => {
    const t = Date.parse("2026-04-30T00:00:00.000Z");
    persistCpiLtvProxySignal(db, "a2", null, t);
    const row = db
      .prepare<{ value: number | null }, [string]>(
        "SELECT value FROM signal_snapshots WHERE app_id='a2' AND signal_name=?",
      )
      .get(SIGNAL_NAME);
    expect(row?.value).toBeNull();
  });

  test("CPI_LTV_PROXY_VERSION = v1.0.0", () => {
    expect(CPI_LTV_PROXY_VERSION).toBe("v1.0.0");
  });

  test("SIGNAL_NAME = cpi_ltv_proxy", () => {
    expect(SIGNAL_NAME).toBe("cpi_ltv_proxy");
  });
});

describe("computeAndPersistCpiLtvProxy — end-to-end", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });
  afterEach(() => db.close());

  test("happy: id/finance computes + persists in one shot", () => {
    const t = Date.parse("2026-04-30T00:00:00.000Z");
    const out = computeAndPersistCpiLtvProxy(db, {
      app_id: "src-app-1",
      category: "finance",
      market: "id",
      t,
      clock: () => t,
    });
    expect(out.score).not.toBeNull();
    const row = db
      .prepare<{ value: number; signal_name: string }, []>(
        "SELECT value, signal_name FROM signal_snapshots WHERE app_id='src-app-1'",
      )
      .get();
    expect(row?.signal_name).toBe(SIGNAL_NAME);
    expect(row?.value).toBe(out.score!);
  });

  test("unknown market: persists null score (the absence is recorded)", () => {
    const t = Date.parse("2026-04-30T00:00:00.000Z");
    const out = computeAndPersistCpiLtvProxy(db, {
      app_id: "src-unknown",
      category: "health",
      market: "zz",
      t,
      clock: () => t,
    });
    expect(out.score).toBeNull();
    const row = db
      .prepare<{ value: number | null }, []>(
        "SELECT value FROM signal_snapshots WHERE app_id='src-unknown'",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row?.value).toBeNull();
  });
});
