import { describe, expect, test } from "bun:test";
import {
  JudgeKindSchema,
  JudgeResultSchema,
  LangQualityResultSchema,
  TextJudgeResultSchema,
  VisionJudgeResultSchema,
} from "../../src/judges/schemas.ts";

describe("JudgeKindSchema", () => {
  test("accepts 'text' and 'vision'", () => {
    expect(JudgeKindSchema.parse("text")).toBe("text");
    expect(JudgeKindSchema.parse("vision")).toBe("vision");
  });

  test("rejects unknown kinds", () => {
    expect(() => JudgeKindSchema.parse("audio")).toThrow();
  });
});

const validText = {
  kind: "text" as const,
  appId: "1234567890",
  store: "apple" as const,
  market: "br",
  locGapScore: 7.5,
  reasoning: "Description English-only despite BR top chart presence.",
  signals: {
    hasNativeLanguage: false,
    hasCulturalAdaptation: false,
    hasLocalizedPaywall: false,
    hasLocalPaymentMethod: false,
  },
  confidence: 0.85,
  modelVersion: "claude-sonnet-4-6",
};

describe("TextJudgeResultSchema", () => {
  test("parses a valid text judge result", () => {
    const parsed = TextJudgeResultSchema.parse(validText);
    expect(parsed.locGapScore).toBe(7.5);
    expect(parsed.signals.hasNativeLanguage).toBe(false);
  });

  test("rejects locGapScore > 10", () => {
    expect(() => TextJudgeResultSchema.parse({ ...validText, locGapScore: 11 })).toThrow();
  });

  test("rejects locGapScore < 0", () => {
    expect(() => TextJudgeResultSchema.parse({ ...validText, locGapScore: -1 })).toThrow();
  });

  test("rejects confidence > 1", () => {
    expect(() => TextJudgeResultSchema.parse({ ...validText, confidence: 1.5 })).toThrow();
  });

  test("rejects market with wrong length (not ISO alpha-2)", () => {
    expect(() => TextJudgeResultSchema.parse({ ...validText, market: "BRA" })).toThrow();
  });

  test("rejects empty reasoning", () => {
    expect(() => TextJudgeResultSchema.parse({ ...validText, reasoning: "" })).toThrow();
  });

  test("rejects reasoning longer than 600 chars (prompt-injection cap)", () => {
    expect(() =>
      TextJudgeResultSchema.parse({ ...validText, reasoning: "x".repeat(601) }),
    ).toThrow();
  });

  test("rejects wrong kind discriminant", () => {
    expect(() => TextJudgeResultSchema.parse({ ...validText, kind: "vision" })).toThrow();
  });
});

const validVision = {
  kind: "vision" as const,
  appId: "1234567890",
  store: "apple" as const,
  market: "jp",
  culturalFitScore: 4.0,
  reasoning: "Screenshots show US food imagery in JP listing.",
  signals: {
    screenshotsLocalized: false,
    imagesCulturallyAdapted: false,
    textInLanguage: true,
    screenshotFreshness: "stale" as const,
  },
  screenshotsAnalyzed: 5,
  confidence: 0.7,
  modelVersion: "claude-sonnet-4-6",
};

describe("VisionJudgeResultSchema", () => {
  test("parses a valid vision judge result", () => {
    const parsed = VisionJudgeResultSchema.parse(validVision);
    expect(parsed.culturalFitScore).toBe(4.0);
    expect(parsed.signals.screenshotFreshness).toBe("stale");
  });

  test("accepts screenshotFreshness 'fresh' | 'stale' | 'unknown'", () => {
    for (const f of ["fresh", "stale", "unknown"] as const) {
      const out = VisionJudgeResultSchema.parse({
        ...validVision,
        signals: { ...validVision.signals, screenshotFreshness: f },
      });
      expect(out.signals.screenshotFreshness).toBe(f);
    }
  });

  test("rejects screenshotsAnalyzed = 0 (must be >= 1)", () => {
    expect(() =>
      VisionJudgeResultSchema.parse({ ...validVision, screenshotsAnalyzed: 0 }),
    ).toThrow();
  });

  test("rejects culturalFitScore > 10", () => {
    expect(() => VisionJudgeResultSchema.parse({ ...validVision, culturalFitScore: 12 })).toThrow();
  });
});

describe("JudgeResultSchema (discriminated union)", () => {
  test("discriminates between text and vision by kind", () => {
    const t = JudgeResultSchema.parse(validText);
    expect(t.kind).toBe("text");
    const v = JudgeResultSchema.parse(validVision);
    expect(v.kind).toBe("vision");
  });

  test("rejects object missing kind discriminator", () => {
    const { kind: _unused, ...rest } = validText;
    expect(() => JudgeResultSchema.parse(rest)).toThrow();
  });
});

describe("LangQualityResultSchema", () => {
  const validLang = {
    language: "pt-BR",
    market: "br",
    sampleSize: 50,
    backTranslationAccuracy: 0.91,
    semanticEquivalenceScore: 8.4,
    passes: true,
    perPhraseResults: [
      {
        original: "Unlock premium",
        translated: "Desbloquear premium",
        backTranslated: "Unlock premium",
        equivalenceScore: 9.5,
      },
    ],
    modelVersion: "claude-sonnet-4-6",
  };

  test("parses a valid lang quality result", () => {
    const parsed = LangQualityResultSchema.parse(validLang);
    expect(parsed.passes).toBe(true);
    expect(parsed.semanticEquivalenceScore).toBeCloseTo(8.4);
  });

  test("rejects accuracy > 1", () => {
    expect(() =>
      LangQualityResultSchema.parse({
        ...validLang,
        backTranslationAccuracy: 1.5,
      }),
    ).toThrow();
  });

  test("rejects passes=true when semanticEquivalenceScore < 8.0", () => {
    // refine should enforce: passes must equal (score >= 8.0)
    expect(() =>
      LangQualityResultSchema.parse({
        ...validLang,
        semanticEquivalenceScore: 6.0,
        passes: true,
      }),
    ).toThrow();
  });

  test("rejects passes=false when semanticEquivalenceScore >= 8.0", () => {
    expect(() =>
      LangQualityResultSchema.parse({
        ...validLang,
        semanticEquivalenceScore: 9.0,
        passes: false,
      }),
    ).toThrow();
  });

  test("language can be ISO 639-1 ('en') or BCP-47 ('pt-BR')", () => {
    expect(LangQualityResultSchema.parse({ ...validLang, language: "en" }).language).toBe("en");
    expect(LangQualityResultSchema.parse({ ...validLang, language: "ja" }).language).toBe("ja");
  });
});
