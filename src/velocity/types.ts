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
