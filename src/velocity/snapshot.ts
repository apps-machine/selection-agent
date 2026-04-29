import type { Cache } from "../storage/cache.ts";
import type { RawAppData } from "../types/raw-app-data.ts";
import { type SnapshotPayload, SnapshotPayloadSchema } from "./types.ts";

export interface WriteSnapshotInput {
  apps: RawAppData[];
  cache: Cache;
  /** UTC date string `YYYY-MM-DD`. Defaults to today (UTC). */
  snapshotDay?: string;
  /** Map of `${store}:${appId}:${market}` → rank-of-day (1-based). */
  rankByKey?: Map<string, number>;
  /** Override clock for tests. Returns epoch ms. */
  now?: () => number;
}

export interface WriteSnapshotResult {
  /** Number of rows newly inserted (UNIQUE constraint not hit). */
  written: number;
  /** Number of rows ignored because `(store, app_id, market, snapshot_day)` was already present. */
  skipped: number;
  /** The UTC `YYYY-MM-DD` snapshot day actually used. */
  day: string;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function rankKey(app: RawAppData): string {
  return `${app.store}:${app.appId}:${app.market}`;
}

/**
 * Writes one row per app into the `app_snapshot` table for a single UTC
 * day. Idempotent: re-running with the same `(store, app_id, market,
 * snapshot_day)` tuple is a no-op (counted under `skipped`). Each row's
 * payload is validated through `SnapshotPayloadSchema` before insert so
 * a malformed `RawAppData` raises before SQLite ever sees it.
 *
 * `snapshotDay` defaults to today's UTC date in `YYYY-MM-DD` form. The
 * UTC choice is deliberate: snapshots roll over on the same calendar
 * boundary regardless of where the cron job runs.
 */
export function writeSnapshot(input: WriteSnapshotInput): WriteSnapshotResult {
  const day = input.snapshotDay ?? todayUtc();
  const now = (input.now ?? Date.now)();
  const store = input.cache.snapshotStore();
  const rankByKey = input.rankByKey;

  let written = 0;
  let skipped = 0;

  for (const app of input.apps) {
    const payload: SnapshotPayload = {
      raw: app,
      rankOfDay: rankByKey?.get(rankKey(app)) ?? null,
    };
    const validated = SnapshotPayloadSchema.parse(payload);
    const inserted = store.insertSnapshot({
      store: app.store,
      appId: app.appId,
      market: app.market,
      snapshotDay: day,
      payload: JSON.stringify(validated),
      scrapedAt: now,
    });
    if (inserted) written += 1;
    else skipped += 1;
  }

  return { written, skipped, day };
}
