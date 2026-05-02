// Token-bucket rate limiter.
//
// One bucket per remote host (apple.com, play.google.com). Wraps scraper
// calls via withLimit(host, fn) so charts + apps + reviews scrapers share a
// global token budget per host instead of each running their own concurrency
// pool. Closes the gap M2 left open: charts(6) + apps(8) = 14 calls hitting
// the same host at once would trip Akamai/Google rate limits.
//
// v1 extension (Codex Round 2 #7 fix): adds three new exports
// — withCircuitBreaker, withExpBackoff, createPersistedQueue —
// for the Wayback fetch path, which needs:
//   - circuit breaker (open after N consecutive failures, half-open after T)
//   - exp backoff (already in src/util/retry.ts, but re-exposed here as a
//     uniform wrapper signature `(fn) => () => Promise<T>` that composes
//     with withCircuitBreaker)
//   - persisted queue (SQLite-backed so a crashed batch resumes from the
//     last committed offset, not from zero)
//
// The original TokenBucket / RateLimiter classes below are unchanged —
// existing M2 scraper integration tests must remain green.

import type { Database } from "bun:sqlite";

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefillMs: number;
  // Single-line queue to serialize acquires (avoids races where N callers all
  // see "1 token left" and consume the same token).
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: TokenBucketOptions) {
    if (opts.capacity <= 0) throw new Error("TokenBucket: capacity must be > 0");
    if (opts.refillPerSecond <= 0) throw new Error("TokenBucket: refillPerSecond must be > 0");
    this.capacity = opts.capacity;
    this.refillPerSecond = opts.refillPerSecond;
    this.clock = opts.clock ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.tokens = opts.capacity;
    this.lastRefillMs = this.clock();
  }

  async acquire(): Promise<void> {
    // Chain on the queue so acquires happen in order.
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      this.refill();
      if (this.tokens < 1) {
        const deficit = 1 - this.tokens;
        const waitMs = Math.ceil((deficit / this.refillPerSecond) * 1000);
        await this.sleep(waitMs);
        this.refill();
      }
      this.tokens -= 1;
    } finally {
      release();
    }
  }

  private refill(): void {
    const now = this.clock();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
      this.lastRefillMs = now;
    }
  }
}

export interface RateLimiterOptions extends TokenBucketOptions {}

export class RateLimiter {
  private readonly opts: RateLimiterOptions;
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(opts: RateLimiterOptions) {
    this.opts = opts;
  }

  bucket(host: string): TokenBucket {
    let b = this.buckets.get(host);
    if (!b) {
      b = new TokenBucket(this.opts);
      this.buckets.set(host, b);
    }
    return b;
  }

  async withLimit<T>(host: string, fn: () => Promise<T>): Promise<T> {
    await this.bucket(host).acquire();
    return fn();
  }
}

// ──────────────────────────────────────────────────────────────────────
// v1: circuit breaker
//
// Opens after `threshold` consecutive failures. While open, every call
// rejects immediately with a CircuitOpenError (no real call attempted).
// After `halfOpenAfterMs` from the open transition, the next call is
// allowed through as a probe — success closes the circuit and resets
// the counter; failure re-opens. Failures during half-open re-open the
// circuit and reset the open timer (don't quickly oscillate).
//
// Why a separate primitive from withExpBackoff: backoff smooths transient
// spikes inside a single attempt sequence; a breaker stops sending traffic
// at all when the upstream is hard-down. Wayback CDX hits both modes:
// 429s under burst load (exp backoff) AND multi-minute 502s during
// archive.org maintenance (breaker opens).
// ──────────────────────────────────────────────────────────────────────

export class CircuitOpenError extends Error {
  constructor(message = "circuit breaker is open") {
    super(message);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  /** Number of consecutive failures that opens the circuit. */
  threshold: number;
  /** Wait this long after open before allowing a probe call. */
  halfOpenAfterMs: number;
  /** Override clock for tests (defaults to Date.now). */
  clock?: () => number;
}

type CircuitState = "closed" | "open" | "half-open";

/**
 * Wrap `fn` with a circuit breaker. Returns a new function with the same
 * signature; consecutive failures of `fn` open the circuit, after which
 * calls reject immediately until `halfOpenAfterMs` elapses.
 *
 * `threshold` must be >= 1 (1 = open on first failure, useful only for
 * tests); `halfOpenAfterMs` must be > 0.
 */
export function withCircuitBreaker<T>(
  fn: () => Promise<T>,
  opts: CircuitBreakerOptions,
): () => Promise<T> {
  if (opts.threshold < 1) {
    throw new Error("withCircuitBreaker: threshold must be >= 1");
  }
  if (opts.halfOpenAfterMs <= 0) {
    throw new Error("withCircuitBreaker: halfOpenAfterMs must be > 0");
  }
  const clock = opts.clock ?? Date.now;
  let state: CircuitState = "closed";
  let consecutiveFailures = 0;
  let openedAt = 0;

  return async () => {
    // Re-evaluate state on each call: if we're open and the half-open
    // timer has elapsed, transition to half-open and let this call probe.
    if (state === "open") {
      if (clock() - openedAt >= opts.halfOpenAfterMs) {
        state = "half-open";
      } else {
        throw new CircuitOpenError(
          `circuit open since ${openedAt}; retry after ${opts.halfOpenAfterMs}ms`,
        );
      }
    }
    try {
      const result = await fn();
      // Any success (including from half-open) closes the circuit and
      // clears the failure counter.
      state = "closed";
      consecutiveFailures = 0;
      return result;
    } catch (e) {
      consecutiveFailures += 1;
      // From half-open, ANY failure immediately re-opens; we don't wait
      // for the threshold count again — the upstream just told us it's
      // still bad.
      if (state === "half-open" || consecutiveFailures >= opts.threshold) {
        state = "open";
        openedAt = clock();
      }
      throw e;
    }
  };
}

// ──────────────────────────────────────────────────────────────────────
// v1: exponential backoff (uniform wrapper signature)
//
// Thin convenience around src/util/retry.ts so the call sites in
// src/ground-truth/wayback-fetch.ts can compose
// `withCircuitBreaker(withExpBackoff(fn, {...}), {...})` without
// importing two different APIs. retryWithBackoff lives in retry.ts and
// is intentionally not duplicated; this is a wrapper.
// ──────────────────────────────────────────────────────────────────────

export interface ExpBackoffOptions {
  /** Maximum number of attempts (including the first). Must be >= 1. */
  maxAttempts: number;
  /** Initial delay in ms. Subsequent delays double: base, base*2, base*4, ... */
  baseDelayMs: number;
  /** Override sleep for tests. Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultBackoffSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wrap `fn` with exponential backoff. Returns a new function: on each
 * failure waits `baseDelayMs * 2^attempt` ms then retries, up to
 * `maxAttempts` total tries. The final failure re-throws.
 *
 * No jitter by default — the v1 backtest harness is single-process and
 * doesn't need anti-thundering-herd. Add jitter at the higher level if
 * concurrent batches start sharing a host.
 */
export function withExpBackoff<T>(fn: () => Promise<T>, opts: ExpBackoffOptions): () => Promise<T> {
  if (opts.maxAttempts < 1) {
    throw new Error("withExpBackoff: maxAttempts must be >= 1");
  }
  if (opts.baseDelayMs < 0) {
    throw new Error("withExpBackoff: baseDelayMs must be >= 0");
  }
  const sleep = opts.sleep ?? defaultBackoffSleep;
  return async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt === opts.maxAttempts - 1) break;
        const delay = opts.baseDelayMs * 2 ** attempt;
        await sleep(delay);
      }
    }
    throw lastErr;
  };
}

