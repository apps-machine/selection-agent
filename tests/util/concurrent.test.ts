import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "../../src/util/concurrent.ts";

describe("mapWithConcurrency", () => {
  test("processes all inputs and preserves index order in results array", async () => {
    const inputs = [1, 2, 3, 4, 5];
    const r = await mapWithConcurrency(inputs, 2, async (n) => n * 10);
    expect(r.successes).toEqual([10, 20, 30, 40, 50]);
    expect(r.failures).toEqual([]);
  });

  test("never exceeds concurrency limit", async () => {
    let inFlight = 0;
    let max = 0;
    const inputs = Array.from({ length: 12 }, (_, i) => i);
    await mapWithConcurrency(inputs, 3, async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 1;
    });
    expect(max).toBeLessThanOrEqual(3);
    expect(max).toBeGreaterThan(1);
  });

  test("captures failures alongside successes", async () => {
    const inputs = [1, 2, 3];
    const r = await mapWithConcurrency(inputs, 2, async (n) => {
      if (n === 2) throw new Error(`bad ${n}`);
      return n;
    });
    expect(r.successes).toEqual([1, 3]);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]?.message).toBe("bad 2");
  });

  test("rejects concurrency < 1", () => {
    expect(() => mapWithConcurrency([1], 0, async (n) => n)).toThrow();
  });

  test("handles empty input array", async () => {
    const r = await mapWithConcurrency([], 4, async () => 1);
    expect(r.successes).toEqual([]);
    expect(r.failures).toEqual([]);
  });
});
