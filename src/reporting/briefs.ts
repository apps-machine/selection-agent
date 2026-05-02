/**
 * Brief renderer — v1 + legacy.
 *
 * This module exports two surfaces:
 *
 *   1. `renderBrief(opportunity, opts)` — the v1 surface. Renders a structured
 *      Opportunity record (src/opportunities/schema.ts) into the prose format
 *      defined in docs/planning/agent-v1-foundation.md § "Brief structure
 *      (LLM template)". The thesis paragraph is LLM-generated and persisted
 *      to signal_snapshots with full provenance for backtest replay.
 *
 *   2. `generateBrief(scanResult)` + `appStoreLink(app)` — the legacy v0.7
 *      surface used by the published `selection-agent scan` CLI and the
 *      demo refresh script. Kept here unchanged so the npm package's user
 *      flow keeps working while the v1 Opportunity pipeline lands behind
 *      the scenes. Once the orchestrator emits Opportunity records (Task 7),
 *      the CLI flips to renderBrief and the legacy function can be removed.
 *
 * See docs/planning/agent-v1-foundation.md § "Opportunity contract" + Codex
 * Round 2 #5 (null-safe tag derivation) + #6 (LLM provenance for replay).
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import pino from "pino";
import type { Opportunity, OpportunityMarket } from "../opportunities/schema.ts";
import type { RankedCandidate, ScanResult } from "../orchestrator/types.ts";
import type { RawAppData } from "../types/raw-app-data.ts";

// ──────────────────────────────────────────────────────────────────────
// v1 — renderBrief(opportunity, opts)
// ──────────────────────────────────────────────────────────────────────

/**
 * Bumped on any prompt change. Persisted with each thesis call so backtest
 * replay can pin to a specific prompt generation. Codex Round 2 #6.
 */
export const THESIS_PROMPT_VERSION = "v1.0.0";

/**
 * Default LLM model for thesis generation. Per CLAUDE.md model defaults.
 * Override via `BriefRenderOptions.model` in tests/eval.
 */
export const DEFAULT_THESIS_MODEL = "claude-opus-4-7";

/**
 * Tier-2 markets per docs/planning/agent-v1-foundation.md § "v1 pattern tags".
 * Used by the `tier2-localization` tag rule. Closed enum to prevent silent
 * drift; updates require a tag-rule revision.
 */
export const TIER_2_MARKETS: readonly OpportunityMarket[] = [
  "id",
  "vn",
  "th",
  "my",
  "ph",
  "bd",
] as const;

const briefLogger = pino({
  name: "briefs:renderBrief",
  level: process.env.LOG_LEVEL ?? "info",
});

// ─── Anthropic SDK shape ──────────────────────────────────────────────
// Mirrored from src/judges/text-judge.ts so tests can pass in fakes that
// satisfy the same interface without depending on the real SDK module.

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

export interface ThesisLlmClient {
  messages: {
    create(params: unknown): Promise<AnthropicMessage>;
  };
}

// ─── Public options + result ──────────────────────────────────────────

export interface BriefRenderOptions {
  /**
   * Skip the LLM call for the thesis paragraph and substitute a placeholder.
   * Useful for offline tests + dry-run developer flows. When dryRun=true,
   * NO persistence to signal_snapshots happens either — there's no archived
   * response to freeze, and writing a placeholder row would muddy backtest
   * replay. Documented behavior: dryRun is a pure rendering path, no I/O.
   */
  dryRun?: boolean;
  /** Anthropic SDK client (or test fake). Required when dryRun is false. */
  client?: ThesisLlmClient;
  /** Override model. Defaults to DEFAULT_THESIS_MODEL. */
  model?: string;
  /** Override prompt version. Defaults to THESIS_PROMPT_VERSION. */
  promptVersion?: string;
  /** Override clock for deterministic computed_at in persistence. */
  clock?: () => number;
  /**
   * Optional persistence. When provided AND dryRun is false, writes one
   * signal_snapshots row with full LLM provenance (Codex Round 2 #6) so
   * backtest replay reads the archived response instead of re-calling the
   * LLM (which may be deprecated by then).
   */
  persist?: { db: Database; t: number };
}

// ─── Tag derivation ───────────────────────────────────────────────────

