import pino from "pino";
import type { Cache } from "../storage/cache.ts";
import type { VelocityScoreInput } from "./types.ts";
import { SnapshotPayloadSchema } from "./types.ts";

export type { VelocityScoreInput } from "./types.ts";

export interface GetVelocityScoreArgs extends VelocityScoreInput {
  cache: Cache;
}

const logger = pino({
  name: "velocity",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_BASELINE_DAYS = 14;

/** Shifts a UTC `YYYY-MM-DD` day by `deltaDays` (negative = earlier). */
function shiftDayUtc(day: string, deltaDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error(`shiftDayUtc: invalid day string "${day}", expected YYYY-MM-DD`);
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

/**
 * Computes a 0-10 velocity sub-score for a single app from the daily
 * snapshots accumulated in the `app_snapshot` table. Returns `null`
 * when fewer than `baselineDays` *valid* rows exist in the window —
 * the composite scorer then flips to `WEIGHTS_NO_VELOCITY` and the app
 * is judged on Track A signals alone.
 *
 * Algorithm (delta-based, cheap, computed on the fly):
 *   - rankScore = clamp01_to_10((rankOldest - rankNewest) / 50 * 10)
 *     positive = climbing the chart
 *   - ratingsScore = clamp01_to_10((ΔratingsCount / baselineDays /
 *     max(ratingsCountOldest, 100)) * 1000)
 *   - composite = 0.6 * rankScore + 0.4 * ratingsScore, clamped 0-10
 *
 * Either sub-score contributes 0 when its underlying field is null in
 * the oldest or newest valid row. This keeps the score defined when
 * one signal is partially observable instead of collapsing to null.
 *
 * Critical: a single corrupt payload row is logged at `debug` and
 * skipped. Without that log, a bad row would silently mask the
 * velocity signal forever with zero observability.
 */
export function getVelocityScore(args: GetVelocityScoreArgs): number | null {
  const baselineDays = args.baselineDays ?? DEFAULT_BASELINE_DAYS;
  if (baselineDays <= 0) {
    throw new Error(`getVelocityScore: baselineDays must be > 0, got ${baselineDays}`);
  }
  const asOf = args.asOf ?? todayUtc();
  const startDay = shiftDayUtc(asOf, -baselineDays + 1);

  const store = args.cache.snapshotStore();
  const rows = store.selectSnapshotRange({
    store: args.store,
    appId: args.appId,
    market: args.market,
    startDay,
    endDay: asOf,
  });

  const valid: Array<{
    snapshot_day: string;
    rankOfDay: number | null;
    ratingsCount: number | null;
  }> = [];

  for (const row of rows) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(row.payload);
    } catch {
      logger.debug(
        {
          store: args.store,
          appId: args.appId,
          market: args.market,
          snapshot_day: row.snapshot_day,
          reason: "json-parse",
        },
        "velocity: discarding corrupt snapshot row",
      );
      continue;
    }
    const result = SnapshotPayloadSchema.safeParse(parsedJson);
    if (!result.success) {
      logger.debug(
        {
          store: args.store,
          appId: args.appId,
          market: args.market,
          snapshot_day: row.snapshot_day,
          reason: "schema-mismatch",
        },
        "velocity: discarding corrupt snapshot row",
      );
      continue;
    }
    valid.push({
      snapshot_day: row.snapshot_day,
      rankOfDay: result.data.rankOfDay,
      ratingsCount: result.data.raw.ratingsCount,
    });
  }

  if (valid.length < baselineDays) return null;

  const oldest = valid[0]!;
  const newest = valid[valid.length - 1]!;

  let rankScore = 0;
  if (oldest.rankOfDay !== null && newest.rankOfDay !== null) {
    const delta = oldest.rankOfDay - newest.rankOfDay;
    rankScore = clampScore((delta / 50) * 10);
  }

  let ratingsScore = 0;
  if (oldest.ratingsCount !== null && newest.ratingsCount !== null) {
    const base = Math.max(oldest.ratingsCount, 100);
    const ratio = (newest.ratingsCount - oldest.ratingsCount) / baselineDays / base;
    ratingsScore = clampScore(ratio * 1000);
  }

  return clampScore(0.6 * rankScore + 0.4 * ratingsScore);
}
