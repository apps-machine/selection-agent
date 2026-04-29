import { describe, expect, test } from "bun:test";
import { scoreRevenue } from "../../src/scoring/revenue-estimator.ts";

describe("scoreRevenue", () => {
  test("returns 0 when rating is null", () => {
    expect(scoreRevenue({ rating: null, ratingsCount: 10000, market: "us" })).toBe(0);
  });

  test("returns 0 when ratingsCount is null", () => {
    expect(scoreRevenue({ rating: 4.5, ratingsCount: null, market: "us" })).toBe(0);
  });

  test("returns 0 when ratingsCount is 0", () => {
    expect(scoreRevenue({ rating: 4.5, ratingsCount: 0, market: "us" })).toBe(0);
  });

  test("higher signal produces higher score", () => {
    const low = scoreRevenue({ rating: 4.0, ratingsCount: 100, market: "us" });
    const high = scoreRevenue({ rating: 4.5, ratingsCount: 1_000_000, market: "us" });
    expect(high).toBeGreaterThan(low);
  });

  test("same rating and count: high-ARPU market scores higher than low-ARPU market", () => {
    const us = scoreRevenue({ rating: 4.5, ratingsCount: 50_000, market: "us" });
    const br = scoreRevenue({ rating: 4.5, ratingsCount: 50_000, market: "br" });
    expect(us).toBeGreaterThan(br);
  });

  test("score is bounded [0, 10]", () => {
    const s = scoreRevenue({ rating: 5, ratingsCount: 100_000_000, market: "us" });
    expect(s).toBeLessThanOrEqual(10);
    expect(s).toBeGreaterThanOrEqual(0);
  });

  test("score for blockbuster (US, 5M ratings, 4.7) is high (>=8)", () => {
    const s = scoreRevenue({ rating: 4.7, ratingsCount: 5_000_000, market: "us" });
    expect(s).toBeGreaterThanOrEqual(8);
  });

  test("score for indie (US, 500 ratings, 4.0) is low (<=4)", () => {
    const s = scoreRevenue({ rating: 4.0, ratingsCount: 500, market: "us" });
    expect(s).toBeLessThanOrEqual(4);
  });

  test("unknown market falls back to DEFAULT_ARPU (does not throw)", () => {
    const s = scoreRevenue({ rating: 4.5, ratingsCount: 10_000, market: "zz" });
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(10);
  });

  test("market code is case-insensitive", () => {
    const lower = scoreRevenue({ rating: 4.5, ratingsCount: 10_000, market: "us" });
    const upper = scoreRevenue({ rating: 4.5, ratingsCount: 10_000, market: "US" });
    expect(upper).toBe(lower);
  });
});

describe("scoreRevenue — regression: NaN/Infinity guards", () => {
  test("returns 0 when rating is NaN", () => {
    expect(scoreRevenue({ rating: NaN, ratingsCount: 10000, market: "us" })).toBe(0);
  });

  test("returns 0 when ratingsCount is NaN", () => {
    expect(scoreRevenue({ rating: 4.5, ratingsCount: NaN, market: "us" })).toBe(0);
  });

  test("returns 0 when rating is Infinity", () => {
    expect(scoreRevenue({ rating: Infinity, ratingsCount: 1000, market: "us" })).toBe(0);
  });
});
