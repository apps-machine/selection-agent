import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  CircuitOpenError,
  createPersistedQueue,
  RateLimiter,
  TokenBucket,
  withCircuitBreaker,
  withExpBackoff,
} from "../../src/util/rate-limit.ts";

function makeFakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

describe("TokenBucket", () => {
  test("acquires immediately when bucket has tokens", async () => {
    const clock = makeFakeClock();
    const b = new TokenBucket({
      capacity: 4,
      refillPerSecond: 4,
      clock: clock.now,
      sleep: clock.sleep,
    });
    await b.acquire();
    expect(clock.sleeps).toHaveLength(0); // no wait
  });

  test("burst up to capacity then waits for refill", async () => {
    const clock = makeFakeClock();
    const b = new TokenBucket({
      capacity: 4,
      refillPerSecond: 4, // 250ms per token
      clock: clock.now,
      sleep: clock.sleep,
    });
    // Drain capacity
    for (let i = 0; i < 4; i++) await b.acquire();
    expect(clock.sleeps).toHaveLength(0);

    // 5th acquire must wait ~250ms (1/4 sec)
    await b.acquire();
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(200);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(260);
  });

  test("refills tokens over time (no wait if enough time has passed)", async () => {
    const clock = makeFakeClock();
    const b = new TokenBucket({
      capacity: 4,
      refillPerSecond: 4,
      clock: clock.now,
      sleep: clock.sleep,
    });
    for (let i = 0; i < 4; i++) await b.acquire();
    clock.advance(1000); // 1 second => 4 tokens regenerated, capped at capacity
    for (let i = 0; i < 4; i++) await b.acquire();
    expect(clock.sleeps).toHaveLength(0); // bucket fully refilled, no waits
  });

  test("refill caps at capacity (no overflow)", async () => {
    const clock = makeFakeClock();
    const b = new TokenBucket({
      capacity: 4,
      refillPerSecond: 4,
      clock: clock.now,
      sleep: clock.sleep,
    });
    clock.advance(10_000); // would refill 40 tokens but capacity caps at 4
    for (let i = 0; i < 4; i++) await b.acquire();
    expect(clock.sleeps).toHaveLength(0);
    // 5th must wait
    await b.acquire();
    expect(clock.sleeps).toHaveLength(1);
  });

  test("rejects invalid options", () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 4 })).toThrow();
    expect(() => new TokenBucket({ capacity: 4, refillPerSecond: 0 })).toThrow();
    expect(() => new TokenBucket({ capacity: -1, refillPerSecond: 4 })).toThrow();
  });
});

describe("RateLimiter", () => {
  test("returns the same bucket for the same host", () => {
    const rl = new RateLimiter({ capacity: 4, refillPerSecond: 4 });
    expect(rl.bucket("apple")).toBe(rl.bucket("apple"));
  });

  test("returns different buckets for different hosts", () => {
    const rl = new RateLimiter({ capacity: 4, refillPerSecond: 4 });
    expect(rl.bucket("apple")).not.toBe(rl.bucket("google"));
  });

  test("withLimit awaits acquire then calls fn", async () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1 });
    let called = 0;
    const result = await rl.withLimit("h", async () => {
      called++;
      return 42;
    });
    expect(called).toBe(1);
    expect(result).toBe(42);
  });

  test("withLimit propagates errors from fn", async () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1 });
    await expect(
      rl.withLimit("h", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  test("buckets per host are independent (drain apple does not affect google)", async () => {
    const clock = makeFakeClock();
    const rl = new RateLimiter({
      capacity: 2,
      refillPerSecond: 2,
      clock: clock.now,
      sleep: clock.sleep,
    });
    // drain apple
    for (let i = 0; i < 2; i++) await rl.bucket("apple").acquire();
    // google has full capacity, no wait
    for (let i = 0; i < 2; i++) await rl.bucket("google").acquire();
    expect(clock.sleeps).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// REGRESSION (M2 scrapers): the existing apple-store-client and
// google-play-client tests both import from this module's RateLimiter
// + TokenBucket exports. Re-running the original suite (above) inside
// this file is the regression check — if our v1 additions break the
// pre-existing class API, the burst-then-refill test hangs or throws.
// We also assert here explicitly that the M2 surface area is unchanged.
// ──────────────────────────────────────────────────────────────────────

describe("REGRESSION: M2 scraper rate-limit surface", () => {
  test("RateLimiter + TokenBucket exports remain functions/classes", () => {
    expect(typeof RateLimiter).toBe("function");
    expect(typeof TokenBucket).toBe("function");
    const rl = new RateLimiter({ capacity: 4, refillPerSecond: 4 });
    expect(typeof rl.bucket).toBe("function");
    expect(typeof rl.withLimit).toBe("function");
  });

  test("withLimit still gates the wrapped fn through the bucket (no v1 leakage)", async () => {
    const clock = makeFakeClock();
    const rl = new RateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      clock: clock.now,
      sleep: clock.sleep,
    });
    // 1st call: free.
    await rl.withLimit("h", async () => 1);
    expect(clock.sleeps).toHaveLength(0);
    // 2nd call: must wait ~1000ms (1 token / 1 token-per-second).
    await rl.withLimit("h", async () => 2);
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(900);
  });
});

describe("withCircuitBreaker", () => {
  test("opens after threshold consecutive failures", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new Error("boom");
    };
    const wrapped = withCircuitBreaker(fn, { threshold: 3, halfOpenAfterMs: 1000 });
    // 3 raw failures.
    for (let i = 0; i < 3; i++) {
      await expect(wrapped()).rejects.toThrow("boom");
    }
    expect(calls).toBe(3);
    // 4th: circuit open, fn NOT called.
    await expect(wrapped()).rejects.toThrow(CircuitOpenError);
    expect(calls).toBe(3);
  });

  test("half-open after halfOpenAfterMs (FAKE CLOCK), success closes", async () => {
    let now = 0;
    const clock = () => now;
    let mode: "fail" | "ok" = "fail";
    const fn = async () => {
      if (mode === "fail") throw new Error("down");
      return "recovered";
    };
    const wrapped = withCircuitBreaker(fn, {
      threshold: 2,
      halfOpenAfterMs: 60_000,
      clock,
    });
    // Open the circuit at t=0.
    await expect(wrapped()).rejects.toThrow("down");
    await expect(wrapped()).rejects.toThrow("down");
    // Open: rejects without calling fn.
    await expect(wrapped()).rejects.toThrow(CircuitOpenError);
    // Advance clock past half-open threshold; mode switches to ok.
    now = 60_000;
    mode = "ok";
    const result = await wrapped();
    expect(result).toBe("recovered");
    // Subsequent calls succeed (circuit closed).
    expect(await wrapped()).toBe("recovered");
  });

  test("half-open failure re-opens immediately (don't oscillate)", async () => {
    let now = 0;
    const clock = () => now;
    const fn = async () => {
      throw new Error("still down");
    };
    const wrapped = withCircuitBreaker(fn, {
      threshold: 1,
      halfOpenAfterMs: 1000,
      clock,
    });
    await expect(wrapped()).rejects.toThrow("still down"); // open
    now = 1500;
    // half-open probe fails → re-opens
    await expect(wrapped()).rejects.toThrow("still down");
    // Immediately after, still open.
    await expect(wrapped()).rejects.toThrow(CircuitOpenError);
  });

  test("rejects invalid options", () => {
    expect(() => withCircuitBreaker(async () => 1, { threshold: 0, halfOpenAfterMs: 1 })).toThrow();
    expect(() => withCircuitBreaker(async () => 1, { threshold: 1, halfOpenAfterMs: 0 })).toThrow();
  });
});

