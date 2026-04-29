// Token-bucket rate limiter.
//
// One bucket per remote host (apple.com, play.google.com). Wraps scraper
// calls via withLimit(host, fn) so charts + apps + reviews scrapers share a
// global token budget per host instead of each running their own concurrency
// pool. Closes the gap M2 left open: charts(6) + apps(8) = 14 calls hitting
// the same host at once would trip Akamai/Google rate limits.

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
    if (opts.refillPerSecond <= 0)
      throw new Error("TokenBucket: refillPerSecond must be > 0");
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
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsedSec * this.refillPerSecond,
      );
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
