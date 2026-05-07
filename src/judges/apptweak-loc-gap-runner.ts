/**
 * AppTweak locGap judge runner — streaming, resumable, budget-aware.
 *
 * For each AppTweakMetadataRecord:
 *  1. metadata=null → persist locGap=10 (no API call) and continue. AppTweak
 *     422 means the listing has no localized variant in the requested
 *     language; that's the maximum locGap by definition.
 *  2. Already persisted (signal_snapshots row with same (app_id, 'locGap', t,
 *     prompt_version)) → skip silently. Makes re-runs idempotent so a crashed
 *     batch picks up where it left off.
 *  3. Otherwise: adapt → judgeAppText → persist with INSERT OR IGNORE.
 *
 * Cost control:
 *  - `budgetUsd` aborts further API calls once accumulated spend exceeds
 *    the cap. Already-persisted rows are NOT rolled back; the runner
 *    returns `{budgetAborted: true}` so the caller can decide whether to
 *    raise the budget and continue.
 *  - haiku-4-5 is the default model: ~$0.25/Mtok input, ~$1.25/Mtok output.
 *    12,010 records at ~500 input tokens + ~150 output tokens each ≈
 *    ~$2 total. sonnet-4-6 is ~10× more expensive — use only for spot
 *    re-judgement of suspicious results.
 */
import type { Database } from "bun:sqlite";
import pino from "pino";
import type { AppTweakMetadataRecord } from "../ground-truth/apptweak-jsonl.ts";
import { isOk } from "../util/result.ts";
import { adaptApptweakToRawAppData } from "./apptweak-loc-gap-adapter.ts";
import { type JudgeClient, judgeAppText } from "./text-judge.ts";

const logger = pino({
  name: "apptweak-locgap-runner",
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * Base prefix for the AppTweak locGap prompt_version. The full prompt_version
 * is market-specific — a single `app_id` shows up in multiple markets at the
 * same `t0` (one AppTweak listing per market), and Spotify in Indonesia with
 * an Indonesian listing must get a different locGap than Spotify in the US
 * with the English listing. We disambiguate by appending the market code to
 * the prompt_version, which is part of the signal_snapshots PK.
 */
const APPTWEAK_LOCGAP_PROMPT_VERSION_BASE = "v1.0.0-apptweak";

/**
 * Build the full per-market prompt_version. Always use this — the bare base
 * (`v1.0.0-apptweak`) is reserved for legacy rows pre-2026-05-06 which
 * collapsed all markets into one PK and lost market-specificity.
 */
export function apptweakLocGapPromptVersion(market: string): string {
  return `${APPTWEAK_LOCGAP_PROMPT_VERSION_BASE}-${market}`;
}

/**
 * @deprecated Use `apptweakLocGapPromptVersion(market)` — locGap is
 * market-specific. Kept so callers that need the prefix string for SQL
 * filters (e.g. baseline-stats joins) can build the per-market value
 * themselves.
 */
export const APPTWEAK_LOCGAP_PROMPT_VERSION_PREFIX = APPTWEAK_LOCGAP_PROMPT_VERSION_BASE;
const SIGNAL_NAME = "locGap";

const HAIKU_INPUT_USD_PER_MTOK = 0.25;
const HAIKU_OUTPUT_USD_PER_MTOK = 1.25;

export interface RunApptweakLocGapJudgeOptions {
  db: Database;
  records: readonly AppTweakMetadataRecord[];
  client: JudgeClient;
  /** claude-haiku-4-5 by default. */
  model?: string;
  /** Max parallel API calls. Default 4. */
  concurrency?: number;
  /** Hard cap on total spend. Default Infinity. */
  budgetUsd?: number;
  /** Override clock for tests. */
  clock?: () => number;
}

export interface RunApptweakLocGapJudgeStats {
  total: number;
  judged: number;
  skipped: number;
  shortcuts: number;
  errors: number;
  spentUsd: number;
  budgetAborted: boolean;
}

function rowExists(db: Database, app_id: string, market: string, t: number): boolean {
  const r = db
    .prepare<{ c: number }, [string, string, number, string]>(
      `SELECT COUNT(*) AS c FROM signal_snapshots
       WHERE app_id = ? AND signal_name = ? AND t = ? AND llm_prompt_version = ?`,
    )
    .get(app_id, SIGNAL_NAME, t, apptweakLocGapPromptVersion(market));
  return Boolean(r && r.c > 0);
}

function persist(
  db: Database,
  app_id: string,
  market: string,
  t: number,
  value: number,
  model: string | null,
  computed_at: number,
  archived: string | null,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO signal_snapshots (
       app_id, signal_name, t, value,
       llm_model, llm_prompt_version, llm_request_hash,
       llm_response_hash, llm_response_archived, source_urls_json,
       computed_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, '[]', ?)`,
  ).run(
    app_id,
    SIGNAL_NAME,
    t,
    value,
    model,
    apptweakLocGapPromptVersion(market),
    archived,
    computed_at,
  );
}

export async function runApptweakLocGapJudge(
  opts: RunApptweakLocGapJudgeOptions,
): Promise<RunApptweakLocGapJudgeStats> {
  const stats: RunApptweakLocGapJudgeStats = {
    total: opts.records.length,
    judged: 0,
    skipped: 0,
    shortcuts: 0,
    errors: 0,
    spentUsd: 0,
    budgetAborted: false,
  };
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const budgetUsd = opts.budgetUsd ?? Number.POSITIVE_INFINITY;
  const clock = opts.clock ?? Date.now;
  const model = opts.model ?? "claude-haiku-4-5-20251001";

  const queue = [...opts.records];
  let aborted = false;

  async function worker(): Promise<void> {
    while (queue.length > 0 && !aborted) {
      const r = queue.shift();
      if (!r) return;
      if (rowExists(opts.db, r.app_id, r.market, r.t0)) {
        stats.skipped += 1;
        continue;
      }
      if (r.metadata === null) {
        persist(opts.db, r.app_id, r.market, r.t0, 10, null, clock(), null);
        stats.shortcuts += 1;
        stats.judged += 1;
        continue;
      }
      const ra = adaptApptweakToRawAppData(r);
      if (!ra) {
        stats.errors += 1;
        continue;
      }
      if (stats.spentUsd >= budgetUsd) {
        aborted = true;
        stats.budgetAborted = true;
        return;
      }
      const result = await judgeAppText({
        app: ra,
        client: opts.client,
        model,
        onTokenUsage: (u) => {
          stats.spentUsd +=
            (u.input * HAIKU_INPUT_USD_PER_MTOK + u.output * HAIKU_OUTPUT_USD_PER_MTOK) / 1_000_000;
        },
      });
      if (!isOk(result)) {
        stats.errors += 1;
        logger.warn(
          { app_id: r.app_id, market: r.market, err: result.error.message },
          "judge failed",
        );
        continue;
      }
      persist(
        opts.db,
        r.app_id,
        r.market,
        r.t0,
        result.value.locGapScore,
        model,
        clock(),
        JSON.stringify(result.value),
      );
      stats.judged += 1;
      if (stats.spentUsd >= budgetUsd) {
        aborted = true;
        stats.budgetAborted = true;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return stats;
}
