import { describe, expect, test } from "bun:test";
import { resilient, type ResilientCache } from "../../src/util/resilient.ts";

function makeCache<T>(initial?: { value: T; createdAt: number }): ResilientCache<T> & {
  store: { value: T; createdAt: number } | null;
  fresh: boolean;
} {
  let store: { value: T; createdAt: number } | null = initial ?? null;
  let fresh = !!initial;
  return {
    get() {
      return fresh && store ? store.value : null;
    },
    getStale() {
      return store;
    },
    put(value: T) {
      store = { value, createdAt: 1_000 };
      fresh = true;
    },
    get store() {
      return store;
    },
    set store(s) {
      store = s;
    },
    get fresh() {
      return fresh;
    },
    set fresh(f) {
      fresh = f;
    },
  };
}

const fastRetry = { initialDelayMs: 1, maxDelayMs: 5, jitter: false };

describe("resilient", () => {
  test("returns cache-fresh when cache has value", async () => {
    const cache = makeCache({ value: "cached", createdAt: 1_000 });
    const r = await resilient({
      primary: async () => {
        throw new Error("primary should not be called");
      },
      cache,
    });
    expect(r.source).toBe("cache-fresh");
    expect(r.value).toBe("cached");
    expect(r.errors).toEqual([]);
  });

  test("falls through to primary when cache empty", async () => {
    const cache = makeCache<string>();
    const r = await resilient({
      primary: async () => "fresh-from-primary",
      cache,
    });
    expect(r.source).toBe("primary");
    expect(r.value).toBe("fresh-from-primary");
    expect(cache.get()).toBe("fresh-from-primary");
  });

  test("retries primary on transient errors then succeeds", async () => {
    const cache = makeCache<string>();
    let calls = 0;
    const r = await resilient(
      {
        primary: async () => {
          calls++;
          if (calls < 2) {
            const e = new Error("rate limited") as Error & { status?: number };
            e.status = 429;
            throw e;
          }
          return "recovered";
        },
        cache,
      },
      { retry: fastRetry },
    );
    expect(r.source).toBe("primary");
    expect(r.value).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("does not retry on non-transient errors (404)", async () => {
    const cache = makeCache<string>();
    let calls = 0;
    await expect(
      resilient(
        {
          primary: async () => {
            calls++;
            const e = new Error("not found") as Error & { status?: number };
            e.status = 404;
            throw e;
          },
          cache,
        },
        { retry: fastRetry },
      ),
    ).rejects.toThrow("not found");
    expect(calls).toBe(1);
  });

  test("falls back to fallback tier when primary exhausts", async () => {
    const cache = makeCache<string>();
    const r = await resilient(
      {
        primary: async () => {
          const e = new Error("blocked") as Error & { status?: number };
          e.status = 429;
          throw e;
        },
        fallback: async () => "fallback-value",
        cache,
      },
      { retry: { ...fastRetry, maxAttempts: 2 } },
    );
    expect(r.source).toBe("fallback");
    expect(r.value).toBe("fallback-value");
    expect(r.errors.length).toBe(1);
  });

  test("returns stale cache when both tiers fail", async () => {
    const cache = makeCache<string>({ value: "stale-value", createdAt: 500 });
    cache.fresh = false;
    const r = await resilient(
      {
        primary: async () => {
          throw new Error("primary down");
        },
        fallback: async () => {
          throw new Error("fallback down");
        },
        cache,
        clock: () => 1500,
      } as Parameters<typeof resilient<string>>[0],
      { retry: { ...fastRetry, maxAttempts: 1 }, clock: () => 1500 },
    );
    expect(r.source).toBe("cache-stale");
    expect(r.value).toBe("stale-value");
    expect(r.staleAgeMs).toBe(1000);
    expect(r.errors.length).toBe(2);
  });

  test("throws when no fallback and no stale cache", async () => {
    const cache = makeCache<string>();
    await expect(
      resilient(
        {
          primary: async () => {
            throw new Error("primary down");
          },
          cache,
        },
        { retry: { ...fastRetry, maxAttempts: 1 } },
      ),
    ).rejects.toThrow("primary down");
  });

  test("caches the fallback value on success", async () => {
    const cache = makeCache<string>();
    await resilient(
      {
        primary: async () => {
          throw new Error("primary fail");
        },
        fallback: async () => "fallback-val",
        cache,
      },
      { retry: { ...fastRetry, maxAttempts: 1 } },
    );
    expect(cache.get()).toBe("fallback-val");
  });

  test("logger receives warn events for failures", async () => {
    const cache = makeCache<string>({ value: "stale", createdAt: 500 });
    cache.fresh = false;
    const events: Array<{ level: string; msg: string }> = [];
    await resilient(
      {
        primary: async () => {
          throw new Error("p");
        },
        cache,
        clock: () => 1500,
      } as Parameters<typeof resilient<string>>[0],
      {
        retry: { ...fastRetry, maxAttempts: 1 },
        logger: (level, msg) => events.push({ level, msg }),
        clock: () => 1500,
      },
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.msg.includes("primary tier failed"))).toBe(true);
    expect(events.some((e) => e.msg.includes("stale cache"))).toBe(true);
  });
});

describe("resilient — isFatalHttpError short-circuit", () => {
  test("does not retry on 403 (auth revoked)", async () => {
    const cache = makeCache<string>();
    let calls = 0;
    await expect(
      resilient(
        {
          primary: async () => {
            calls++;
            const e = new Error("forbidden") as Error & { status?: number };
            e.status = 403;
            throw e;
          },
          cache,
        },
        { retry: { initialDelayMs: 1, maxDelayMs: 5, jitter: false, maxAttempts: 5 } },
      ),
    ).rejects.toThrow("forbidden");
    expect(calls).toBe(1);
  });
});

describe("resilient — maxStaleMs cap", () => {
  test("rejects stale cache older than maxStaleMs", async () => {
    const cache = makeCache<string>({ value: "ancient", createdAt: 0 });
    cache.fresh = false;
    await expect(
      resilient(
        {
          primary: async () => {
            throw new Error("primary down");
          },
          cache,
          clock: () => 10_000,
        } as Parameters<typeof resilient<string>>[0],
        {
          retry: { initialDelayMs: 1, maxDelayMs: 5, jitter: false, maxAttempts: 1 },
          maxStaleMs: 5_000,
          clock: () => 10_000,
        },
      ),
    ).rejects.toThrow("primary down");
  });

  test("accepts stale cache within maxStaleMs", async () => {
    const cache = makeCache<string>({ value: "still-ok", createdAt: 7_000 });
    cache.fresh = false;
    const r = await resilient(
      {
        primary: async () => {
          throw new Error("primary down");
        },
        cache,
        clock: () => 10_000,
      } as Parameters<typeof resilient<string>>[0],
      {
        retry: { initialDelayMs: 1, maxDelayMs: 5, jitter: false, maxAttempts: 1 },
        maxStaleMs: 5_000,
        clock: () => 10_000,
      },
    );
    expect(r.source).toBe("cache-stale");
    expect(r.value).toBe("still-ok");
  });
});