/**
 * Derive v1 pattern tags from an Opportunity. Per
 * docs/planning/agent-v1-foundation.md § "v1 pattern tags" + Codex Round 2 #5
 * fix: every threshold check is preceded by an explicit `!= null` guard.
 * `undefined > 7` silently evaluates to `false` in JS — without the explicit
 * check we'd silently miss tags on opportunities that never had the signal
 * computed.
 *
 * No `mechanic-export` tag in v1 (mechanic_novelty is evidence-only,
 * lives in metadata.mechanic_evidence). Returns when v2 promotes
 * mechanic_novelty into a scored signal.
 */
export function deriveTags(opp: Opportunity): string[] {
  const tags: string[] = [];
  const s = opp.signal_values;

  // tier2-localization: high locGap in a tier-2 SEA market
  if (
    s.locGap != null &&
    s.locGap > 7 &&
    (TIER_2_MARKETS as readonly OpportunityMarket[]).includes(opp.target_market)
  ) {
    tags.push("tier2-localization");
  }

  // hot-wave: rapid velocity but no localization moat (raw chart momentum,
  // not a defensible position). The locGap check is "either null OR low" —
  // if locGap is unknown the wave still qualifies as "hot, not loc-driven."
  if (s.velocity != null && s.velocity > 7 && (s.locGap == null || s.locGap < 4)) {
    tags.push("hot-wave");
  }

  // incumbent-toppling: stale incumbent + favorable unit economics
  if (
    s.incumbent_vulnerability != null &&
    s.incumbent_vulnerability > 7 &&
    s.cpi_ltv_proxy != null &&
    s.cpi_ltv_proxy > 6
  ) {
    tags.push("incumbent-toppling");
  }

  return tags;
}

// ─── Render entrypoint ────────────────────────────────────────────────

/**
 * Render an Opportunity into the v1 brief prose format.
 *
 * @param opportunity Validated Opportunity record (from src/opportunities/schema.ts)
 * @param opts        dryRun + LLM client + persistence injection
 *
 * Returns the rendered prose string. Throws if the Opportunity has zero
 * evidence citations (Opportunity schema enforces ≥1 upstream — this is a
 * defensive runtime check for callers that bypass the schema, e.g. test
 * fixtures that hand-construct shapes).
 *
 * Null safety:
 *  - Missing signals (null in signal_values) → omitted from the Signals
 *    section, NOT shown as "null/10".
 *  - Missing predicted ranges → omitted from the Predicted economics line.
 *  - Missing tags → "Tags: (none derived)".
 *  - Missing mechanic_evidence in metadata → mechanic line omitted from
 *    the Signals section.
 *  - Empty evidence array → throws (schema enforces ≥1; this guards against
 *    schema-bypassing callers).
 */
export async function renderBrief(
  opportunity: Opportunity,
  opts: BriefRenderOptions = {},
): Promise<string> {
  if (opportunity.evidence.length === 0) {
    throw new Error(
      "renderBrief: opportunity.evidence is empty (Opportunity schema requires ≥1 citation; defensive guard for schema-bypassing callers)",
    );
  }

  const thesis = await resolveThesis(opportunity, opts);
  const tags = deriveTags(opportunity);

  const lines: string[] = [];

  // Source / Target header
  lines.push(`**Source:** ${opportunity.source_app_id} in ${opportunity.source_market}`);
  lines.push(`**Target:** ${opportunity.target_market}`);
  lines.push("");

  // Thesis
  lines.push("**Thesis**");
  lines.push(thesis);
  lines.push("");

  // Signals (null-safe)
  lines.push("**Signals**");
  const signalLines = renderSignals(opportunity);
  if (signalLines.length === 0) {
    lines.push("  (none computed)");
  } else {
    for (const line of signalLines) lines.push(line);
  }
  lines.push("");

  // Predicted economics (null-safe)
  lines.push("**Predicted economics**");
  lines.push(`  ${renderPredicted(opportunity)}`);
  lines.push("");

  // Tags (null-safe)
  if (tags.length === 0) {
    lines.push("**Tags:** (none derived)");
  } else {
    lines.push(`**Tags:** ${tags.join(", ")}`);
  }
  lines.push("");

  // Validation plan
  lines.push("**Validation plan**");
  lines.push(`  ${renderValidationPlan(opportunity)}`);
  lines.push("");

  // Evidence (always non-empty per the guard above)
  lines.push("**Evidence**");
  for (const c of opportunity.evidence) {
    lines.push(`  ${c.url} — ${c.claim}`);
  }
  lines.push("");

  return lines.join("\n");
}

