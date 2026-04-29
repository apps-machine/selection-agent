import { z } from "zod";
import { type Result, err, ok } from "../util/result.ts";
import {
  type RetryOptions,
  isFatalHttpError,
  isTransientHttpError,
  retryWithBackoff,
} from "../util/retry.ts";
import {
  LANG_QUALITY_PASS_THRESHOLD,
  LangQualityResultSchema,
  type LangQualityResult,
} from "./schemas.ts";

export const DEFAULT_LANG_QUALITY_MODEL = "claude-sonnet-4-6";
const TOOL_TRANSLATE = "translate_phrases";
const TOOL_BACK_TRANSLATE = "back_translate_phrases";
const TOOL_SCORE = "score_equivalence_batch";

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
type ContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface MessageCreateParams {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user"; content: string }>;
  tools: AnthropicTool[];
  tool_choice: { type: "tool"; name: string };
}

export interface LangQualityClient {
  messages: {
    create(params: MessageCreateParams): Promise<AnthropicMessage>;
  };
}

export interface TokenUsage {
  input: number;
  output: number;
  model: string;
}

export interface EvaluateLanguageQualityOptions {
  language: string;
  market: string;
  phrases: readonly string[];
  client: LangQualityClient;
  model?: string;
  retry?: RetryOptions;
  onTokenUsage?: (usage: TokenUsage) => void;
}

const TranslationsResponse = z.object({
  translations: z.array(z.string().min(1)),
});
const BackTranslationsResponse = z.object({
  backTranslations: z.array(z.string().min(1)),
});
const ScoresResponse = z.object({
  scores: z.array(
    z.object({
      score: z.number().min(0).max(10),
      note: z.string().default(""),
    }),
  ),
});

const TRANSLATE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    translations: { type: "array", items: { type: "string" } },
  },
  required: ["translations"],
} as const;

const BACK_TRANSLATE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    backTranslations: { type: "array", items: { type: "string" } },
  },
  required: ["backTranslations"],
} as const;

const SCORE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          score: { type: "number", minimum: 0, maximum: 10 },
          note: { type: "string" },
        },
        required: ["score"],
      },
    },
  },
  required: ["scores"],
} as const;

function findToolUse(msg: AnthropicMessage, name: string): unknown | null {
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === name) {
      return block.input;
    }
  }
  return null;
}

async function callTool(
  opts: EvaluateLanguageQualityOptions,
  prompt: string,
  toolName: string,
  toolDescription: string,
  toolSchema: Record<string, unknown>,
): Promise<AnthropicMessage> {
  const params: MessageCreateParams = {
    model: opts.model ?? DEFAULT_LANG_QUALITY_MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
    tools: [
      { name: toolName, description: toolDescription, input_schema: toolSchema },
    ],
    tool_choice: { type: "tool", name: toolName },
  };
  return retryWithBackoff(() => opts.client.messages.create(params), {
    initialDelayMs: 1000,
    maxDelayMs: 8000,
    jitter: true,
    maxAttempts: 3,
    ...opts.retry,
    shouldRetry: (e, attempt) => {
      if (isFatalHttpError(e)) return false;
      if (opts.retry?.shouldRetry) return opts.retry.shouldRetry(e, attempt);
      return isTransientHttpError(e);
    },
  });
}

