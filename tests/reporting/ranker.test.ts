import { describe, expect, test } from "bun:test";
import type { TextJudgeResult, VisionJudgeResult } from "../../src/judges/schemas.ts";
import type { ScoredCandidate } from "../../src/orchestrator/types.ts";
import { rank } from "../../src/reporting/ranker.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";

function makeApp(overrides: Partial<RawAppData> & Pick<RawAppData, "appId">): RawAppData {
  return {
    store: "apple",
    trackId: null,
    market: "us",
    name: overrides.appId,
    developer: "Dev",
    category: "Productivity",
    rank: null,
    rating: 4.5,
    ratingsCount: 1000,
    priceUsd: 0,
    iapPresent: true,
    description: "x",
    screenshotUrls: [],
    iconUrl: null,
    releaseDate: null,
    lastUpdated: null,
    scrapedAt: "2026-04-29T00:00:00.000Z",
    ...overrides,
  };
}

function textJudge(confidence: number): TextJudgeResult {
  return {
    kind: "text",
    appId: "x",
    store: "apple",
    market: "us",
    locGapScore: 5,
    reasoning: "x",
    signals: {
      hasNativeLanguage: true,
      hasCulturalAdaptation: true,
      hasLocalizedPaywall: true,
      hasLocalPaymentMethod: true,
    },
    confidence,
    modelVersion: "claude-sonnet-4-6",
  };
}

function visionJudge(confidence: number): VisionJudgeResult {
  return {
    kind: "vision",
    appId: "x",
    store: "apple",
    market: "us",
    culturalFitScore: 5,
    reasoning: "x",
    signals: {
      screenshotsLocalized: true,
      imagesCulturallyAdapted: true,
      textInLanguage: true,
      screenshotFreshness: "fresh",
    },
    screenshotsAnalyzed: 3,
    confidence,
    modelVersion: "claude-sonnet-4-6",
  };
}

function candidate(args: {
  appId: string;
  composite: number;
  textConf?: number;
  visionConf?: number;
  ratingsCount?: number;
  store?: "apple" | "google";
  market?: string;
}): ScoredCandidate {
  return {
    app: makeApp({
      appId: args.appId,
      ratingsCount: args.ratingsCount ?? 1000,
      store: args.store ?? "apple",
      market: args.market ?? "us",
    }),
    composite: {
      composite: args.composite,
      breakdown: { locGap: 0, revenue: 0, paywall: 0, velocity: null },
      weights: { locGap: 0.4, revenue: 0.4, paywall: 0.2, velocity: 0 },
    },
    textJudge: args.textConf === undefined ? null : textJudge(args.textConf),
    visionJudge: args.visionConf === undefined ? null : visionJudge(args.visionConf),
    enrichmentSource: "enriched",
  };
}

describe("rank()", () => {
  test("primary sort: composite descending", () => {
    const out = rank(
      [
        candidate({ appId: "a", composite: 5 }),
        candidate({ appId: "b", composite: 9 }),
        candidate({ appId: "c", composite: 7 }),
      ],
      10,
    );
    expect(out.map((c) => c.app.appId)).toEqual(["b", "c", "a"]);
    expect(out.map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  test("tie-break 1: judgeConfidence (mean of text+vision when present)", () => {
    const out = rank(
      [
        candidate({ appId: "low", composite: 8, textConf: 0.5, visionConf: 0.5 }),
        candidate({ appId: "high", composite: 8, textConf: 0.9, visionConf: 0.9 }),
      ],
      10,
    );
    expect(out.map((c) => c.app.appId)).toEqual(["high", "low"]);
  });

  test("tie-break 1: text-only confidence used when no vision judge", () => {
    const out = rank(
      [
        candidate({ appId: "low", composite: 8, textConf: 0.5 }),
        candidate({ appId: "high", composite: 8, textConf: 0.9 }),
      ],
      10,
    );
    expect(out.map((c) => c.app.appId)).toEqual(["high", "low"]);
  });

  test("tie-break 1: missing judges treated as confidence 0", () => {
    const out = rank(
      [
        candidate({ appId: "withJudge", composite: 8, textConf: 0.1 }),
        candidate({ appId: "noJudge", composite: 8 }),
      ],
      10,
    );
    expect(out.map((c) => c.app.appId)).toEqual(["withJudge", "noJudge"]);
  });

  test("tie-break 2: ratingsCount descending when composite + confidence tied", () => {
    const out = rank(
      [
        candidate({ appId: "small", composite: 8, textConf: 0.8, ratingsCount: 100 }),
        candidate({ appId: "big", composite: 8, textConf: 0.8, ratingsCount: 50_000 }),
      ],
      10,
    );
    expect(out.map((c) => c.app.appId)).toEqual(["big", "small"]);
  });

  test("tie-break 3: deterministic (store, appId, market) lexical", () => {
    const out = rank(
      [
        candidate({ appId: "z", composite: 8, store: "google" }),
        candidate({ appId: "a", composite: 8, store: "apple" }),
        candidate({ appId: "a", composite: 8, store: "google" }),
      ],
      10,
    );
    expect(out.map((c) => `${c.app.store}:${c.app.appId}`)).toEqual([
      "apple:a",
      "google:a",
      "google:z",
    ]);
  });

  test("topN truncation", () => {
    const cs = ["a", "b", "c", "d", "e"].map((id, i) =>
      candidate({ appId: id, composite: 10 - i }),
    );
    const out = rank(cs, 3);
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.app.appId)).toEqual(["a", "b", "c"]);
  });

  test("empty input returns empty array", () => {
    expect(rank([], 10)).toEqual([]);
  });

  test("idempotent on shuffled input (deterministic)", () => {
    const cs = [
      candidate({ appId: "a", composite: 7, textConf: 0.6 }),
      candidate({ appId: "b", composite: 9, textConf: 0.6 }),
      candidate({ appId: "c", composite: 7, textConf: 0.8 }),
      candidate({ appId: "d", composite: 9, textConf: 0.4 }),
    ];
    const r1 = rank(cs, 10).map((c) => c.app.appId);
    const r2 = rank([...cs].reverse(), 10).map((c) => c.app.appId);
    expect(r1).toEqual(r2);
  });
});