// ─── Internals: thesis resolution ─────────────────────────────────────

async function resolveThesis(opportunity: Opportunity, opts: BriefRenderOptions): Promise<string> {
  if (opts.dryRun) {
    return "Thesis: [dry-run placeholder]";
  }
  if (!opts.client) {
    throw new Error(
      "renderBrief: opts.client is required when dryRun is false (pass an Anthropic SDK client or set dryRun: true)",
    );
  }

  const model = opts.model ?? DEFAULT_THESIS_MODEL;
  const promptVersion = opts.promptVersion ?? THESIS_PROMPT_VERSION;
  const clock = opts.clock ?? Date.now;
  const prompt = buildThesisPrompt(opportunity);
  const request_hash = sha256(prompt);

  // Cache lookup: signal_snapshots IS the durable cache for thesis generations.
  // Repeated renderBrief calls for the same Opportunity (same prompt → same
  // request_hash → same row PK) can reuse the archived response without
  // re-calling the LLM. Same provenance shape (Codex Round 2 #6) means
  // backtest replay reads from this row too — there's only one cache.
  if (opts.persist) {
    const cached = readArchivedThesis({
      db: opts.persist.db,
      app_id: opportunity.source_app_id,
      t: opts.persist.t,
      promptVersion,
      request_hash,
    });
    if (cached !== null) {
      briefLogger.debug(
        { app_id: opportunity.source_app_id, request_hash },
        "renderBrief: thesis cache hit → reusing archived response",
      );
      return cached;
    }
  }

  let response: AnthropicMessage;
  try {
    response = await opts.client.messages.create({
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    briefLogger.warn(
      { app_id: opportunity.source_app_id, err: String(e) },
      "renderBrief: thesis LLM call failed → falling back to opportunity.thesis",
    );
    // Fallback: if the LLM call fails entirely, render the seeded thesis from
    // the Opportunity record. The seed is whatever upstream put in the
    // contract — usually a structured argument written by the orchestrator
    // before LLM polish. This keeps the brief renderable on transient API
    // outages instead of crashing the digest job.
    return opportunity.thesis;
  }

  const text = extractText(response);
  if (text.length === 0) {
    briefLogger.warn(
      { app_id: opportunity.source_app_id },
      "renderBrief: thesis LLM returned empty text → falling back to opportunity.thesis",
    );
    return opportunity.thesis;
  }
  const response_hash = sha256(text);

  if (opts.persist) {
    persistThesisSnapshot({
      db: opts.persist.db,
      app_id: opportunity.source_app_id,
      t: opts.persist.t,
      now: clock(),
      model,
      promptVersion,
      request_hash,
      response_hash,
      response_archived: text,
    });
  }

  return text;
}

function buildThesisPrompt(opp: Opportunity): string {
  const signalsBlock = formatSignalsForPrompt(opp);
  const predictedBlock = formatPredictedForPrompt(opp);
  const mechanic = (opp.metadata as Record<string, unknown>).mechanic_evidence;
  const mechanicLine =
    typeof mechanic === "string" && mechanic.length > 0
      ? `Mechanic evidence: ${mechanic}`
      : `Mechanic evidence: (not available)`;

  return [
    `You are an indie-app strategy analyst.`,
    `Write ONE paragraph (≤120 words) explaining the opportunity below to an indie maker considering whether to ship a competitor in the destination market.`,
    ``,
    `The paragraph MUST cover:`,
    `  - What the opportunity is.`,
    `  - Who currently dominates the destination market for this category.`,
    `  - Why the destination market is open right now.`,
    ``,
    `Stay grounded in the data below. Do NOT invent numbers, names, or claims that aren't supported by the signals or evidence.`,
    `Output the paragraph only. No preamble, no bullet list, no markdown.`,
    ``,
    `─── DATA ───`,
    `Source app: ${opp.source_app_id} (origin: ${opp.source_market})`,
    `Target market: ${opp.target_market}`,
    `Category: ${opp.category}`,
    ``,
    `Signals:`,
    signalsBlock,
    mechanicLine,
    ``,
    `Predicted economics: ${predictedBlock}`,
    `Kill metric: ${opp.kill_metric.metric} ${opp.kill_metric.direction} ${opp.kill_metric.threshold}`,
  ].join("\n");
}

function formatSignalsForPrompt(opp: Opportunity): string {
  const lines: string[] = [];
  const s = opp.signal_values;
  if (s.locGap != null) lines.push(`  - locGap: ${s.locGap.toFixed(1)}/10`);
  if (s.velocity != null) lines.push(`  - velocity: ${s.velocity.toFixed(1)}/10`);
  if (s.incumbent_vulnerability != null) {
    lines.push(`  - incumbent_vulnerability: ${s.incumbent_vulnerability.toFixed(1)}/10`);
  }
  if (s.cpi_ltv_proxy != null) lines.push(`  - cpi_ltv_proxy: ${s.cpi_ltv_proxy.toFixed(1)}/10`);
  return lines.length === 0 ? "  (none computed)" : lines.join("\n");
}

function formatPredictedForPrompt(opp: Opportunity): string {
  const parts: string[] = [];
  const p = opp.predicted;
  if (p.cpi_low != null && p.cpi_high != null) {
    parts.push(`CPI $${p.cpi_low}-$${p.cpi_high}`);
  } else if (p.cpi_low != null) {
    parts.push(`CPI $${p.cpi_low}+`);
  }
  if (p.ltv_low != null && p.ltv_high != null) {
    parts.push(`LTV $${p.ltv_low}-$${p.ltv_high}`);
  } else if (p.ltv_low != null) {
    parts.push(`LTV $${p.ltv_low}+`);
  }
  if (p.validation_budget_usd != null) {
    parts.push(`validation budget $${p.validation_budget_usd}`);
  }
  return parts.length === 0 ? "(no predictions)" : parts.join(" | ");
}

function extractText(msg: AnthropicMessage): string {
  return msg.content
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Read an archived thesis from signal_snapshots if one exists for the same
 * (app_id, signal_name='thesis', t, prompt_version) PK AND the request_hash
 * matches. The hash check matters: if the prompt content changed (e.g.,
 * signals updated, mechanic_evidence changed) we must re-call the LLM even
 * though the row already exists at the same PK — same prompt_version, but
 * different prompt input means a different question.
 *
 * Returns null on no match (cache miss) so the caller falls through to the
 * live LLM call.
 */
function readArchivedThesis(args: {
  db: Database;
  app_id: string;
  t: number;
  promptVersion: string;
  request_hash: string;
}): string | null {
  const row = args.db
    .prepare<
      { llm_request_hash: string | null; llm_response_archived: string | null },
      [string, number, string]
    >(
      `SELECT llm_request_hash, llm_response_archived
         FROM signal_snapshots
         WHERE app_id = ? AND signal_name = 'thesis' AND t = ? AND llm_prompt_version = ?`,
    )
    .get(args.app_id, args.t, args.promptVersion);
  if (!row) return null;
  if (row.llm_request_hash !== args.request_hash) return null;
  if (row.llm_response_archived === null || row.llm_response_archived.length === 0) return null;
  return row.llm_response_archived;
}

function persistThesisSnapshot(args: {
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
      "thesis",
      args.t,
      null,
      args.model,
      args.promptVersion,
      args.request_hash,
      args.response_hash,
      args.response_archived,
      "[]", // thesis is generated from internal data; no external source URLs cited
      args.now,
    );
}

// ─── Internals: section renderers ─────────────────────────────────────

function renderSignals(opp: Opportunity): string[] {
  const out: string[] = [];
  const s = opp.signal_values;

  // Per-signal short reasons. The reasons are template strings — the
  // upstream orchestrator can put richer per-signal reasoning in
  // metadata.signal_reasons for a future iteration; for v1 we keep them
  // template-based + null-safe.
  const reasons = (opp.metadata as Record<string, unknown>).signal_reasons as
    | Record<string, string | undefined>
    | undefined;

  if (s.locGap != null) {
    const reason = reasons?.locGap ?? "Localization gap measured against destination-market norms.";
    out.push(`  - locGap: ${formatScore(s.locGap)}/10 — ${reason}`);
  }
  if (s.velocity != null) {
    const reason =
      reasons?.velocity ?? "Rank-delta on destination-market top-grossing chart, 30d smoothed.";
    out.push(`  - velocity: ${formatScore(s.velocity)}/10 — ${reason}`);
  }
  if (s.incumbent_vulnerability != null) {
    const reason =
      reasons?.incumbent_vulnerability ??
      "Composite of days-since-update and 90d rating trend on dominant incumbents.";
    out.push(
      `  - incumbent_vulnerability: ${formatScore(s.incumbent_vulnerability)}/10 — ${reason}`,
    );
  }
  if (s.cpi_ltv_proxy != null) {
    const reason =
      reasons?.cpi_ltv_proxy ?? "Lookup table for category × market × incumbent CPI/LTV ratio.";
    out.push(`  - cpi_ltv_proxy: ${formatScore(s.cpi_ltv_proxy)}/10 — ${reason}`);
  }

  // mechanic_evidence is evidence-only (no score). Rendered as a paragraph
  // when present, omitted entirely when null.
  const mechanic = (opp.metadata as Record<string, unknown>).mechanic_evidence;
  if (typeof mechanic === "string" && mechanic.length > 0) {
    out.push(`  - mechanic_evidence: ${mechanic}`);
  }

  return out;
}

function renderPredicted(opp: Opportunity): string {
  const parts: string[] = [];
  const p = opp.predicted;
  if (p.cpi_low != null && p.cpi_high != null) {
    parts.push(`CPI: $${p.cpi_low}-$${p.cpi_high}`);
  } else if (p.cpi_low != null) {
    parts.push(`CPI: $${p.cpi_low}+`);
  }
  if (p.ltv_low != null && p.ltv_high != null) {
    parts.push(`LTV: $${p.ltv_low}-$${p.ltv_high}`);
  } else if (p.ltv_low != null) {
    parts.push(`LTV: $${p.ltv_low}+`);
  }
  if (p.validation_budget_usd != null) {
    parts.push(`Capital to validate: $${p.validation_budget_usd}`);
  }
  // Horizon is a derived narrative field — for v1 we report a fixed 3-month
  // window matching the canonical kill-metric cadence (roas_d14 + scale window).
  // Future iterations can pull this from metadata.horizon_months when set.
  const horizon = (opp.metadata as Record<string, unknown>).horizon_months;
  if (typeof horizon === "number") {
    parts.push(`Horizon: ${horizon} months`);
  }
  return parts.length === 0 ? "(no predictions)" : parts.join(" | ");
}

function renderValidationPlan(opp: Opportunity): string {
  // Pull custom plan steps from metadata when present, fall back to a
  // generic two-step skeleton anchored on the kill_metric.
  const customSteps = (opp.metadata as Record<string, unknown>).validation_steps as
    | string[]
    | undefined;
  const steps =
    customSteps && Array.isArray(customSteps) && customSteps.length > 0
      ? customSteps
      : [
          "Ship a localized clone with the 3 features the incumbent lacks.",
          `Run paid acquisition until validation budget ${
            opp.predicted.validation_budget_usd != null
              ? `$${opp.predicted.validation_budget_usd}`
              : "(unset)"
          } is consumed.`,
        ];
  const stepsRendered = steps.map((s, i) => `Step ${i + 1}: ${s}`).join(" | ");
  const kill = `Kill criterion: ${opp.kill_metric.metric} ${opp.kill_metric.direction} ${opp.kill_metric.threshold}`;
  return `${stepsRendered} | ${kill}`;
}

function formatScore(n: number): string {
  return n.toFixed(1);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ──────────────────────────────────────────────────────────────────────
// LEGACY — generateBrief(scanResult) + appStoreLink(app)
// ──────────────────────────────────────────────────────────────────────
//
// These are the v0.7 surface used by the published `selection-agent scan`
// CLI and the demo refresh script. Kept here unchanged so the npm package's
// user flow keeps working while the v1 Opportunity pipeline lands behind
// the scenes (Task 7 will route the orchestrator to renderBrief).
//
// Pinned via `briefs.golden.test.ts` — intentional output is golden-tested;
// any drift is a deliberate format change that requires re-snapshot.
// ──────────────────────────────────────────────────────────────────────

/**
 * Markdown founder brief. Pinned via `briefs.golden.test.ts` —
 * intentional output is golden-tested; any drift is a deliberate
 * format change that requires re-snapshot.
 *
 * @deprecated use `renderBrief(opportunity, opts)` for new v1 flows.
 *   This function will be removed once the orchestrator emits Opportunity
 *   records (Task 7 of the v1 build).
 */
export function generateBrief(result: ScanResult): string {
  const lines: string[] = [];
  const isoDay = result.generatedAt.slice(0, 10);
  lines.push(`# Selection Agent — Scan ${isoDay}`);
  lines.push("");
  lines.push(
    `**Markets**: ${result.markets.join(", ")}  |  ` +
      `**Apps scanned**: ${result.appsScanned}  |  ` +
      `**Cost**: $${result.costUsd.toFixed(2)}`,
  );
  lines.push(`**Enrichment**: ${formatEnrichmentSummary(result)}`);
  lines.push("");
  lines.push(`## Top ${result.candidates.length} candidates`);
  lines.push("");

  if (result.candidates.length === 0) {
    lines.push("_No candidates passed scoring this run._");
    lines.push("");
  } else {
    for (const c of result.candidates) {
      lines.push(...renderCandidate(c));
    }
  }

  if (result.failedSlices.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("### Failed slices (skipped, no candidates)");
    lines.push("");
    for (const f of result.failedSlices) {
      lines.push(`- ${f.store} / ${f.market} — ${f.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderCandidate(c: RankedCandidate): string[] {
  const lines: string[] = [];
  const { app } = c;
  const composite = c.composite.composite.toFixed(2);
  const fallbackTag = c.enrichmentSource === "chart-only" ? " _(chart-only)_" : "";
  lines.push(
    `### #${c.rank} — ${app.name} (${app.store}, ${app.market}) — composite ${composite}/10${fallbackTag}`,
  );
  lines.push("");

  const locReason = c.textJudge?.reasoning ?? "heuristic only — no text judge run";
  lines.push(
    `- **Localization gap**: ${c.composite.breakdown.locGap.toFixed(1)}/10 (${oneLine(locReason)})`,
  );

  if (c.visionJudge !== null) {
    lines.push(
      `- **Cultural fit (vision)**: ${c.visionJudge.culturalFitScore.toFixed(1)}/10 (${oneLine(c.visionJudge.reasoning)})`,
    );
  } else {
    const reason =
      app.screenshotUrls.length === 0
        ? "no vision judge — empty screenshots"
        : "no vision judge — judge skipped or errored";
    lines.push(`- **Cultural fit (vision)**: n/a (${reason})`);
  }

  lines.push(
    `- **Revenue est**: ${c.composite.breakdown.revenue.toFixed(1)}/10 ` +
      `(${app.ratingsCount ?? 0} ratings, market ${app.market})`,
  );
  lines.push(`- **Paywall complexity**: ${c.composite.breakdown.paywall.toFixed(1)}/10`);

  const velocityCell =
    c.composite.breakdown.velocity === null
      ? "scaffolding (J0/14)"
      : `${c.composite.breakdown.velocity.toFixed(1)}/10`;
  lines.push(`- **Velocity**: ${velocityCell}`);

  const conf = meanConfidence(c);
  lines.push(`- **Confidence**: ${conf === null ? "n/a" : conf.toFixed(2)}`);

  const link = appStoreLink(app);
  lines.push(`- App Store: ${link}`);
  lines.push("");
  return lines;
}

function meanConfidence(c: RankedCandidate): number | null {
  const xs: number[] = [];
  if (c.textJudge !== null) xs.push(c.textJudge.confidence);
  if (c.visionJudge !== null) xs.push(c.visionJudge.confidence);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Apple App Store URLs require the numeric trackId (e.g. `id1234567890`),
 * not the bundle ID (e.g. `com.google.ios.youtube`). M2 captured the bundle
 * ID into `appId` and lost the trackId — every Apple link 404'd. M7 plumbs
 * `trackId` through `RawAppData`. When present, we use it. When absent
 * (older lib version, missing entry, or a Google app), we fall back to
 * `appId` — best-effort even if the URL may still 404.
 */
export function appStoreLink(app: RawAppData): string {
  if (app.store === "apple") {
    const id = app.trackId ?? app.appId;
    return `https://apps.apple.com/${app.market}/app/id${id}`;
  }
  return `https://play.google.com/store/apps/details?id=${app.appId}&gl=${app.market}`;
}

function formatEnrichmentSummary(result: ScanResult): string {
  if (result.enrichmentSkipped) {
    return "skipped (--no-enrich)";
  }
  const total = result.appsScanned;
  const failed = result.enrichmentFailedCount;
  const enriched = total - failed;
  if (failed === 0) {
    return `${enriched}/${total} enriched`;
  }
  return `${enriched}/${total} enriched (${failed} chart-only fallback)`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
