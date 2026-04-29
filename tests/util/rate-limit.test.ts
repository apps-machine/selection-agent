import { describe, expect, test } from "bun:test";
import { RateLimiter, TokenBucket } from "../../src/util/rate-limit.ts";

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
