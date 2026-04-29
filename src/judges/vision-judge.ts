import type { RawAppData } from "../types/raw-app-data.ts";
import { err, ok, type Result } from "../util/result.ts";
import {
  isFatalHttpError,
  isTransientHttpError,
  type RetryOptions,
  retryWithBackoff,
} from "../util/retry.ts";
import { type VisionJudgeResult, VisionJudgeResultSchema } from "./schemas.ts";

export const DEFAULT_VISION_JUDGE_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_SCREENSHOTS = 5;
export const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT = 2;
const TOOL_NAME = "score_cultural_fit";

const REASONING_MAX_CHARS = 600;

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock;
type UserContentBlock = AnthropicTextBlock | AnthropicImageBlock;

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
  messages: Array<{ role: "user"; content: UserContentBlock[] }>;
  tools: AnthropicTool[];
  tool_choice: { type: "tool"; name: string };
}

export interface VisionJudgeClient {
  messages: {
    create(params: AnthropicMessageCreateParams): Promise<AnthropicMessage>;
  };
}

export interface ImageFetchOptions {
  signal?: AbortSignal;
}

export type ImageFetcher = (
  url: string,
  opts?: ImageFetchOptions,
) => Promise<{ mediaType: string; base64: string }>;

export interface TokenUsage {
  input: number;
  output: number;
  model: string;
}

export interface JudgeAppVisionOptions {
  app: RawAppData;
  client: VisionJudgeClient;
  fetchImage: ImageFetcher;
  model?: string;
  maxScreenshots?: number;
  /** Per-image fetch timeout. Default 10s — refuses to hang on a slow CDN. */
  imageFetchTimeoutMs?: number;
  /** Per-image base64 size cap to prevent cost runaway on huge App Store images. Default 5 MB. */
  maxImageBytes?: number;
  retry?: RetryOptions;
  onTokenUsage?: (usage: TokenUsage) => void;
}

const VISION_JUDGE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    culturalFitScore: {
      type: "number",
      minimum: 0,
      maximum: 10,
      description:
        "Cultural fit score: 0=screenshots fully adapted to market, 10=culturally inappropriate (US stock photos in non-US market, etc).",
    },
    reasoning: {
      type: "string",
      minLength: 1,
      maxLength: REASONING_MAX_CHARS,
      description: "1-3 sentence justification grounded in the screenshots seen.",
    },
    signals: {
      type: "object",
      properties: {
        screenshotsLocalized: { type: "boolean" },
        imagesCulturallyAdapted: { type: "boolean" },
        textInLanguage: { type: "boolean" },
        screenshotFreshness: {
          type: "string",
          enum: ["fresh", "stale", "unknown"],
        },
      },
      required: [
        "screenshotsLocalized",
        "imagesCulturallyAdapted",
        "textInLanguage",
        "screenshotFreshness",
      ],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["culturalFitScore", "reasoning", "signals", "confidence"],
} as const;

function buildPromptText(app: RawAppData, screenshotCount: number): string {
  return [
    `You are a cultural fit auditor for mobile app screenshots.`,
    `Below are ${screenshotCount} screenshot(s) from app "${app.name}" (${app.developer}, ${app.category})`,
    `as listed on the **${app.store}** store for market **${app.market}** (ISO alpha-2).`,
    ``,
    `Score how well the screenshots are adapted to this market's culture and language.`,
    `0 = screenshots fully localized + culturally adapted; 10 = obvious mismatch (e.g., US food`,
    `imagery in a JP listing, English-only captions in a non-EN market).`,
    ``,
    `If market language is English (us, gb, au, ca, ie, nz), grade only on visual quality + freshness.`,
    `Return ONLY the tool call.`,
  ].join("\n");
}

async function fetchScreenshots(
  urls: readonly string[],
  fetcher: ImageFetcher,
  cap: number,
  timeoutMs: number,
  maxBytes: number,
): Promise<{
  blocks: AnthropicImageBlock[];
  fetched: number;
  failed: number;
}> {
  const limited = urls.slice(0, cap);
  const blocks: AnthropicImageBlock[] = [];
  let failed = 0;
  for (const url of limited) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const img = await fetcher(url, { signal: controller.signal });
      // base64 expansion is ~4/3 of bytes, but the cap is on the wire payload to
      // Anthropic so we measure base64 length directly.
      if (img.base64.length > maxBytes) {
        failed += 1;
        continue;
      }
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.base64,
        },
      });
    } catch {
      failed += 1;
    } finally {
      clearTimeout(timer);
    }
  }
  return { blocks, fetched: blocks.length, failed };
}

function extractToolUse(msg: AnthropicMessage): unknown | null {
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.name === TOOL_NAME) {
      return block.input;
    }
  }
  return null;
}

export async function judgeAppVision(
  opts: JudgeAppVisionOptions,
): Promise<Result<VisionJudgeResult, Error>> {
  if (opts.app.screenshotUrls.length === 0) {
    return err(new Error("vision-judge: app has no screenshot URLs"));
  }
  const cap = opts.maxScreenshots ?? DEFAULT_MAX_SCREENSHOTS;
  const timeoutMs = opts.imageFetchTimeoutMs ?? DEFAULT_IMAGE_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const { blocks, fetched } = await fetchScreenshots(
    opts.app.screenshotUrls,
    opts.fetchImage,
    cap,
    timeoutMs,
    maxBytes,
  );
  if (fetched === 0) {
    return err(new Error("vision-judge: all screenshot fetches failed"));
  }
  // TODO(M6): if fetched < MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT, the
  // orchestrator should down-weight this judge's confidence in the composite
  // score rather than treating it as a clean signal. Plumbed via
  // result.value.screenshotsAnalyzed which the orchestrator already sees.

  const model = opts.model ?? DEFAULT_VISION_JUDGE_MODEL;
  const promptText = buildPromptText(opts.app, fetched);
  const userContent: UserContentBlock[] = [...blocks, { type: "text", text: promptText }];

  const params: AnthropicMessageCreateParams = {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: userContent }],
    tools: [
      {
        name: TOOL_NAME,
        description: "Emit cultural fit score for the given screenshots and target market.",
        input_schema: VISION_JUDGE_TOOL_SCHEMA,
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
    return err(new Error("vision-judge: response contained no tool_use block"));
  }

  const candidate = {
    kind: "vision" as const,
    appId: opts.app.appId,
    store: opts.app.store,
    market: opts.app.market,
    modelVersion: model,
    screenshotsAnalyzed: fetched,
    ...(toolInput as Record<string, unknown>),
  };

  const parsed = VisionJudgeResultSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(
      new Error(`vision-judge: tool input failed schema validation: ${parsed.error.message}`),
    );
  }
  return ok(parsed.data);
}
