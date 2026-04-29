import { z } from "zod";
import { StoreSchema } from "../types/raw-app-data.ts";

export const JudgeKindSchema = z.enum(["text", "vision"]);
export type JudgeKind = z.infer<typeof JudgeKindSchema>;

const Score10 = z.number().min(0).max(10);
const Confidence = z.number().min(0).max(1);
const MarketCode = z.string().length(2).describe("ISO 3166-1 alpha-2 country code, lowercase");
// Reasoning is free-form model output rendered downstream in reports/dashboards.
// Capping at 600 chars contains prompt-injection-style payloads from app
// descriptions that try to seed authoritative-sounding text for human readers.
const Reasoning = z.string().min(1).max(600);

export const TextSignalsSchema = z.object({
  hasNativeLanguage: z.boolean(),
  hasCulturalAdaptation: z.boolean(),
  hasLocalizedPaywall: z.boolean(),
  hasLocalPaymentMethod: z.boolean(),
});
export type TextSignals = z.infer<typeof TextSignalsSchema>;

export const TextJudgeResultSchema = z.object({
  kind: z.literal("text"),
  appId: z.string().min(1),
  store: StoreSchema,
  market: MarketCode,
  locGapScore: Score10,
  reasoning: Reasoning,
  signals: TextSignalsSchema,
  confidence: Confidence,
  modelVersion: z.string().min(1),
});
export type TextJudgeResult = z.infer<typeof TextJudgeResultSchema>;

export const ScreenshotFreshnessSchema = z.enum(["fresh", "stale", "unknown"]);
export type ScreenshotFreshness = z.infer<typeof ScreenshotFreshnessSchema>;

export const VisionSignalsSchema = z.object({
  screenshotsLocalized: z.boolean(),
  imagesCulturallyAdapted: z.boolean(),
  textInLanguage: z.boolean(),
  screenshotFreshness: ScreenshotFreshnessSchema,
});
export type VisionSignals = z.infer<typeof VisionSignalsSchema>;

export const VisionJudgeResultSchema = z.object({
  kind: z.literal("vision"),
  appId: z.string().min(1),
  store: StoreSchema,
  market: MarketCode,
  culturalFitScore: Score10,
  reasoning: Reasoning,
  signals: VisionSignalsSchema,
  screenshotsAnalyzed: z.number().int().min(1),
  confidence: Confidence,
  modelVersion: z.string().min(1),
});
export type VisionJudgeResult = z.infer<typeof VisionJudgeResultSchema>;

export const JudgeResultSchema = z.discriminatedUnion("kind", [
  TextJudgeResultSchema,
  VisionJudgeResultSchema,
]);
export type JudgeResult = z.infer<typeof JudgeResultSchema>;

export const LANG_QUALITY_PASS_THRESHOLD = 8.0;

export const LangPhraseEvalSchema = z.object({
  original: z.string().min(1),
  translated: z.string().min(1),
  backTranslated: z.string().min(1),
  equivalenceScore: Score10,
});
export type LangPhraseEval = z.infer<typeof LangPhraseEvalSchema>;

export const LangQualityResultSchema = z
  .object({
    language: z.string().min(2).max(10),
    market: MarketCode,
    sampleSize: z.number().int().min(1),
    backTranslationAccuracy: z.number().min(0).max(1),
    semanticEquivalenceScore: Score10,
    passes: z.boolean(),
    perPhraseResults: z.array(LangPhraseEvalSchema),
    modelVersion: z.string().min(1),
  })
  .refine((r) => r.passes === r.semanticEquivalenceScore >= LANG_QUALITY_PASS_THRESHOLD, {
    message: `passes must equal (semanticEquivalenceScore >= ${LANG_QUALITY_PASS_THRESHOLD})`,
    path: ["passes"],
  });
export type LangQualityResult = z.infer<typeof LangQualityResultSchema>;
