#!/usr/bin/env bun
/**
 * Path E shortlist generator — thin CLI shim.
 *
 * The pipeline lives in `src/path-e/build-shortlist.ts` so the
 * `selection-agent shortlist` subcommand can reuse it. This script preserves
 * the existing `bun run scripts/path-e/build-shortlist.ts` invocation path
 * for ad-hoc dev runs. Prefer the subcommand for npm consumers:
 *
 *   bun src/cli/index.ts shortlist [--db ...] [--no-llm]
 *
 * Usage:
 *   bun run packages/selection-agent/scripts/path-e/build-shortlist.ts \
 *     [--db .cache/selection-agent.sqlite] \
 *     [--no-llm] (skip LLM clonability hypothesis)
 */

import { join, resolve } from "node:path";
import {
  buildShortlist,
  defaultAnthropicLlmClient,
  type LlmClient,
} from "../../src/path-e/build-shortlist.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const DEFAULT_DB = join(ROOT, ".cache", "selection-agent.sqlite");
const OUT_BASE = join(ROOT, "docs", "planning", "path-e-shortlist");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  if (i === process.argv.length - 1) return "true";
  const next = process.argv[i + 1];
  if (next?.startsWith("--")) return "true";
  return next ?? fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const dbPath = arg("db", DEFAULT_DB) ?? DEFAULT_DB;
  const skipLLM = flag("no-llm");

  let llmClient: LlmClient | undefined;
  if (!skipLLM) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(
        "ANTHROPIC_API_KEY not set — run with --no-llm to skip the clonability classifier",
      );
      process.exit(1);
    }
    llmClient = await defaultAnthropicLlmClient({});
  }

  await buildShortlist({
    dbPath,
    skipLLM,
    llmClient,
    outputDir: OUT_BASE,
    dataRoot: ROOT,
  });
}

await main();
