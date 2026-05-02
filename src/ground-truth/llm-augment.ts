/**
 * LLM augmentation with Zod-enforced citation — the v1 anti-hallucination shield.
 *
 * Per docs/planning/agent-v1-foundation.md § "v1 ground truth — LLM
 * augmentation rules":
 *
 *   - Only used when a deterministic input is missing (e.g.,
 *     public_revenue_estimate for an app without third-party data).
 *   - LLM searches IndieHackers, ProductHunt, Twitter/X, Reddit, app store
 *     reviews.
 *   - **Citation obligatoire** per claim (URL or verifiable source).
 *     No citation → claim rejected → field stays null.
 *   - Output format: revenue_claimed_low | mid | high with source URL.
 *   - **No fabrication.** Null is acceptable; hallucination is not.
 *
 * Implementation: every claim is wrapped in `ClaimWithCitation` Zod schema.
 * The LLM tool-use call returns a structured object that MUST parse cleanly:
 *
 *   { value: 'low' | 'mid' | 'high', evidence_url: <valid URL>, source_quote: <≥20 chars> }
 *
 * If `ClaimWithCitation.parse(...)` throws (no URL / invalid URL format /
 * source quote too short / refusal text rather than structured output),
 * the field stays null — no fallback to "best guess," no fabrication.
 *
 * Persists to `signal_snapshots` with FULL LLM provenance (Codex R2 #6):
 *   - llm_model: e.g., "claude-opus-4-7"
 *   - llm_prompt_version: bumped on prompt change ('v1.0.0' for v1 ship)
 *   - llm_request_hash: sha256 of canonical prompt
 *   - llm_response_hash: sha256 of raw response text
 *   - llm_response_archived: the raw response text (for replay)
 *   - source_urls_json: JSON array of citation URLs
 *
 * Backtest replay reads frozen rows from signal_snapshots and never calls
 * the LLM — see docs/planning/agent-v1-foundation.md § "v1 architecture
 * data flow" failure-modes table.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import pino from "pino";
import { z } from "zod";

const logger = pino({
  name: "llm-augment",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Bumped on any prompt change. Persisted with each call for replay. */
export const LLM_AUGMENT_PROMPT_VERSION = "v1.0.0";

export const DEFAULT_LLM_MODEL = "claude-opus-4-7";

const MAX_RETRIES = 1; // augment timeout → retry once, then null

/**
 * Citation-enforced claim schema. The LLM's tool-use response MUST conform
 * exactly:
 *   - value: closed enum 'low' | 'mid' | 'high'
 *   - evidence_url: a syntactically valid URL (z.string().url())
 *   - source_quote: at least 20 characters (filters refusal text like
 *     "I cannot find this information.")
 *
 * Any missing or malformed field → Zod throws → caller persists null.
 */
export const ClaimWithCitation = z.object({
  value: z.union([z.literal("low"), z.literal("mid"), z.literal("high")]),
  evidence_url: z.string().url(),
  source_quote: z.string().min(20),
});
export type ClaimWithCitationT = z.infer<typeof ClaimWithCitation>;

// ──────────────────────────────────────────────────────────────────────
// Anthropic SDK shapes (mirror src/judges/text-judge.ts AnthropicMessage
// shape so tests can inject fakes that satisfy the same interface).
// ──────────────────────────────────────────────────────────────────────

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

export interface LlmAugmentClient {
  messages: {
    create(params: unknown): Promise<AnthropicMessage>;
  };
}

// ──────────────────────────────────────────────────────────────────────

export interface AugmentFieldOptions {
  /** Anthropic SDK client (or test fake). */
  client: LlmAugmentClient;
  /** Override model (default DEFAULT_LLM_MODEL). */
  model?: string;
  /** Override prompt version (default LLM_AUGMENT_PROMPT_VERSION). */
  promptVersion?: string;
  /** Override clock for deterministic computed_at. */
  clock?: () => number;
  /** Optional persistence. When provided, writes the result to signal_snapshots. */
  persist?: { db: Database; app_id: string; signal_name: string; t: number };
}

export interface AugmentFieldResult {
  /** Parsed claim (or null on rejection). */
  claim: ClaimWithCitationT | null;
  /** sha256 hex of the canonical prompt. */
  request_hash: string;
  /** sha256 hex of the raw LLM response (the tool_use input JSON). */
  response_hash: string;
  /** The raw response text (the tool_use input as JSON). */
  response_archived: string;
  /** Citation URLs extracted from the parsed claim ([] when claim is null). */
  source_urls: string[];
}

/**
 * Augment a missing field by querying the LLM with citation enforcement.
 *
 * @param claim_type free-text description of what we're asking ("revenue
 *                   estimate for app X", "DAU estimate", etc.)
 * @param app        the app context to inject into the prompt
 * @param opts       client + persistence injection
 *
 * Returns:
 *   - claim: parsed ClaimWithCitation, OR null if Zod rejected, OR null
 *     after max-retry timeout / refusal.
 *   - request_hash, response_hash, response_archived, source_urls: always
 *     populated for provenance, even when the claim is null (backtest
 *     replay still wants to know we tried and what the response was).
 *
 * If `opts.persist` is provided, writes one signal_snapshots row regardless
 * of whether the claim parsed (null value is persisted with the same
 * provenance — distinguishing "we asked and got nothing" from "we never
 * asked").
 */
