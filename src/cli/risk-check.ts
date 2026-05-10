/**
 * `selection-agent risk-check` — Stage 3 risk-threshold annotator
 * (Runbook-Discovery).
 *
 * Reads a shortlist JSON (output of `selection-agent shortlist`) plus a
 * user-supplied risk thresholds JSON file, evaluates every candidate
 * against the five risk checks, and emits an annotated shortlist (JSON
 * default, CSV optional). Lets the founder filter Stage 2 output to
 * candidates that match their portfolio constraints without ever
 * touching the shortlist pipeline itself.
 *
 * Exit codes:
 *   0 — at least one candidate PASSes all thresholds
 *   1 — zero candidates PASS (operator should reconsider thresholds)
 *   2 — invalid args / missing file / parse error
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import pino from "pino";
import {
  type AnnotatedCandidate,
  type AnnotatedShortlist,
  evaluateShortlist,
  type RiskCheckCandidate,
} from "../path-e/risk-check.ts";
import { type RiskThresholds, RiskThresholdsSchema } from "../path-e/risk-thresholds.ts";

export type RiskCheckFormat = "json" | "csv";

export interface RiskCheckCliOpts {
  /** Path to the shortlist JSON (output of `selection-agent shortlist`). */
  shortlistPath: string;
  /** Path to the thresholds JSON file. Empty/partial JSON OK; defaults fill in. */
  thresholdsPath: string;
  /** Output path. When unset, the annotated payload goes to stdout. */
  output?: string;
  /** Output format. Defaults to JSON. */
  format?: RiskCheckFormat;
  /** Override "now" for the generated_at_utc field (test seam). */
  now?: number;
  /** Suppress logger output (used by tests). */
  silent?: boolean;
}

export interface RiskCheckCliResult {
  exitCode: 0 | 1;
  /** The serialized annotated payload (JSON string or CSV). */
  body: string;
  /** Resolved thresholds with defaults filled in. */
  thresholds: RiskThresholds;
  /** Annotated shortlist (raw, in-memory). */
  annotated: AnnotatedShortlist;
}

/**
 * Internal error class so the CLI shell can distinguish bad-input (exit 2)
 * from genuine pipeline failures (exit 1) without inspecting message text.
 */
export class RiskCheckInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface ShortlistJson {
  shortlist?: unknown;
  candidates?: unknown;
}

