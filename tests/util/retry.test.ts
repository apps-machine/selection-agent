import { describe, expect, test } from "bun:test";
import {
  isTransientHttpError,
  retryWithBackoff,
} from "../../src/util/retry.ts";

describe("retryWithBackoff", () => {
  test("returns value on first success", async () => {
    let calls = 0;
    const result = await retryWithBackoff(async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries on failure up to maxAttempts", async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "recovered";
      },
      { initialDelayMs: 1, maxDelayMs: 5, jitter: false, maxAttempts: 3 },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("throws after exhausting retries", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new Error("permanent");
        },
        { initialDelayMs: 1, maxDelayMs: 5, jitter: false, maxAttempts: 2 },
      ),
    ).rejects.toThrow("permanent");
    expect(calls).toBe(2);
  });

  test("respects shouldRetry returning false", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls++;
          throw new Error("hard fail");
        },
        {
          initialDelayMs: 1,
          maxDelayMs: 5,
          jitter: false,
          maxAttempts: 5,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow("hard fail");
    expect(calls).toBe(1);
  });

  test("calls onRetry between attempts", async () => {
    const events: number[] = [];
    let calls = 0;
    await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 2) throw new Error("once");
        return "done";
      },
      {
        initialDelayMs: 1,
        maxDelayMs: 5,
        jitter: false,
        maxAttempts: 3,
        onRetry: (_e, attempt) => events.push(attempt),
      },
    );
    expect(events).toEqual([1]);
  });

  test("backoff grows exponentially without jitter", async () => {
    const delays: number[] = [];
    let calls = 0;
    try {
      await retryWithBackoff(
        async () => {
          calls++;
          throw new Error("x");
        },
        {
          initialDelayMs: 10,
          maxDelayMs: 1000,
          jitter: false,
          maxAttempts: 4,
          onRetry: (_e, _a, delay) => delays.push(delay),
        },
      );
    } catch {}
    expect(delays).toEqual([10, 20, 40]);
  });
});

describe("isTransientHttpError", () => {
  test("flags 429 status", () => {
    expect(isTransientHttpError({ status: 429 })).toBe(true);
  });
  test("flags 503 status", () => {
    expect(isTransientHttpError({ status: 503 })).toBe(true);
  });
  test("flags 500 status", () => {
    expect(isTransientHttpError({ statusCode: 500 })).toBe(true);
  });
  test("flags nested response.status", () => {
    expect(isTransientHttpError({ response: { status: 502 } })).toBe(true);
  });
  test("does not flag 404", () => {
    expect(isTransientHttpError({ status: 404 })).toBe(false);
  });
  test("flags ECONNRESET messages", () => {
    expect(isTransientHttpError(new Error("ECONNRESET on socket"))).toBe(true);
  });
  test("flags ETIMEDOUT", () => {
    expect(isTransientHttpError({ message: "ETIMEDOUT" })).toBe(true);
  });
  test("rejects null/undefined/non-objects", () => {
    expect(isTransientHttpError(null)).toBe(false);
    expect(isTransientHttpError(undefined)).toBe(false);
    expect(isTransientHttpError("plain string")).toBe(false);
  });
});
