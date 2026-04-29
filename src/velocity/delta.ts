import type { Cache } from "../storage/cache.ts";
import type { VelocityScoreInput } from "./types.ts";

export type { VelocityScoreInput } from "./types.ts";

export interface GetVelocityScoreArgs extends VelocityScoreInput {
  cache: Cache;
}

export function getVelocityScore(_args: GetVelocityScoreArgs): number | null {
  return null;
}
