import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import pino from "pino";
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
/**
 * Minimum screenshot count for a confident vision-judge verdict. Resolved from
 * the M6 TODO (was 2; bumped to 3 during v1 mechanic_evidence work). The
 * threshold matters in two places:
 *   - judgeAppVision: still proceeds with fewer screenshots, but
 *     `screenshotsAnalyzed` on the result lets the orchestrator down-weight
 *     confidence in the composite. The judge does not throw because callers
 *     prefer "thin verdict" over "no verdict" for the cultural-fit signal.
 *   - generateMechanicEvidence: returns null below the threshold. Mechanic
 *     evidence is qualitative prose; with fewer than 3 frames the LLM cannot
 *     reliably identify the engagement loop, so we refuse rather than fabricate.
 *
 * 3 is empirical: 1-2 frames typically capture an onboarding teaser or a single
 * screen, neither of which reveals the loop. 3+ frames usually include at least
 * one core-loop screen (feed/play/checkout/etc).
 */
export const MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT = 3;
const TOOL_NAME = "score_cultural_fit";

const MECHANIC_EVIDENCE_PROMPT_VERSION = "v1.0.0";
const DEFAULT_MECHANIC_EVIDENCE_MODEL = "claude-opus-4-7";

const mechanicLogger = pino({
  name: "vision-judge:mechanic-evidence",
  level: process.env.LOG_LEVEL ?? "info",
});

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
  // Fewer than MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT frames is a thin signal,
  // but we still proceed: the orchestrator reads `screenshotsAnalyzed` on the
  // result and down-weights this judge's confidence in the composite. Refusing
  // to render the verdict at all would erase the only cultural-fit signal we
  // have for sparse-screenshot apps. Hard refusal lives in
  // generateMechanicEvidence below where qualitative prose IS the deliverable
  // and 1-2 frames cannot ground a believable engagement-loop description.

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

// ──────────────────────────────────────────────────────────────────────
// generateMechanicEvidence — qualitative prose, NOT a scored signal
// ──────────────────────────────────────────────────────────────────────
//
// Per docs/planning/agent-v1-foundation.md § "v1 signals" + Codex Round 2 #5:
// `mechanic_novelty` is intentionally absent from `signal_values` in v1. It
// lives in `metadata.mechanic_evidence` as a qualitative LLM paragraph that
// the brief renderer surfaces as evidence-only text. v2 may promote it to a
// scored signal once a 100-item taxonomy + Cohen's kappa across Claude/GPT
// validates inter-rater reliability.
//
// Persistence shape (Codex Round 2 #6 — backtest replay):
//   signal_snapshots.signal_name   = "mechanic_evidence"
//   signal_snapshots.value         = NULL (paragraph isn't a number)
//   signal_snapshots.llm_response_archived = the paragraph text
//   signal_snapshots.llm_request_hash      = sha256 of canonical prompt
//   signal_snapshots.llm_prompt_version    = MECHANIC_EVIDENCE_PROMPT_VERSION
//
// Backtest replay reads frozen rows from this table and never re-calls the
// LLM (which may have been deprecated or changed since the original run).
// ──────────────────────────────────────────────────────────────────────

export interface MechanicEvidenceAppData {
  /** App ID for persistence keying. */
  appId: string;
  /** App name (for prompt context). */
  name: string;
  /** App description (for prompt context). */
  description: string;
  /** Screenshot URLs — count gates the MIN_SCREENSHOTS threshold. */
  screenshotUrls: readonly string[];
  /** Optional review excerpts that flesh out the engagement loop. */
  reviewExcerpts?: readonly string[];
}

export interface GenerateMechanicEvidenceOptions {
  client: VisionJudgeClient;
  fetchImage: ImageFetcher;
  model?: string;
  maxScreenshots?: number;
  imageFetchTimeoutMs?: number;
  maxImageBytes?: number;
  retry?: RetryOptions;
  onTokenUsage?: (usage: TokenUsage) => void;
  /** Override prompt version for tests. */
  promptVersion?: string;
  /** Override clock for deterministic computed_at in persistence. */
  clock?: () => number;
  /**
   * Optional persistence. When provided, writes the result to signal_snapshots
   * with full LLM provenance. Skipped (null returned without writing) when
   * fewer than MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT screenshots — the row
   * would archive nothing useful and would muddy the eval baseline.
   */
  persist?: { db: Database; t: number };
}

export interface MechanicEvidenceResult {
  /** Generated paragraph, or null when below the screenshot threshold. */
  evidence: string | null;
  /** sha256 hex of the canonical prompt; "" when no LLM call was made. */
  request_hash: string;
  /** sha256 hex of the response text; "" when no LLM call was made. */
  response_hash: string;
  /** Number of screenshots the LLM actually saw (0 when below threshold). */
  screenshots_analyzed: number;
}

/**
 * Generate a 2-3 sentence paragraph identifying an app's core engagement loop
 * and any novel mechanics. Pure qualitative description, NOT a numeric signal.
 *
 * Returns `evidence: null` (without calling the LLM) when fewer than
 * MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT screenshots are available — qualitative
 * prose grounded in 1-2 frames is hallucination bait, and we'd rather render
 * "(no mechanic evidence)" than fabricate a loop description.
 *
 * Persists to signal_snapshots when `opts.persist` is provided. Persistence
 * is skipped on the null-evidence path because there's no archived response
 * to freeze — backtest replay would have nothing to read back.
 */
