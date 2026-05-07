#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
/**
 * Run the AppTweak locGap LLM judge over data/apptweak-2026-05-04/metadata.jsonl.gz.
 *
 * Idempotent: re-running skips already-persisted rows (signal_snapshots PK
 * includes prompt_version). Budget-capped via --budget-usd.
 *
 * Usage:
 *   APPTWEAK_KEY=... ANTHROPIC_API_KEY=... bun run packages/selection-agent/scripts/locgap-judge-run.ts \
 *     [--db .cache/selection-agent.sqlite] [--limit 100] [--budget-usd 5] \
 *     [--model claude-haiku-4-5-20251001] [--concurrency 4] [--dry-run]
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  type AppTweakMetadataRecord,
  readMetadataJsonl,
} from "../src/ground-truth/apptweak-jsonl.ts";
import { runApptweakLocGapJudge } from "../src/judges/apptweak-loc-gap-runner.ts";
import { runMigrations } from "../src/storage/schema.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DEFAULT_DB = join(ROOT, ".cache", "selection-agent.sqlite");
const DEFAULT_GZ = join(ROOT, "data", "apptweak-2026-05-04", "metadata.jsonl.gz");
const DEFAULT_PLAIN = join(ROOT, "data", "apptweak-2026-05-04", "metadata.jsonl");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1];
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function loadMetadata(): AppTweakMetadataRecord[] {
  if (existsSync(DEFAULT_PLAIN)) {
    return readMetadataJsonl(DEFAULT_PLAIN);
  }
  if (!existsSync(DEFAULT_GZ)) {
    throw new Error(`metadata not found at ${DEFAULT_GZ} or ${DEFAULT_PLAIN}`);
  }
  const text = gunzipSync(readFileSync(DEFAULT_GZ)).toString("utf8");
  writeFileSync(DEFAULT_PLAIN, text, "utf8");
  return readMetadataJsonl(DEFAULT_PLAIN);
}

async function main(): Promise<void> {
  const dbPath = arg("db") ?? DEFAULT_DB;
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const budgetUsd = arg("budget-usd") ? Number(arg("budget-usd")) : Number.POSITIVE_INFINITY;
  const model = arg("model") ?? "claude-haiku-4-5-20251001";
  const concurrency = arg("concurrency") ? Number(arg("concurrency")) : 4;
  const dry = flag("dry-run");

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);

  const allRecords = loadMetadata();
  const records = limit ? allRecords.slice(0, limit) : allRecords;
  process.stdout.write(`Loaded ${records.length} metadata records\n`);

  if (dry) {
    process.stdout.write(`DRY-RUN: would judge ${records.length} records with model=${model}\n`);
    db.close();
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const anthropic = new Anthropic({ apiKey });

  const stats = await runApptweakLocGapJudge({
    db,
    records,
    // biome-ignore lint/suspicious/noExplicitAny: SDK Message type is broadly compatible with local AnthropicMessage shape; cast covers minor drift on both input (Tool.input_schema.type) and output.
    client: { messages: { create: (p) => anthropic.messages.create(p as any) as Promise<any> } },
    model,
    concurrency,
    budgetUsd,
  });
  db.close();
  process.stdout.write(
    `Done — total=${stats.total} judged=${stats.judged} skipped=${stats.skipped} shortcuts=${stats.shortcuts} errors=${stats.errors} spent=$${stats.spentUsd.toFixed(4)} aborted=${stats.budgetAborted}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