export async function augmentField(
  claim_type: string,
  app: { app_id: string; market?: string; name?: string },
  opts: AugmentFieldOptions,
): Promise<AugmentFieldResult> {
  const model = opts.model ?? DEFAULT_LLM_MODEL;
  const promptVersion = opts.promptVersion ?? LLM_AUGMENT_PROMPT_VERSION;
  const clock = opts.clock ?? Date.now;

  const prompt = buildPrompt(claim_type, app);
  const request_hash = sha256(prompt);

  let response: AnthropicMessage | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      response = await callLlm(opts.client, model, prompt);
      break;
    } catch (e) {
      if (attempt === MAX_RETRIES) {
        logger.warn(
          { claim_type, app_id: app.app_id, err: String(e) },
          "augmentField: LLM call failed after retries → null",
        );
        const empty: AugmentFieldResult = {
          claim: null,
          request_hash,
          response_hash: "",
          response_archived: "",
          source_urls: [],
        };
        await maybePersist(empty, promptVersion, model, clock, opts);
        return empty;
      }
    }
  }
  // response is non-null here because either the loop succeeded or we returned.
  if (response === null) {
    // Defensive: should never reach here. Fall back to null result.
    const empty: AugmentFieldResult = {
      claim: null,
      request_hash,
      response_hash: "",
      response_archived: "",
      source_urls: [],
    };
    await maybePersist(empty, promptVersion, model, clock, opts);
    return empty;
  }

  // Extract tool_use input. If absent (LLM responded with text-only refusal),
  // we still archive the raw text content so the response_hash is stable.
  const toolUse = response.content.find((b): b is AnthropicToolUseBlock => b.type === "tool_use");
  const archivedRaw = toolUse
    ? JSON.stringify(toolUse.input)
    : response.content
        .filter((b): b is AnthropicTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
  const response_hash = sha256(archivedRaw);

  let claim: ClaimWithCitationT | null = null;
  let source_urls: string[] = [];
  if (toolUse) {
    const parsed = ClaimWithCitation.safeParse(toolUse.input);
    if (parsed.success) {
      claim = parsed.data;
      source_urls = [parsed.data.evidence_url];
    } else {
      logger.warn(
        { claim_type, app_id: app.app_id, issues: parsed.error.issues.map((i) => i.message) },
        "augmentField: Zod rejected LLM response → null (no fabrication)",
      );
    }
  } else {
    logger.info(
      { claim_type, app_id: app.app_id },
      "augmentField: LLM returned no tool_use (likely refusal) → null",
    );
  }

  const result: AugmentFieldResult = {
    claim,
    request_hash,
    response_hash,
    response_archived: archivedRaw,
    source_urls,
  };
  await maybePersist(result, promptVersion, model, clock, opts);
  return result;
}

async function callLlm(
  client: LlmAugmentClient,
  model: string,
  prompt: string,
): Promise<AnthropicMessage> {
  return client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
    tools: [
      {
        name: "claim_with_citation",
        description:
          "Emit a structured claim with a verifiable citation. Refuse if no source available.",
        input_schema: {
          type: "object",
          properties: {
            value: { type: "string", enum: ["low", "mid", "high"] },
            evidence_url: { type: "string", format: "uri" },
            source_quote: { type: "string", minLength: 20 },
          },
          required: ["value", "evidence_url", "source_quote"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "claim_with_citation" },
  });
}

function buildPrompt(
  claim_type: string,
  app: { app_id: string; market?: string; name?: string },
): string {
  return [
    `You are a market-research analyst with web access.`,
    `Task: estimate **${claim_type}** for the following app.`,
    ``,
    `App: ${app.name ?? app.app_id}`,
    `App ID: ${app.app_id}`,
    `Market: ${app.market ?? "n/a"}`,
    ``,
    `Search IndieHackers, ProductHunt, Twitter/X, Reddit, and app-store review threads.`,
    `Return ONLY the tool call. The tool requires:`,
    `  - value: 'low', 'mid', or 'high' (banded estimate)`,
    `  - evidence_url: a single URL backing the claim`,
    `  - source_quote: a verbatim quote (≥20 chars) from that URL`,
    ``,
    `If you cannot find a citation, DO NOT GUESS. Refuse the tool call.`,
  ].join("\n");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function maybePersist(
  result: AugmentFieldResult,
  promptVersion: string,
  model: string,
  clock: () => number,
  opts: AugmentFieldOptions,
): Promise<void> {
  if (!opts.persist) return;
  const { db, app_id, signal_name, t } = opts.persist;
  const now = clock();
  const value = result.claim ? bandToScore(result.claim.value) : null;
  db.prepare(
    `INSERT OR REPLACE INTO signal_snapshots (
       app_id, signal_name, t, value,
       llm_model, llm_prompt_version, llm_request_hash,
       llm_response_hash, llm_response_archived, source_urls_json,
       computed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    app_id,
    signal_name,
    t,
    value,
    model,
    promptVersion,
    result.request_hash,
    result.response_hash,
    result.response_archived,
    JSON.stringify(result.source_urls),
    now,
  );
}

/**
 * Map low/mid/high band to a 0-10 score for downstream scoring composer
 * compatibility. low=2, mid=5, high=8 — picked at v1 to avoid the band
 * boundaries colliding with scoring tier cutoffs (5/7).
 */
export function bandToScore(band: "low" | "mid" | "high"): number {
  if (band === "low") return 2;
  if (band === "mid") return 5;
  return 8;
}