export async function generateMechanicEvidence(
  app: MechanicEvidenceAppData,
  opts: GenerateMechanicEvidenceOptions,
): Promise<MechanicEvidenceResult> {
  if (app.screenshotUrls.length < MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT) {
    mechanicLogger.info(
      {
        app_id: app.appId,
        screenshots: app.screenshotUrls.length,
        min: MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT,
      },
      "generateMechanicEvidence: below MIN_SCREENSHOTS threshold → null",
    );
    return {
      evidence: null,
      request_hash: "",
      response_hash: "",
      screenshots_analyzed: 0,
    };
  }

  const cap = opts.maxScreenshots ?? DEFAULT_MAX_SCREENSHOTS;
  const timeoutMs = opts.imageFetchTimeoutMs ?? DEFAULT_IMAGE_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const { blocks, fetched } = await fetchScreenshots(
    app.screenshotUrls,
    opts.fetchImage,
    cap,
    timeoutMs,
    maxBytes,
  );

  // Re-check the threshold AFTER fetch: a partial CDN failure can drop the
  // effective frame count below the floor even though the URL list was big
  // enough on entry. Same null contract — refuse rather than fabricate.
  if (fetched < MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT) {
    mechanicLogger.warn(
      {
        app_id: app.appId,
        urls: app.screenshotUrls.length,
        fetched,
        min: MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT,
      },
      "generateMechanicEvidence: fetched < MIN_SCREENSHOTS after CDN failures → null",
    );
    return {
      evidence: null,
      request_hash: "",
      response_hash: "",
      screenshots_analyzed: fetched,
    };
  }

  const model = opts.model ?? DEFAULT_MECHANIC_EVIDENCE_MODEL;
  const promptVersion = opts.promptVersion ?? MECHANIC_EVIDENCE_PROMPT_VERSION;
  const clock = opts.clock ?? Date.now;
  const promptText = buildMechanicEvidencePrompt(app, fetched);
  const request_hash = sha256(promptText);

  const userContent: UserContentBlock[] = [...blocks, { type: "text", text: promptText }];

  let response: AnthropicMessage;
  try {
    response = await retryWithBackoff(
      () =>
        opts.client.messages.create({
          model,
          max_tokens: 512,
          messages: [{ role: "user", content: userContent }],
          tools: [],
          // No tool_choice — this prompt expects plain text, not structured output.
          tool_choice: undefined as unknown as { type: "tool"; name: string },
        }),
      {
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
      },
    );
  } catch (e) {
    mechanicLogger.warn(
      { app_id: app.appId, err: String(e) },
      "generateMechanicEvidence: LLM call failed → null",
    );
    return {
      evidence: null,
      request_hash,
      response_hash: "",
      screenshots_analyzed: fetched,
    };
  }

  opts.onTokenUsage?.({
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    model,
  });

  const text = response.content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const response_hash = sha256(text);

  if (text.length === 0) {
    mechanicLogger.warn(
      { app_id: app.appId },
      "generateMechanicEvidence: LLM returned empty text → null",
    );
    return {
      evidence: null,
      request_hash,
      response_hash,
      screenshots_analyzed: fetched,
    };
  }

  if (opts.persist) {
    persistMechanicEvidence({
      db: opts.persist.db,
      app_id: app.appId,
      t: opts.persist.t,
      now: clock(),
      model,
      promptVersion,
      request_hash,
      response_hash,
      response_archived: text,
    });
  }

  return {
    evidence: text,
    request_hash,
    response_hash,
    screenshots_analyzed: fetched,
  };
}

function buildMechanicEvidencePrompt(
  app: MechanicEvidenceAppData,
  screenshotCount: number,
): string {
  const reviews = (app.reviewExcerpts ?? []).slice(0, 5);
  return [
    `You are an app-mechanics analyst.`,
    `Below are ${screenshotCount} screenshot(s) from app "${app.name}".`,
    ``,
    `Description (first 800 chars):`,
    app.description.slice(0, 800),
    ``,
    reviews.length > 0
      ? `Review excerpts (verbatim, no paraphrase):\n${reviews.map((r) => `- "${r.slice(0, 200)}"`).join("\n")}`
      : `(no review excerpts available)`,
    ``,
    `Write a SHORT paragraph (2-3 sentences, ≤90 words) that:`,
    `1. Identifies the core engagement loop (what the user does repeatedly).`,
    `2. Notes any novel mechanic that distinguishes this app from category baselines.`,
    `3. Stays grounded in the screenshots + reviews above. DO NOT invent mechanics`,
    `   you cannot point to in the evidence.`,
    ``,
    `Output the paragraph only. No preamble, no bullet list, no markdown headers.`,
  ].join("\n");
}

function persistMechanicEvidence(args: {
  db: Database;
  app_id: string;
  t: number;
  now: number;
  model: string;
  promptVersion: string;
  request_hash: string;
  response_hash: string;
  response_archived: string;
}): void {
  args.db
    .prepare(
      `INSERT OR REPLACE INTO signal_snapshots (
         app_id, signal_name, t, value,
         llm_model, llm_prompt_version, llm_request_hash,
         llm_response_hash, llm_response_archived, source_urls_json,
         computed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.app_id,
      "mechanic_evidence",
      args.t,
      null,
      args.model,
      args.promptVersion,
      args.request_hash,
      args.response_hash,
      args.response_archived,
      "[]",
      args.now,
    );
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