function readJsonFile(path: string, label: string): unknown {
  if (!existsSync(path)) {
    throw new RiskCheckInputError("MISSING_FILE", `${label} not found at ${path}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RiskCheckInputError("READ_ERROR", `failed to read ${label} at ${path}: ${message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RiskCheckInputError("PARSE_ERROR", `failed to parse ${label} at ${path}: ${message}`);
  }
}

function loadThresholds(path: string): RiskThresholds {
  const raw = readJsonFile(path, "thresholds");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RiskCheckInputError(
      "INVALID_THRESHOLDS",
      `thresholds JSON must be an object, got ${Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }
  const parsed = RiskThresholdsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RiskCheckInputError(
      "INVALID_THRESHOLDS",
      `thresholds JSON failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function loadShortlistCandidates(path: string): RiskCheckCandidate[] {
  const raw = readJsonFile(path, "shortlist");
  if (raw === null || typeof raw !== "object") {
    throw new RiskCheckInputError(
      "INVALID_SHORTLIST",
      `shortlist JSON must be an object or array, got ${typeof raw}`,
    );
  }
  let arr: unknown;
  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    const obj = raw as ShortlistJson;
    arr = obj.shortlist ?? obj.candidates;
  }
  if (!Array.isArray(arr)) {
    throw new RiskCheckInputError(
      "INVALID_SHORTLIST",
      "shortlist JSON must contain a `shortlist` or `candidates` array (or be an array)",
    );
  }
  const out: RiskCheckCandidate[] = [];
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (!c || typeof c !== "object") {
      throw new RiskCheckInputError(
        "INVALID_SHORTLIST",
        `shortlist[${i}] must be an object, got ${typeof c}`,
      );
    }
    const o = c as Record<string, unknown>;
    if (typeof o.app_id !== "string") {
      throw new RiskCheckInputError(
        "INVALID_SHORTLIST",
        `shortlist[${i}].app_id is required (string)`,
      );
    }
    if (typeof o.store !== "string") {
      throw new RiskCheckInputError(
        "INVALID_SHORTLIST",
        `shortlist[${i}].store is required (string)`,
      );
    }
    if (!Array.isArray(o.markets_active)) {
      throw new RiskCheckInputError(
        "INVALID_SHORTLIST",
        `shortlist[${i}].markets_active is required (array)`,
      );
    }
    if (typeof o.tenure_days_max !== "number") {
      throw new RiskCheckInputError(
        "INVALID_SHORTLIST",
        `shortlist[${i}].tenure_days_max is required (number)`,
      );
    }
    if (typeof o.has_subscription_iap !== "boolean") {
      throw new RiskCheckInputError(
        "INVALID_SHORTLIST",
        `shortlist[${i}].has_subscription_iap is required (boolean)`,
      );
    }
    if (o.dna_class !== null && typeof o.dna_class !== "string") {
      throw new RiskCheckInputError(
        "INVALID_SHORTLIST",
        `shortlist[${i}].dna_class must be a string or null`,
      );
    }
    out.push({
      ...o,
      app_id: o.app_id,
      store: o.store,
      markets_active: o.markets_active.map((m) => String(m)),
      tenure_days_max: o.tenure_days_max,
      has_subscription_iap: o.has_subscription_iap,
      dna_class: o.dna_class as string | null,
    });
  }
  return out;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function renderCsv(annotated: AnnotatedShortlist): string {
  // Mirror the shortlist.csv shape (subset of the most-relevant fields) plus
  // the new risk_* columns. We intentionally do NOT pin to the full
  // shortlist column list because the input may have come from a different
  // shortlist version — keep this self-describing and useful in isolation.
  const headers = [
    "rank",
    "app_id",
    "store",
    "title",
    "score",
    "dna_class",
    "publisher_name",
    "markets_active",
    "tenure_days_max",
    "best_rank",
    "has_subscription_iap",
    "iap_count",
    "risk_overall",
    "risk_markets_spread",
    "risk_tenure",
    "risk_subscription_iap",
    "risk_supported_markets",
    "risk_clonable_dna",
  ];
  const lines = [headers.join(",")];
  annotated.candidates.forEach((c, i) => {
    const o = c as AnnotatedCandidate & Record<string, unknown>;
    const checkStatus = (name: string): string =>
      c.risk_check.checks.find((x) => x.name === name)?.status ?? "";
    lines.push(
      [
        i + 1,
        c.app_id,
        c.store,
        o.title,
        typeof o.score === "number" ? o.score.toFixed(4) : "",
        c.dna_class,
        o.publisher_name,
        c.markets_active.join("|"),
        c.tenure_days_max,
        o.best_rank,
        c.has_subscription_iap ? 1 : 0,
        o.iap_count,
        c.risk_check.overall,
        checkStatus("markets_spread"),
        checkStatus("tenure"),
        checkStatus("subscription_iap"),
        checkStatus("supported_markets"),
        checkStatus("clonable_dna"),
      ]
        .map(csvEscape)
        .join(","),
    );
  });
  return `${lines.join("\n")}\n`;
}

/**
 * Run the full risk-check flow: load + validate shortlist, load + validate
 * thresholds, evaluate, and serialize. File-IO concerns live here; the
 * evaluator stays pure.
 */
export function runRiskCheck(opts: RiskCheckCliOpts): RiskCheckCliResult {
  const format = opts.format ?? "json";
  const now = opts.now ?? Date.now();
  const logger = pino({
    name: "selection-agent-risk-check",
    level: opts.silent ? "silent" : (process.env.LOG_LEVEL ?? "info"),
  });

  const thresholds = loadThresholds(opts.thresholdsPath);
  const candidates = loadShortlistCandidates(opts.shortlistPath);
  logger.info(
    { candidates: candidates.length, thresholdsPath: opts.thresholdsPath },
    "evaluating candidates",
  );

  const annotated = evaluateShortlist(candidates, thresholds);
  logger.info(annotated.summary, "risk-check summary");

  let body: string;
  if (format === "csv") {
    body = renderCsv(annotated);
  } else {
    body = `${JSON.stringify(
      {
        generated_at_utc: new Date(now).toISOString(),
        thresholds_used: thresholds,
        summary: annotated.summary,
        candidates: annotated.candidates,
      },
      null,
      2,
    )}\n`;
  }

  if (opts.output) {
    writeFileSync(opts.output, body, "utf8");
    logger.info({ output: opts.output }, "wrote annotated shortlist");
  }

  const exitCode: 0 | 1 = annotated.summary.pass > 0 ? 0 : 1;
  return { exitCode, body, thresholds, annotated };
}
