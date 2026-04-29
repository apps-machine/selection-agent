import type { Database } from "bun:sqlite";
import type { Store } from "../types/raw-app-data.ts";

export interface SnapshotInsertRow {
  store: Store;
  appId: string;
  market: string;
  /** UTC date string `YYYY-MM-DD`. */
  snapshotDay: string;
  /** JSON-encoded `SnapshotPayload` (validated by the caller). */
  payload: string;
  /** Epoch milliseconds when the row was written. */
  scrapedAt: number;
}

export interface SnapshotRow {
  snapshot_day: string;
  payload: string;
}

/**
 * Thin query layer over the `app_snapshot` table. Constructed from a
 * `Cache` instance via `cache.snapshotStore()` so the velocity layer
 * shares one SQLite connection (and therefore one WAL writer) with the
 * scrape cache. Schema is created by `Cache.open` via `ALL_SCHEMAS`;
 * this class only reads / writes rows, never DDL.
 */
export class SnapshotStore {
  constructor(private readonly db: Database) {}

  /** Returns true if the row was inserted, false if a conflict was ignored. */
  insertSnapshot(row: SnapshotInsertRow): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO app_snapshot (store, app_id, market, snapshot_day, payload, scraped_at)
         VALUES ($store, $appId, $market, $snapshotDay, $payload, $scrapedAt)
         ON CONFLICT(store, app_id, market, snapshot_day) DO NOTHING`,
      )
      .run({
        store: row.store,
        appId: row.appId,
        market: row.market,
        snapshotDay: row.snapshotDay,
        payload: row.payload,
        scrapedAt: row.scrapedAt,
      });
    return Number(result.changes) > 0;
  }

  /**
   * Reads `(snapshot_day, payload)` rows for a single
   * `(store, app_id, market)` triple within `[startDay, endDay]`
   * inclusive, ordered by `snapshot_day` ASC. Both bounds are UTC
   * `YYYY-MM-DD` strings.
   */
  selectSnapshotRange(args: {
    store: Store;
    appId: string;
    market: string;
    startDay: string;
    endDay: string;
  }): SnapshotRow[] {
    return this.db
      .prepare<
        SnapshotRow,
        { store: string; appId: string; market: string; startDay: string; endDay: string }
      >(
        `SELECT snapshot_day, payload
         FROM app_snapshot
         WHERE store = $store AND app_id = $appId AND market = $market
           AND snapshot_day >= $startDay AND snapshot_day <= $endDay
         ORDER BY snapshot_day ASC`,
      )
      .all({
        store: args.store,
        appId: args.appId,
        market: args.market,
        startDay: args.startDay,
        endDay: args.endDay,
      });
  }
}
