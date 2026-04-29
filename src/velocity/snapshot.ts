import type { Cache } from "../storage/cache.ts";
import type { RawAppData } from "../types/raw-app-data.ts";

export interface WriteSnapshotInput {
  apps: RawAppData[];
  cache: Cache;
  snapshotDay?: string;
  rankByKey?: Map<string, number>;
}

export interface WriteSnapshotResult {
  written: number;
  skipped: number;
  day: string;
}

export function writeSnapshot(_input: WriteSnapshotInput): WriteSnapshotResult {
  throw new Error(
    "writeSnapshot: M5 not implemented (signature frozen for parallel M5/M6 worktrees)",
  );
}
