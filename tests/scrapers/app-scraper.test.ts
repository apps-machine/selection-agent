import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../../src/storage/cache.ts";
import { scrapeApps } from "../../src/scrapers/app-scraper.ts";
import type { AppDetails, ScraperLib } from "../../src/scrapers/api.ts";

function makeStub(detailsByAppId: Record<string, AppDetails>): ScraperLib {
  return {
    fetchChart: async () => [],
    fetchApp: async ({ appId }) => {
      const d = detailsByAppId[appId];
      if (!d) throw new Error(`unknown appId: ${appId}`);
      return d;
    },
  };
}

describe("scrapeApps", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("enriches multiple apps with details", async () => {
    const apple = makeStub({
      "com.x.one": {
        appId: "com.x.one",
        title: "One",
        description: "d1",
        primaryGenre: "Lifestyle",
        score: 4.5,
        ratings: 1000,
      },
      "com.x.two": {
        appId: "com.x.two",
        title: "Two",
        description: "d2",
        primaryGenre: "Productivity",
        score: 4.1,
        ratings: 500,
      },
    });
    const google = makeStub({});
    const r = await scrapeApps(
      [
        { store: "apple", market: "US", appId: "com.x.one", rank: 1 },
        { store: "apple", market: "US", appId: "com.x.two", rank: 2 },
      ],
      {
        cache,
        cacheTtlSeconds: 60,
        clients: { apple, google },
        scrapedAt: () => "2026-04-29T00:00:00.000Z",
      },
    );
    expect(r.outcomes.length).toBe(2);
    expect(r.outcomes[0]?.app.description).toBe("d1");
    expect(r.outcomes[0]?.app.rank).toBe(1);
    expect(r.outcomes[1]?.app.category).toBe("Productivity");
  });

  test("collects per-app failures separately", async () => {
    const apple: ScraperLib = {
      fetchChart: async () => [],
      fetchApp: async ({ appId }) => {
        if (appId === "com.x.broken") throw new Error("404");
        return { appId, title: appId };
      },
    };
    const r = await scrapeApps(
      [
        { store: "apple", market: "US", appId: "com.x.ok" },
        { store: "apple", market: "US", appId: "com.x.broken" },
      ],
      {
        cache,
        cacheTtlSeconds: 60,
        clients: { apple, google: apple },
      },
    );
    expect(r.outcomes.length).toBe(1);
    expect(r.failures[0]?.error.message).toBe("404");
  });
});
