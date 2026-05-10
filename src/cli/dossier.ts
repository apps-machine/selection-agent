/**
 * `selection-agent dossier` — Stage 5 discovery dossier generator
 * (Runbook-Discovery).
 *
 * Reads a shortlist JSON (output of `selection-agent shortlist`), looks up
 * a candidate row by `<app_id>:<store>`, and writes a populated dossier
 * markdown document to disk. The default template is generic; pass
 * `--template <path>` to use a project-specific template using the same
 * `{{token}}` substitution surface.
 *
 * Exit codes:
 *   0 — dossier written
 *   1 — candidate not found in shortlist OR output write failure
 *   2 — invalid args / missing files / parse error
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";
import {
  buildDossier,
  findCandidate,
  parseCandidateRef,
  type Shortlist,
  type ShortlistCandidate,
  type Store,
} from "../path-e/dossier.ts";

export interface DossierCliOpts {
  /** Path to the shortlist JSON (output of `selection-agent shortlist`). */
  shortlistPath: string;
  /** Candidate reference in the form `<app_id>:<store>`. */
  candidateRef: string;
  /** Slug used in the dossier title + filename. */
  slug: string;
  /** Optional path to a user-supplied template markdown file. */
  templatePath?: string;
  /**
   * Output path for the dossier. When unset, defaults to
   * `<slug>-dossier-<YYYY-MM-DD>.md` in the current working directory.
   */
  output?: string;
  /** Override "now" so tests + reproducible runs can pin the date. */
  now?: Date;
  /** Suppress logger output (used by tests). */
  silent?: boolean;
}

export interface DossierCliResult {
  exitCode: 0 | 1 | 2;
  dossierPath?: string;
}

/**
 * Internal error class so the CLI shell can distinguish bad-input (exit 2)
 * from genuine pipeline failures (exit 1) without inspecting message text.
 */
export class DossierInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function readJsonFile(path: string, label: string): unknown {
  if (!existsSync(path)) {
    throw new DossierInputError("MISSING_FILE", `${label} not found at ${path}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DossierInputError("READ_ERROR", `failed to read ${label} at ${path}: ${message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DossierInputError("PARSE_ERROR", `failed to parse ${label} at ${path}: ${message}`);
  }
}

function readTextFile(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new DossierInputError("MISSING_FILE", `${label} not found at ${path}`);
  }
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DossierInputError("READ_ERROR", `failed to read ${label} at ${path}: ${message}`);
  }
}

function loadShortlist(path: string): Shortlist | ShortlistCandidate[] {
  const raw = readJsonFile(path, "shortlist");
  if (raw === null || typeof raw !== "object") {
    throw new DossierInputError(
      "INVALID_SHORTLIST",
      `shortlist JSON must be an object or array, got ${typeof raw}`,
    );
  }
  if (Array.isArray(raw)) {
    return raw as ShortlistCandidate[];
  }
  return raw as Shortlist;
}

/**
 * Run the dossier generator end-to-end. File-IO concerns live here; the
 * dossier rendering stays pure (see `src/path-e/dossier.ts`).
 */
export function runDossier(opts: DossierCliOpts): DossierCliResult {
  const now = opts.now ?? new Date();
  // Default to "warn" so structured JSON logs don't leak to stderr (and don't
  // expose the user's hostname/pid) on every CLI run. End-users opt in to
  // verbose logs via LOG_LEVEL=info or LOG_LEVEL=debug.
  const logger = pino({
    name: "selection-agent-dossier",
    level: opts.silent ? "silent" : (process.env.LOG_LEVEL ?? "warn"),
  });

  const { app_id, store } = parseCandidateRef(opts.candidateRef);
  const shortlist = loadShortlist(opts.shortlistPath);
  const candidate = findCandidate(shortlist, app_id, store);
  if (!candidate) {
    throw new DossierNotFoundError(
      "CANDIDATE_NOT_FOUND",
      `candidate ${app_id}:${store} not found in shortlist at ${opts.shortlistPath}`,
    );
  }

  const template = opts.templatePath ? readTextFile(opts.templatePath, "template") : undefined;

  const md = buildDossier({
    slug: opts.slug,
    candidate,
    shortlistSource: opts.shortlistPath,
    template,
    now,
  });

  const dossierPath = resolve(opts.output ?? defaultOutputPath(opts.slug, now));
  try {
    writeFileSync(dossierPath, md, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DossierWriteError(
      "WRITE_ERROR",
      `failed to write dossier to ${dossierPath}: ${message}`,
    );
  }
  logger.info({ dossierPath, app_id, store, slug: opts.slug }, "wrote dossier");

  return { exitCode: 0, dossierPath };
}

/**
 * Subclass for "candidate not found" — caller maps this to exit 1
 * (the input was syntactically valid but referenced an absent row).
 */
export class DossierNotFoundError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Subclass for output-write failures (also exit 1, distinct from bad input). */
export class DossierWriteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function defaultOutputPath(slug: string, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  return `${slug}-dossier-${date}.md`;
}

// Re-exported for downstream callers that want to drive `parseCandidateRef`
// (and the `Store` type) from the CLI module without reaching into path-e.
export { parseCandidateRef } from "../path-e/dossier.ts";
export type { Store };
