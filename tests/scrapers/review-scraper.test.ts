import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../../src/storage/cache.ts";
import {
  scrapeReviewPage,
  type ReviewScraperLib,
} from "../../src/scrapers/review-scraper.ts";

describe("scrapeReviewPage", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("normalizes Apple-shaped review payloads", async () => {
    const lib: ReviewScraperLib = {
      fetchReviews: async () => [
        {
          userName: "alice",
          score: 5,
          text: "Love it!",
          date: "2026-04-01",
        },
      ],
    };
    const reviews = await scrapeReviewPage("apple", "US", "com.x.y", 1, {
      cache,
      cacheTtlSeconds: 60,
      client: lib,
    });
    expect(reviews.length).toBe(1);
    expect(reviews[0]).toEqual({
      appId: "com.x.y",
      market: "US",
      store: "apple",
      author: "alice",
      rating: 5,
      text: "Love it!",
      postedAt: "2026-04-01",
    });
  });

  test("normalizes Google-shaped review payloads (rating field)", async () => {
    const lib: ReviewScraperLib = {
      fetchReviews: async () => [
        {
          author: "bob",
          rating: 3,
          text: "meh",
          updated: "2026-03-15",
        },
      ],
    };
    const reviews = await scrapeReviewPage("google", "BR", "com.x.y", 0, {
      cache,
      cacheTtlSeconds: 60,
      client: lib,
    });
    expect(reviews[0]?.author).toBe("bob");
    expect(reviews[0]?.rating).toBe(3);
    expect(reviews[0]?.postedAt).toBe("2026-03-15");
  });

  test("falls back to anonymous + zero-rating + empty text on missing fields", async () => {
    const lib: ReviewScraperLib = {
      fetchReviews: async () => [{}],
    };
    const reviews = await scrapeReviewPage("apple", "US", "com.x.y", 1, {
      cache,
      cacheTtlSeconds: 60,
      client: lib,
    });
    expect(reviews[0]).toEqual({
      appId: "com.x.y",
      market: "US",
      store: "apple",
      author: "anonymous",
      rating: 0,
      text: "",
      postedAt: null,
    });
  });

  test("uses title as text fallback when text is missing", async () => {
    const lib: ReviewScraperLib = {
      fetchReviews: async () => [{ title: "subject only" }],
    };
    const reviews = await scrapeReviewPage("apple", "US", "com.x.y", 1, {
      cache,
      cacheTtlSeconds: 60,
      client: lib,
    });
    expect(reviews[0]?.text).toBe("subject only");
  });

  test("caches review pages and serves cache-fresh on repeat call", async () => {
    let calls = 0;
    const lib: ReviewScraperLib = {
      fetchReviews: async () => {
        calls++;
        return [{ userName: "u", score: 4, text: "ok" }];
      },
    };
    const opts = { cache, cacheTtlSeconds: 60, client: lib };
    await scrapeReviewPage("apple", "US", "com.x.y", 1, opts);
    await scrapeReviewPage("apple", "US", "com.x.y", 1, opts);
    expect(calls).toBe(1);
  });

  test("propagates client errors when no fallback or cache", async () => {
    const lib: ReviewScraperLib = {
      fetchReviews: async () => {
        throw new Error("review fetch failed");
      },
    };
    await expect(
      scrapeReviewPage("apple", "US", "com.x.y", 1, {
        cache,
        cacheTtlSeconds: 60,
        client: lib,
      }),
    ).rejects.toThrow("review fetch failed");
  });

  test("uses fallback when primary fails", async () => {
    const primary: ReviewScraperLib = {
      fetchReviews: async () => {
        throw new Error("primary down");
      },
    };
    const fallback: ReviewScraperLib = {
      fetchReviews: async () => [{ userName: "fb", score: 5, text: "from fallback" }],
    };
    const reviews = await scrapeReviewPage("apple", "US", "com.x.y", 1, {
      cache,
      cacheTtlSeconds: 60,
      client: primary,
      fallback,
    });
    expect(reviews[0]?.text).toBe("from fallback");
  });
});
