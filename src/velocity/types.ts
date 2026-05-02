import { z } from "zod";
import { RawAppDataSchema, type Store } from "../types/raw-app-data.ts";

export const SnapshotPayloadSchema = z.object({
  raw: RawAppDataSchema,
  rankOfDay: z.number().int().nullable(),
});
export type SnapshotPayload = z.infer<typeof SnapshotPayloadSchema>;

export interface VelocityScoreInput {
  store: Store;
  appId: string;
  market: string;
  asOf?: string;
  baselineDays?: number;
}

/**
 * One observation in a chart_snapshots-derived rank time-series for a
 * single app. `t` is the captured_at timestamp (unix milliseconds); `rank`
 * is the position 1-200. Used by the v1 smoother + score (independent of
 * the legacy app_snapshot-based delta path).
 */
export interface RankPoint {
  /** Observation timestamp — unix milliseconds (matches chart_snapshots.captured_at). */
  t: number;
  /** Rank on that day, 1-based. Lower = better. */
  rank: number;
}

/** Options for the 30d-smoothing filter. */
export interface SmoothOptions {
  /**
   * Single-day rank delta above this is treated as noise. Defaults to
   * SPIKE_THRESHOLD (80). Lower = more aggressive smoothing.
   */
  spikeThreshold?: number;
}
