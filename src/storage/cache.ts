import { Database } from "bun:sqlite";
import { ALL_SCHEMAS } from "./schema.ts";

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

  static open(path: string, clock: () => number = Date.now): Cache {
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

  get<T>(key: string): T | null {
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
    return JSON.parse(row.payload) as T;
  }

  getEntry<T>(key: string): CacheEntry<T> | null {
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
    return {
      value: JSON.parse(row.payload) as T,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  /** Returns the entry even if expired — useful for stale-fallback on scrape failure. */
  getStale<T>(key: string): CacheEntry<T> | null {
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
    return {
      value: JSON.parse(row.payload) as T,
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
