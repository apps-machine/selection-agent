import { describe, expect, test } from "bun:test";
import { buildCacheKey } from "../../src/storage/cache-key.ts";

describe("buildCacheKey", () => {
  test("joins kind + segments with colons", () => {
    expect(buildCacheKey("chart", "apple", "us", "top-grossing", 200)).toBe(
      "chart:apple:us:top-grossing:200",
    );
  });

  test("encodes colons in user-provided segments to prevent collisions", () => {
    const malicious = "com.evil:chart:apple:us:top-grossing:200";
    const collidingKey = buildCacheKey("app", "google", "br", malicious);
    const chartKey = buildCacheKey(
      "chart",
      "apple",
      "us",
      "top-grossing",
      200,
    );
    expect(collidingKey).not.toBe(chartKey);
    expect(collidingKey).toContain("%3A");
    expect(collidingKey).toBe(
      "app:google:br:com.evil%3Achart%3Aapple%3Aus%3Atop-grossing%3A200",
    );
  });

  test("encodes spaces and unicode safely", () => {
    expect(buildCacheKey("k", "a b")).toContain("a%20b");
    expect(buildCacheKey("k", "ñ")).toContain("%C3%B1");
  });

  test("coerces numeric segments to strings", () => {
    expect(buildCacheKey("k", 42, 3.14)).toBe("k:42:3.14");
  });
});
