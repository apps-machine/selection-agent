import type { Database } from "bun:sqlite";
import { type JudgeResult, JudgeResultSchema } from "../judges/schemas.ts";

export interface JudgeResultRow {
  runId: string;
  kind: "text" | "vision";
  appId: string;
  store: "apple" | "google";
  market: string;
  result: JudgeResult;
  createdAt: number;
}

export interface InsertJudgeResultArgs {
  runId: string;
  result: JudgeResult;
  createdAt: number;
}

interface RawJudgeResultRow {
  run_id: string;
  store: "apple" | "google";
  app_id: string;
  market: string;
  kind: "text" | "vision";
  payload: string;
  created_at: number;
}

/**
 * Queryable store for judge results, scoped per scan run. Sibling to
 * the content-addressed `withJudgeCache` (M4): the cache answers
 * "have we computed this exact prompt before"; this table answers
 * "what did judges produce in run X". Two writes per judge call is
 * cheap and avoids forcing every report query through a join on
 * content digest.
 */
export class JudgeResultStore {
  constructor(private readonly db: Database) {}

  /** Returns true on insert, false if the UNIQUE constraint blocked. */
  insertJudgeResult(args: InsertJudgeResultArgs): boolean {
    const { runId, result, createdAt } = args;
    const out = this.db
      .prepare(
        `INSERT INTO judge_result (run_id, store, app_id, market, kind, payload, created_at)
         VALUES ($runId, $store, $appId, $market, $kind, $payload, $createdAt)
         ON CONFLICT(run_id, store, app_id, market, kind) DO NOTHING`,
      )
      .run({
        runId,
        store: result.store,
        appId: result.appId,
        market: result.market,
        kind: result.kind,
        payload: JSON.stringify(result),
        createdAt,
      });
    return Number(out.changes) > 0;
  }

  /**
   * All judge rows for a run. Skips rows whose payload no longer
   * round-trips through `JudgeResultSchema` (corrupt or schema-drifted)
   * — matches the velocity layer's "discard, don't crash" stance.
   */
  selectByRunId(runId: string): JudgeResultRow[] {
    const rows = this.db
      .prepare<RawJudgeResultRow, { runId: string }>(
        `SELECT run_id, store, app_id, market, kind, payload, created_at
         FROM judge_result
         WHERE run_id = $runId
         ORDER BY id ASC`,
      )
      .all({ runId });
    const out: JudgeResultRow[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        continue;
      }
      const r = JudgeResultSchema.safeParse(parsed);
      if (!r.success) continue;
      out.push({
        runId: row.run_id,
        kind: row.kind,
        appId: row.app_id,
        store: row.store,
        market: row.market,
        result: r.data,
        createdAt: row.created_at,
      });
    }
    return out;
  }

  /** Most recent `run_id` by `MAX(created_at)`. `null` on empty table. */
  latestRunId(): string | null {
    const row = this.db
      .prepare<{ run_id: string }, []>(
        `SELECT run_id FROM judge_result
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get();
    return row?.run_id ?? null;
  }
}