describe("withExpBackoff", () => {
  test("retries with exponential delays then succeeds", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "ok";
    };
    const sleeps: number[] = [];
    const wrapped = withExpBackoff(fn, {
      maxAttempts: 4,
      baseDelayMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(await wrapped()).toBe("ok");
    expect(attempts).toBe(3);
    // Slept after attempts 1 and 2 (not after the final success).
    expect(sleeps).toEqual([100, 200]);
  });

  test("re-throws after maxAttempts exhausted", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error("permanent");
    };
    const sleeps: number[] = [];
    const wrapped = withExpBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(wrapped()).rejects.toThrow("permanent");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  test("rejects invalid options", () => {
    expect(() => withExpBackoff(async () => 1, { maxAttempts: 0, baseDelayMs: 1 })).toThrow();
    expect(() => withExpBackoff(async () => 1, { maxAttempts: 1, baseDelayMs: -1 })).toThrow();
  });
});

describe("createPersistedQueue", () => {
  test("enqueue + dequeue + size in FIFO order", () => {
    const db = new Database(":memory:");
    const q = createPersistedQueue(db, "test");
    expect(q.size()).toBe(0);
    q.enqueue({ a: 1 });
    q.enqueue({ a: 2 });
    q.enqueue({ a: 3 });
    expect(q.size()).toBe(3);
    expect(q.dequeue()).toEqual({ a: 1 });
    expect(q.dequeue()).toEqual({ a: 2 });
    expect(q.size()).toBe(1);
    expect(q.dequeue()).toEqual({ a: 3 });
    expect(q.dequeue()).toBeNull();
    expect(q.size()).toBe(0);
    db.close();
  });

  test("multiple queues in same db are isolated", () => {
    const db = new Database(":memory:");
    const a = createPersistedQueue(db, "alpha");
    const b = createPersistedQueue(db, "beta");
    a.enqueue("a-item");
    b.enqueue("b-item");
    expect(a.size()).toBe(1);
    expect(b.size()).toBe(1);
    expect(a.dequeue()).toBe("a-item");
    expect(a.size()).toBe(0);
    expect(b.size()).toBe(1);
    db.close();
  });

  test("survives db close/reopen (crash resume)", () => {
    const path = `/tmp/test-persist-queue-${Date.now()}-${Math.random()}.sqlite`;
    let db = new Database(path, { create: true, readwrite: true });
    const q1 = createPersistedQueue(db, "wayback");
    q1.enqueue({ market: "id", t: 1 });
    q1.enqueue({ market: "vn", t: 2 });
    expect(q1.size()).toBe(2);
    db.close();
    // Reopen with same file path; data persisted.
    db = new Database(path, { readwrite: true });
    const q2 = createPersistedQueue(db, "wayback");
    expect(q2.size()).toBe(2);
    expect(q2.dequeue()).toEqual({ market: "id", t: 1 });
    expect(q2.dequeue()).toEqual({ market: "vn", t: 2 });
    expect(q2.size()).toBe(0);
    db.close();
  });

  test("rejects empty queue name", () => {
    const db = new Database(":memory:");
    expect(() => createPersistedQueue(db, "")).toThrow(/non-empty/i);
    db.close();
  });
});
