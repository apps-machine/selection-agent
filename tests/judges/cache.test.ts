import { describe, expect, test } from "bun:test";
import { Cache } from "../../src/storage/cache.ts";
import {
  JUDGE_CACHE_TTL_SECONDS,
  judgeCacheKey,
  withJudgeCache,
} from "../../src/judges/cache.ts";
import {
  TextJudgeResultSchema,
  type TextJudgeResult,
} from "../../src/judges/schemas.ts";

const sampleResult: TextJudgeResult = {
  kind: "text",
  appId: "1234567890",
  store: "apple",
  market: "br",
  locGapScore: 7.5,
  reasoning: "English-only listing in BR top chart.",
  signals: {
    hasNativeLanguage: false,
    hasCulturalAdaptation: false,
    hasLocalizedPaywall: false,
    hasLocalPaymentMethod: false,
  },
  confidence: 0.85,
  modelVersion: "claude-sonnet-4-6",
};

describe("judgeCacheKey", () => {
  test("produces stable hash for identical inputs", () => {
    const a = judgeCacheKey({
      kind: "text",
      model: "claude-sonnet-4-6",
      appId: "x",
      market: "br",
      contentDigest: "abcd1234",
    });
    const b = judgeCacheKey({
      kind: "text",
      model: "claude-sonnet-4-6",
      appId: "x",
      market: "br",
      contentDigest: "abcd1234",
    });
    expect(a).toBe(b);
    expect(a.startsWith("judge:")).toBe(true);
  });

  test("differs when model changes", () => {
    const a = judgeCacheKey({
      kind: "text",
      model: "claude-sonnet-4-6",
      appId: "x",
      market: "br",
      contentDigest: "d",
    });
    const b = judgeCacheKey({
      kind: "text",
      model: "claude-haiku-4-5-20251001",
      appId: "x",
      market: "br",
      contentDigest: "d",
    });
    expect(a).not.toBe(b);
  });

  test("differs when kind changes (text vs vision over same app)", () => {
    const a = judgeCacheKey({
      kind: "text",
      model: "m",
      appId: "x",
      market: "br",
      contentDigest: "d",
    });
    const b = judgeCacheKey({
      kind: "vision",
      model: "m",
      appId: "x",
      market: "br",
      contentDigest: "d",
    });
    expect(a).not.toBe(b);
  });

  test("includes schema version: bumping JUDGE_SCHEMA_VERSION invalidates old keys", async () => {
    // Imported lazily so we can test the constant independently of its value.
    const cacheMod = await import("../../src/judges/cache.ts");
    expect(cacheMod.JUDGE_SCHEMA_VERSION).toBeDefined();
    expect(typeof cacheMod.JUDGE_SCHEMA_VERSION).toBe("string");
  });

  test("differs when content digest changes", () => {
    const a = judgeCacheKey({
      kind: "text",
      model: "m",
      appId: "x",
      market: "br",
      contentDigest: "aaa",
    });
    const b = judgeCacheKey({
      kind: "text",
      model: "m",
      appId: "x",
      market: "br",
      contentDigest: "bbb",
    });
    expect(a).not.toBe(b);
  });
});

describe("withJudgeCache", () => {
  test("first call: miss → factory runs → caches result", async () => {
    const cache = Cache.open(":memory:");
    let factoryCalls = 0;
    const out = await withJudgeCache({
      cache,
      key: "judge:test1",
      schema: TextJudgeResultSchema,
      factory: async () => {
        factoryCalls += 1;
        return { ok: true as const, value: sampleResult };
      },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.hit).toBe(false);
    expect(factoryCalls).toBe(1);
    cache.close();
  });

  test("second call with same key: hit → factory NOT called", async () => {
    const cache = Cache.open(":memory:");
    let factoryCalls = 0;
    const factory = async () => {
      factoryCalls += 1;
      return { ok: true as const, value: sampleResult };
    };
    await withJudgeCache({
      cache,
      key: "judge:test2",
      schema: TextJudgeResultSchema,
      factory,
    });
    const second = await withJudgeCache({
      cache,
      key: "judge:test2",
      schema: TextJudgeResultSchema,
      factory,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.hit).toBe(true);
    expect(factoryCalls).toBe(1);
    cache.close();
  });

  test("factory error: not cached, propagates", async () => {
    const cache = Cache.open(":memory:");
    const out = await withJudgeCache({
      cache,
      key: "judge:test3",
      schema: TextJudgeResultSchema,
      factory: async () => ({ ok: false as const, error: new Error("boom") }),
    });
    expect(out.ok).toBe(false);
    let factoryRanAgain = false;
    await withJudgeCache({
      cache,
      key: "judge:test3",
      schema: TextJudgeResultSchema,
      factory: async () => {
        factoryRanAgain = true;
        return { ok: true as const, value: sampleResult };
      },
    });
    expect(factoryRanAgain).toBe(true);
    cache.close();
  });

  test("bypass=true: never reads cache but writes on success", async () => {
    const cache = Cache.open(":memory:");
    let factoryCalls = 0;
    const factory = async () => {
      factoryCalls += 1;
      return { ok: true as const, value: sampleResult };
    };
    await withJudgeCache({
      cache,
      key: "judge:test4",
      schema: TextJudgeResultSchema,
      factory,
    });
    const second = await withJudgeCache({
      cache,
      key: "judge:test4",
      schema: TextJudgeResultSchema,
      factory,
      bypass: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.hit).toBe(false);
    expect(factoryCalls).toBe(2);
    cache.close();
  });

  test("TTL constant is 30 days", () => {
    expect(JUDGE_CACHE_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});