export async function evaluateLanguageQuality(
  opts: EvaluateLanguageQualityOptions,
): Promise<Result<LangQualityResult, Error>> {
  if (opts.phrases.length === 0) {
    return err(new Error("lang-quality-eval: phrases is empty"));
  }
  // TODO(M6): the 3 calls below run serially; partial failure (step 2/3 fails
  // after step 1 cost) is not rolled back. Caller threads CostBudget via
  // onTokenUsage = budget.recordAndAssert so spend is bounded by the cap, but
  // the wasted-step problem itself is structural and would need a checkpoint.
  const model = opts.model ?? DEFAULT_LANG_QUALITY_MODEL;
  const numbered = opts.phrases.map((p, i) => `${i + 1}. ${p}`).join("\n");

  // Step 1: forward translate EN → target
  let resp1: AnthropicMessage;
  try {
    resp1 = await callTool(
      opts,
      `Translate these English phrases into ${opts.language} (target market: ${opts.market}).\nPreserve register, punctuation, and tone. Use the typical vocabulary a real mobile-app paywall or onboarding screen would use in this market.\n\n${numbered}\n\nReturn an array with one translation per input, in order.`,
      TOOL_TRANSLATE,
      "Emit the array of translations.",
      TRANSLATE_TOOL_SCHEMA,
    );
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
  opts.onTokenUsage?.({
    input: resp1.usage.input_tokens,
    output: resp1.usage.output_tokens,
    model,
  });
  const t1 = findToolUse(resp1, TOOL_TRANSLATE);
  if (t1 === null) return err(new Error("lang-quality: no translate tool_use"));
  const translations = TranslationsResponse.safeParse(t1);
  if (!translations.success) {
    return err(
      new Error(`lang-quality: translations invalid: ${translations.error.message}`),
    );
  }
  if (translations.data.translations.length !== opts.phrases.length) {
    return err(
      new Error(
        `lang-quality: translation count mismatch (got ${translations.data.translations.length}, want ${opts.phrases.length})`,
      ),
    );
  }

  // Step 2: back-translate target → EN
  const numberedTranslations = translations.data.translations
    .map((p, i) => `${i + 1}. ${p}`)
    .join("\n");
  let resp2: AnthropicMessage;
  try {
    resp2 = await callTool(
      opts,
      `Back-translate these ${opts.language} phrases into English. Be literal, preserve meaning over fluency.\n\n${numberedTranslations}\n\nReturn an array with one back-translation per input, in order.`,
      TOOL_BACK_TRANSLATE,
      "Emit the array of literal back-translations.",
      BACK_TRANSLATE_TOOL_SCHEMA,
    );
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
  opts.onTokenUsage?.({
    input: resp2.usage.input_tokens,
    output: resp2.usage.output_tokens,
    model,
  });
  const t2 = findToolUse(resp2, TOOL_BACK_TRANSLATE);
  if (t2 === null) {
    return err(new Error("lang-quality: no back_translate tool_use"));
  }
  const backs = BackTranslationsResponse.safeParse(t2);
  if (!backs.success) {
    return err(
      new Error(`lang-quality: back-translations invalid: ${backs.error.message}`),
    );
  }
  if (backs.data.backTranslations.length !== opts.phrases.length) {
    return err(
      new Error(
        `lang-quality: back-translation count mismatch (got ${backs.data.backTranslations.length}, want ${opts.phrases.length})`,
      ),
    );
  }

  // Step 3: score equivalence (original EN vs back-translated EN)
  const pairs = opts.phrases
    .map(
      (p, i) =>
        `${i + 1}. ORIGINAL: ${p}\n   BACK-TRANSLATED: ${backs.data.backTranslations[i]}`,
    )
    .join("\n");
  let resp3: AnthropicMessage;
  try {
    resp3 = await callTool(
      opts,
      `Score the semantic equivalence of each ORIGINAL/BACK-TRANSLATED pair on a 0-10 scale.\n10 = identical meaning, exact tone. 8 = same meaning with minor wording differences. 5 = related but drifted. 0 = unrelated.\n\n${pairs}\n\nReturn an array of {score, note} objects, one per pair, in order.`,
      TOOL_SCORE,
      "Emit a per-pair semantic equivalence score (0-10) with a short note.",
      SCORE_TOOL_SCHEMA,
    );
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
  opts.onTokenUsage?.({
    input: resp3.usage.input_tokens,
    output: resp3.usage.output_tokens,
    model,
  });
  const t3 = findToolUse(resp3, TOOL_SCORE);
  if (t3 === null) return err(new Error("lang-quality: no score tool_use"));
  const scoresParsed = ScoresResponse.safeParse(t3);
  if (!scoresParsed.success) {
    return err(
      new Error(`lang-quality: scores invalid: ${scoresParsed.error.message}`),
    );
  }
  if (scoresParsed.data.scores.length !== opts.phrases.length) {
    return err(
      new Error(
        `lang-quality: score count mismatch (got ${scoresParsed.data.scores.length}, want ${opts.phrases.length})`,
      ),
    );
  }

  const perPhraseResults = opts.phrases.map((original, i) => ({
    original,
    translated: translations.data.translations[i] ?? "",
    backTranslated: backs.data.backTranslations[i] ?? "",
    equivalenceScore: scoresParsed.data.scores[i]?.score ?? 0,
  }));
  const meanScore =
    perPhraseResults.reduce((sum, r) => sum + r.equivalenceScore, 0) /
    perPhraseResults.length;
  const passes = meanScore >= LANG_QUALITY_PASS_THRESHOLD;

  const candidate = {
    language: opts.language,
    market: opts.market,
    sampleSize: opts.phrases.length,
    backTranslationAccuracy: meanScore / 10,
    semanticEquivalenceScore: meanScore,
    passes,
    perPhraseResults,
    modelVersion: model,
  };
  const parsed = LangQualityResultSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(
      new Error(
        `lang-quality: result schema invalid: ${parsed.error.message}`,
      ),
    );
  }
  return ok(parsed.data);
}
