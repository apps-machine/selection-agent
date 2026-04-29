import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TextJudgeResult, VisionJudgeResult } from "../../src/judges/schemas.ts";
import { Cache } from "../../src/storage/cache.ts";

const TEXT_RESULT: TextJudgeResult = {
  kind: "text",
  appId: "com.example.app1",
  store: "apple",
  market: "fr",
  locGapScore: 7.5,
  reasoning: "English-only on a French chart, no localized paywall.",
  signals: {
    hasNativeLanguage: false,
    hasCulturalAdaptation: false,
    hasLocalizedPaywall: false,
    hasLocalPaymentMethod: false,
  },
  confidence: 0.8,
  modelVersion: "claude-sonnet-4-6",
};

const VISION_RESULT: VisionJudgeResult = {
  kind: "vision",
  appId: "com.example.app1",
  store: "apple",
  market: "fr",
  culturalFitScore: 6.0,
  reasoning: "Screenshots show US food imagery, captions in English.",
  signals: {
    screenshotsLocalized: false,
    imagesCulturallyAdapted: false,
    textInLanguage: false,
    screenshotFreshness: "stale",
  },
  screenshotsAnalyzed: 3,
  confidence: 0.7,
  modelVersion: "claude-sonnet-4-6",
};

describe("JudgeResultStore", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("insertJudgeResult writes a row, returns true", () => {
    const store = cache.judgeResultStore();
    const inserted = store.insertJudgeResult({
      runId: "run-1",
      result: TEXT_RESULT,
      createdAt: 1_700_000_000_000,
    });
    expect(inserted).toBe(true);
  });

  test("UNIQUE(run_id, store, app_id, market, kind) blocks duplicates", () => {
    const store = cache.judgeResultStore();
    const first = store.insertJudgeResult({
      runId: "run-1",
      result: TEXT_RESULT,
      createdAt: 1_700_000_000_000,
    });
    const second = store.insertJudgeResult({
      runId: "run-1",
      result: TEXT_RESULT,
      createdAt: 1_700_000_001_000,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test("selectByRunId returns text + vision rows for the run", () => {
    const store = cache.judgeResultStore();
    store.insertJudgeResult({ runId: "run-1", result: TEXT_RESULT, createdAt: 1 });
    store.insertJudgeResult({ runId: "run-1", result: VISION_RESULT, createdAt: 2 });
    store.insertJudgeResult({
      runId: "run-2",
      result: { ...TEXT_RESULT, appId: "com.example.app2" },
      createdAt: 3,
    });
    const rows = store.selectByRunId("run-1");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["text", "vision"]);
    expect(rows.every((r) => r.appId === "com.example.app1")).toBe(true);
  });

  test("latestRunId returns the most recently created run, null on empty", () => {
    const store = cache.judgeResultStore();
    expect(store.latestRunId()).toBeNull();
    store.insertJudgeResult({ runId: "run-old", result: TEXT_RESULT, createdAt: 100 });
    store.insertJudgeResult({
      runId: "run-new",
      result: { ...TEXT_RESULT, appId: "com.example.app2" },
      createdAt: 200,
    });
    expect(store.latestRunId()).toBe("run-new");
  });

  test("selectByRunId malformed payload row is skipped, valid rows still returned", () => {
    const store = cache.judgeResultStore();
    store.insertJudgeResult({ runId: "run-1", result: TEXT_RESULT, createdAt: 1 });
    cache
      .rawDb()
      .exec(
        `UPDATE judge_result SET payload = 'not-json' WHERE run_id = 'run-1' AND kind = 'text'`,
      );
    const rows = store.selectByRunId("run-1");
    expect(rows).toEqual([]);
  });
});
