import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ZodType } from "zod";
import { ALL_SCHEMAS } from "./schema.ts";
import { assertDiskSpace, MIN_DISK_BYTES_DEFAULT } from "./disk.ts";

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

export class Cache {
  private constructor(
    private readonly db: Database,
    private readonly clock: () => number,
  ) {}

  static open(
    path: string,
    opts: { clock?: () => number; minFreeBytes?: number } = {},
  ): Cache {
    const clock = opts.clock ?? Date.now;
    if (path !== ":memory:") {
      ensureParentDir(path);
      assertDiskSpace(
        dirname(path),
        opts.minFreeBytes ?? MIN_DISK_BYTES_DEFAULT,
      );
    }
    const db = new Database(path, { create: true, strict: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    for (const sql of ALL_SCHEMAS) db.exec(sql);
    return new Cache(db, clock);
  }

  put<T>(key: string, value: T, ttlSeconds: number): void {
    if (ttlSeconds <= 0) {
      throw new Error(`ttlSeconds must be > 0, got ${ttlSeconds}`);
    }
    const now = this.clock();
    const expiresAt = now + ttlSeconds * 1000;
    const payload = JSON.stringify(value);
    this.db
      .prepare(
        `INSERT INTO scrape_cache (cache_key, payload, expires_at, created_at)
         VALUES ($key, $payload, $expires, $now)
         ON CONFLICT(cache_key) DO UPDATE SET
           payload    = excluded.payload,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at`,
      )
      .run({ key, payload, expires: expiresAt, now });
  }

  /**
   * Read a cached value. If `schema` is provided, the parsed JSON is validated
   * against it; on validation failure the row is deleted and `null` is returned
   * (treats it as a stale-format entry that needs rescraping).
   */
  get<T>(key: string, schema?: ZodType<T>): T | null {
    const now = this.clock();
    const row = this.db
      .prepare<{
        payload: string;
        expires_at: number;
      }, { key: string; now: number }>(
        `SELECT payload, expires_at
         FROM scrape_cache
         WHERE cache_key = $key AND expires_at > $now`,
      )
      .get({ key, now });
    if (!row) return null;
    return this.parsePayload<T>(key, row.payload, schema);
  }

  private parsePayload<T>(
    key: string,
    payload: string,
    schema?: ZodType<T>,
  ): T | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.delete(key);
      return null;
    }
    if (!schema) return parsed as T;
    const r = schema.safeParse(parsed);
    if (!r.success) {
      this.delete(key);
      return null;
    }
    return r.data;
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM scrape_cache WHERE cache_key = $key")
      .run({ key });
  }

  getEntry<T>(key: string, schema?: ZodType<T>): CacheEntry<T> | null {
    const now = this.clock();
    const row = this.db
      .prepare<{
        payload: string;
        expires_at: number;
        created_at: number;
      }, { key: string; now: number }>(
        `SELECT payload, expires_at, created_at
         FROM scrape_cache
         WHERE cache_key = $key AND expires_at > $now`,
      )
      .get({ key, now });
    if (!row) return null;
    const value = this.parsePayload<T>(key, row.payload, schema);
    if (value === null) return null;
    return {
      value,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  /** Returns the entry even if expired — useful for stale-fallback on scrape failure. */
  getStale<T>(key: string, schema?: ZodType<T>): CacheEntry<T> | null {
    const row = this.db
      .prepare<{
        payload: string;
        expires_at: number;
        created_at: number;
      }, { key: string }>(
        `SELECT payload, expires_at, created_at
         FROM scrape_cache
         WHERE cache_key = $key`,
      )
      .get({ key });
    if (!row) return null;
    const value = this.parsePayload<T>(key, row.payload, schema);
    if (value === null) return null;
    return {
      value,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  prune(): number {
    const now = this.clock();
    const result = this.db
      .prepare("DELETE FROM scrape_cache WHERE expires_at <= $now")
      .run({ now });
    return Number(result.changes);
  }

  size(): number {
    const row = this.db
      .prepare<{ count: number }, []>("SELECT COUNT(*) as count FROM scrape_cache")
      .get();
    return row?.count ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