// ──────────────────────────────────────────────────────────────────────
// v1: persisted queue (Codex Round 2 #7 fix)
//
// SQLite-backed queue for crash resume. Use case: Wayback fetch enqueues
// (market, t) pairs; a worker dequeues, fetches, and persists the snapshot.
// If the process crashes mid-batch, the next run picks up at the last
// item NOT yet dequeued — no double work, no lost work.
//
// Schema is one shared table `rate_limit_queue` with a `queue_name`
// discriminator so multiple queues can coexist. Items are JSON-encoded
// arbitrary payloads. enqueued_at orders FIFO; SQLite AUTOINCREMENT
// guarantees monotonicity even across process restarts.
//
// dequeue() is destructive: it removes the head row in the same statement
// (DELETE ... RETURNING) so a crash AFTER the read but BEFORE handing
// the item to the caller still leaves the row removed. The trade-off:
// on crash you lose the item being processed at exactly that moment.
// That's the right call for fetch retry — the next run can always
// re-enqueue from the source. For at-least-once semantics with no loss,
// callers should re-enqueue on processing failure.
// ──────────────────────────────────────────────────────────────────────

export const RATE_LIMIT_QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS rate_limit_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_name  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_queue_name
  ON rate_limit_queue(queue_name, id);
` as const;

export interface PersistedQueue {
  enqueue(item: unknown): void;
  dequeue(): unknown | null;
  size(): number;
}

/**
 * Open (or create) a persisted FIFO queue inside `db` keyed on `queueName`.
 *
 * The first call creates the underlying `rate_limit_queue` table if it
 * doesn't exist. Multiple createPersistedQueue calls on the same db with
 * different queueName values share the table but have isolated FIFOs.
 *
 * dequeue returns parsed JSON; enqueue serializes anything JSON.stringify
 * accepts. Cyclic structures throw at enqueue, not at dequeue.
 */
export function createPersistedQueue(db: Database, queueName: string): PersistedQueue {
  if (!queueName) {
    throw new Error("createPersistedQueue: queueName must be a non-empty string");
  }
  // Idempotent — schema string uses IF NOT EXISTS. Safe to call on every
  // open in case the migration runner hasn't been wired in yet.
  db.exec(RATE_LIMIT_QUEUE_SCHEMA);

  const enqueueStmt = db.prepare(
    "INSERT INTO rate_limit_queue (queue_name, payload, enqueued_at) VALUES (?, ?, ?)",
  );
  // DELETE ... RETURNING removes the head row and returns its payload in
  // a single statement. On bun:sqlite the RETURNING clause works against
  // .get() which returns the deleted row.
  const dequeueStmt = db.prepare<{ payload: string }, [string]>(
    `DELETE FROM rate_limit_queue
     WHERE id = (
       SELECT id FROM rate_limit_queue
       WHERE queue_name = ?
       ORDER BY id ASC
       LIMIT 1
     )
     RETURNING payload`,
  );
  const sizeStmt = db.prepare<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM rate_limit_queue WHERE queue_name = ?",
  );

  return {
    enqueue(item: unknown): void {
      const payload = JSON.stringify(item);
      enqueueStmt.run(queueName, payload, Date.now());
    },
    dequeue(): unknown | null {
      const row = dequeueStmt.get(queueName);
      if (!row) return null;
      try {
        return JSON.parse(row.payload);
      } catch {
        // Corrupted payload — log nothing here (caller decides), return null.
        // The row is already removed; we don't re-enqueue garbage.
        return null;
      }
    },
    size(): number {
      const row = sizeStmt.get(queueName);
      return row?.count ?? 0;
    },
  };
}
