import { type Result, err, ok } from "../util/result.ts";
import {
  type RetryOptions,
  isFatalHttpError,
  isTransientHttpError,
  retryWithBackoff,
} from "../util/retry.ts";
import type { RawAppData } from "../types/raw-app-data.ts";
import { TextJudgeResultSchema, type TextJudgeResult } from "./schemas.ts";

export const DEFAULT_TEXT_JUDGE_MODEL = "claude-sonnet-4-6";
const TOOL_NAME = "score_localization_gap";

const REASONING_MAX_CHARS = 600;

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
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicMessageCreateParams {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user"; content: string }>;
  tools: AnthropicTool[];
  tool_choice: { type: "tool"; name: string };
}

export interface JudgeClient {
  messages: {
    create(params: AnthropicMessageCreateParams): Promise<AnthropicMessage>;
  };
}

export interface TokenUsage {
  input: number;
  output: number;
  model: string;
}

export interface JudgeAppTextOptions {
  app: RawAppData;
  client: JudgeClient;
  model?: string;
  retry?: RetryOptions;
  onTokenUsage?: (usage: TokenUsage) => void;
}

const TEXT_JUDGE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    locGapScore: {
      type: "number",
      minimum: 0,
      maximum: 10,
      description:
        "Localization gap score: 0=fully localized for this market, 10=catastrophically not localized.",
    },
    reasoning: {
      type: "string",
      minLength: 1,
      maxLength: REASONING_MAX_CHARS,
      description: "1-3 sentence justification grounded in observable signals.",
    },
    signals: {
      type: "object",
      properties: {
        hasNativeLanguage: { type: "boolean" },
        hasCulturalAdaptation: { type: "boolean" },
        hasLocalizedPaywall: { type: "boolean" },
        hasLocalPaymentMethod: { type: "boolean" },
      },
      required: [
        "hasNativeLanguage",
        "hasCulturalAdaptation",
        "hasLocalizedPaywall",
        "hasLocalPaymentMethod",
      ],
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "0-1 confidence in the score given the metadata available.",
    },
  },
  required: ["locGapScore", "reasoning", "signals", "confidence"],
} as const;

function buildPrompt(app: RawAppData): string {
  return [
    `You are a localization gap auditor for mobile apps.`,
    `Score how well the app on the **${app.store}** store is localized for market **${app.market}** (ISO alpha-2).`,
    ``,
    `App metadata:`,
    `- Name: ${app.name}`,
    `- Developer: ${app.developer}`,
    `- Category: ${app.category}`,
    `- Market: ${app.market}`,
    `- Rating: ${app.rating ?? "n/a"} (${app.ratingsCount ?? "n/a"} ratings)`,
    `- Rank in market: ${app.rank ?? "n/a"}`,
    `- IAP present: ${app.iapPresent}`,
    `- Description (first 1500 chars):`,
    app.description.slice(0, 1500),
    ``,
    `Return ONLY the tool call. Score 0 = fully localized, 10 = English-only and unlocalized in a non-English market.`,
    `If the market language is English (us, gb, au, ca, ie, nz), gap is naturally low and confidence reflects the trivial case.`,
  ].join("\n");
}

function extractToolUse(msg: AnthropicMessage): unknown | null {
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === TOOL_NAME) {
      return block.input;
    }
  }
  return null;
}

export async function judgeAppText(
  opts: JudgeAppTextOptions,
): Promise<Result<TextJudgeResult, Error>> {
  const model = opts.model ?? DEFAULT_TEXT_JUDGE_MODEL;
  const prompt = buildPrompt(opts.app);

  const params: AnthropicMessageCreateParams = {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
    tools: [
      {
        name: TOOL_NAME,
        description:
          "Emit the localization gap score and reasoning for the given app+market.",
        input_schema: TEXT_JUDGE_TOOL_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
  };

  let response: AnthropicMessage;
  try {
    response = await retryWithBackoff(() => opts.client.messages.create(params), {
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
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  opts.onTokenUsage?.({
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    model,
  });

  const toolInput = extractToolUse(response);
  if (toolInput === null) {
    return err(new Error("text-judge: response contained no tool_use block"));
  }

  const candidate = {
    kind: "text" as const,
    appId: opts.app.appId,
    store: opts.app.store,
    market: opts.app.market,
    modelVersion: model,
    ...(toolInput as Record<string, unknown>),
  };

  const parsed = TextJudgeResultSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(
      new Error(
        `text-judge: tool input failed schema validation: ${parsed.error.message}`,
      ),
    );
  }
  return ok(parsed.data);
}
