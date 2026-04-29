import type { SnapshotStore } from "../../src/storage/queries.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";
import { SnapshotPayloadSchema } from "../../src/velocity/types.ts";

function shiftDayUtc(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error(`shiftDayUtc: invalid day "${day}"`);
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface SeedSnapshotHistoryOpts {
  store: SnapshotStore;
  apps: RawAppData[];
  /** Number of consecutive UTC days to seed, including `endDay`. */
  days: number;
  /** Most recent UTC day (`YYYY-MM-DD`). Defaults to today UTC. */
  endDay?: string;
  /** Rank on the OLDEST day (interpolates linearly toward `endRank`). Default 60. */
  startRank?: number;
  /** Rank on the NEWEST day (lower = climbed). Default 10. */
  endRank?: number;
  /** Daily delta added to each app's `ratingsCount` starting from the oldest day. Default 100. */
  ratingsPerDay?: number;
  /** Override clock for `scrapedAt` (ms). Default Date.now. */
  now?: () => number;
}

/**
 * Seeds `days` consecutive UTC days of snapshots for `apps`, ending at
 * `endDay` (defaults to today UTC). Each day's `rankOfDay`
 * interpolates linearly from `startRank` (oldest) to `endRank`
 * (most recent). Each day's `ratingsCount` climbs by `ratingsPerDay`
 * starting from the app's seed value on the oldest day.
 *
 * Used by both M5 tests (delta math, idempotency) and M6 pipeline
 * tests (real velocity scores feeding the orchestrator).
 */
export function seedSnapshotHistory(opts: SeedSnapshotHistoryOpts): void {
  const days = opts.days;
  if (days <= 0) throw new Error(`seedSnapshotHistory: days must be > 0, got ${days}`);
  const endDay = opts.endDay ?? todayUtc();
  const startRank = opts.startRank ?? 60;
  const endRank = opts.endRank ?? 10;
  const ratingsPerDay = opts.ratingsPerDay ?? 100;
  const now = (opts.now ?? Date.now)();

  for (let i = 0; i < days; i++) {
    const dayOffset = -(days - 1 - i); // i=0 → oldest, i=days-1 → endDay
    const day = shiftDayUtc(endDay, dayOffset);
    const rank =
      days === 1 ? endRank : Math.round(startRank + ((endRank - startRank) * i) / (days - 1));
    for (const app of opts.apps) {
      const ratingsForDay = app.ratingsCount === null ? null : app.ratingsCount + ratingsPerDay * i;
      const payload = SnapshotPayloadSchema.parse({
        raw: { ...app, ratingsCount: ratingsForDay },
        rankOfDay: rank,
      });
      opts.store.insertSnapshot({
        store: app.store,
        appId: app.appId,
        market: app.market,
        snapshotDay: day,
        payload: JSON.stringify(payload),
        scrapedAt: now,
      });
    }
  }
}
