import { describe, expect, test } from "bun:test";
import type { JudgeResult, TextJudgeResult, VisionJudgeResult } from "../../src/judges/schemas.ts";
import {
  compareJudges,
  renderJudgeDivergenceMarkdown,
} from "../../src/reporting/compare-judges.ts";

function tjr(
  over: Partial<TextJudgeResult> & { appId: string; locGapScore: number },
): TextJudgeResult {
  return {
    kind: "text",
    store: "apple",
    market: "us",
    reasoning: `text reasoning for ${over.appId}`,
    signals: {
      hasNativeLanguage: true,
      hasCulturalAdaptation: true,
      hasLocalizedPaywall: true,
      hasLocalPaymentMethod: true,
    },
    confidence: 0.7,
    modelVersion: "claude-sonnet-4-6",
    ...over,
  };
}

function vjr(
  over: Partial<VisionJudgeResult> & { appId: string; culturalFitScore: number },
): VisionJudgeResult {
  return {
    kind: "vision",
    store: "apple",
    market: "us",
    reasoning: `vision reasoning for ${over.appId}`,
    signals: {
      screenshotsLocalized: true,
      imagesCulturallyAdapted: true,
      textInLanguage: true,
      screenshotFreshness: "fresh",
    },
    screenshotsAnalyzed: 3,
    confidence: 0.7,
    modelVersion: "claude-sonnet-4-6",
    ...over,
  };
}

describe("compareJudges()", () => {
  test("pairs text + vision results with the same (store, appId, market)", () => {
    const results: JudgeResult[] = [
      tjr({ appId: "a", locGapScore: 9 }),
      vjr({ appId: "a", culturalFitScore: 4 }),
      tjr({ appId: "b", locGapScore: 5 }),
      vjr({ appId: "b", culturalFitScore: 5 }),
    ];
    const report = compareJudges(results);
    expect(report.pairs).toHaveLength(2);
    const a = report.pairs.find((p) => p.appId === "a");
    expect(a?.divergence).toBe(5);
    const b = report.pairs.find((p) => p.appId === "b");
    expect(b?.divergence).toBe(0);
  });

  test("orders pairs by divergence descending", () => {
    const results: JudgeResult[] = [
      tjr({ appId: "small", locGapScore: 5 }),
      vjr({ appId: "small", culturalFitScore: 5 }),
      tjr({ appId: "big", locGapScore: 9 }),
      vjr({ appId: "big", culturalFitScore: 1 }),
      tjr({ appId: "mid", locGapScore: 7 }),
      vjr({ appId: "mid", culturalFitScore: 3 }),
    ];
    const report = compareJudges(results);
    expect(report.pairs.map((p) => p.appId)).toEqual(["big", "mid", "small"]);
    expect(report.pairs[0]?.divergence).toBe(8);
  });

  test("text-only or vision-only results are unpaired (excluded from pairs)", () => {
    const results: JudgeResult[] = [
      tjr({ appId: "lonely-text", locGapScore: 9 }),
      vjr({ appId: "lonely-vision", culturalFitScore: 3 }),
      tjr({ appId: "matched", locGapScore: 7 }),
      vjr({ appId: "matched", culturalFitScore: 2 }),
    ];
    const report = compareJudges(results);
    expect(report.pairs).toHaveLength(1);
    expect(report.pairs[0]?.appId).toBe("matched");
    expect(report.unpairedTextCount).toBe(1);
    expect(report.unpairedVisionCount).toBe(1);
  });

  test("empty input returns empty report", () => {
    const report = compareJudges([]);
    expect(report).toEqual({
      pairs: [],
      unpairedTextCount: 0,
      unpairedVisionCount: 0,
    });
  });
});

describe("renderJudgeDivergenceMarkdown()", () => {
  test("renders a table header and one row per pair", () => {
    const md = renderJudgeDivergenceMarkdown(
      compareJudges([
        tjr({ appId: "big", locGapScore: 9 }),
        vjr({ appId: "big", culturalFitScore: 1 }),
        tjr({ appId: "small", locGapScore: 5 }),
        vjr({ appId: "small", culturalFitScore: 5 }),
      ]),
    );
    expect(md).toContain("# Judge divergence report");
    expect(md).toContain("| App | Store | Market | Loc gap | Cultural fit | Δ |");
    expect(md).toContain("| big | apple | us | 9.0 | 1.0 | 8.0 |");
    expect(md).toContain("| small | apple | us | 5.0 | 5.0 | 0.0 |");
    expect(md).toContain("text reasoning for big");
    expect(md).toContain("vision reasoning for big");
  });

  test("empty report renders a friendly note instead of an empty table", () => {
    const md = renderJudgeDivergenceMarkdown(compareJudges([]));
    expect(md).toContain("# Judge divergence report");
    expect(md).toContain("_No paired text+vision judge results to compare._");
  });
});
