// Judge response cache. Wired in at the orchestrator level (M6 pipeline.ts),
// not inside the judge functions themselves: judges stay pure so eval suites
// can bypass the cache without a flag dance.
import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import type { Cache } from "../storage/cache.ts";
import type { Result } from "../util/result.ts";

export const JUDGE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

// Bump when JudgeResult schemas change shape in a way that would let a stale
// cached blob deserialize as the new shape with semantically wrong values.
// The version is folded into the cache key so old entries simply miss.
export const JUDGE_SCHEMA_VERSION = "1";

export interface JudgeCacheKeyInput {
  kind: "text" | "vision";
  model: string;
  appId: string;
  market: string;
  /**
   * SHA256 (hex) of the deterministic input that produced the call:
   * for text-judge → hash of the prompt; for vision-judge → hash of model
   * + screenshot URLs (or pixel-content hashes if available).
   */
  contentDigest: string;
}

export function judgeCacheKey(input: JudgeCacheKeyInput): string {
  const h = createHash("sha256");
  h.update(JUDGE_SCHEMA_VERSION);
  h.update("|");
  h.update(input.kind);
  h.update("|");
  h.update(input.model);
  h.update("|");
  h.update(input.appId);
  h.update("|");
  h.update(input.market);
  h.update("|");
  h.update(input.contentDigest);
  return `judge:${h.digest("hex").slice(0, 32)}`;
}

export interface WithJudgeCacheOptions<T> {
  cache: Cache;
  key: string;
  schema: ZodType<T>;
  factory: () => Promise<Result<T, Error>>;
  ttlSeconds?: number;
  bypass?: boolean;
}

export type WithJudgeCacheResult<T> =
  | { ok: true; value: T; hit: boolean }
  | { ok: false; error: Error };

export async function withJudgeCache<T>(
  opts: WithJudgeCacheOptions<T>,
): Promise<WithJudgeCacheResult<T>> {
  if (!opts.bypass) {
    const cached = opts.cache.get<T>(opts.key, opts.schema);
    if (cached !== null) {
      return { ok: true, value: cached, hit: true };
    }
  }
  const fresh = await opts.factory();
  if (!fresh.ok) {
    return { ok: false, error: fresh.error };
  }
  opts.cache.put(opts.key, fresh.value, opts.ttlSeconds ?? JUDGE_CACHE_TTL_SECONDS);
  return { ok: true, value: fresh.value, hit: false };
}
