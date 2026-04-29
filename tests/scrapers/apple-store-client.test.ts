import { describe, expect, test } from "bun:test";
import {
  createAppleScraperLib,
  type AppleScraperLib,
} from "../../src/scrapers/apple-store-client.ts";
import { mapToRawAppData } from "../../src/scrapers/api.ts";
import grossingFixture from "../fixtures/apple-grossing-us.json" with {
  type: "json",
};
import appDetailFixture from "../fixtures/apple-app-detail.json" with {
  type: "json",
};

function makeMock(overrides: Partial<AppleScraperLib> = {}): AppleScraperLib {
  return {
    list: async () => grossingFixture,
    app: async () => appDetailFixture,
    collection: { TOP_GROSSING_IOS: "topGrossing" },
    ...overrides,
  };
}

describe("apple-store-client", () => {
  test("fetchChart maps top-grossing to TOP_GROSSING_IOS and lowercases market", async () => {
    const captured = {
      args: null as null | { collection: string; country: string; num: number },
    };
    const lib = makeMock({
      list: async (opts) => {
        captured.args = opts;
        return grossingFixture;
      },
    });
    const client = createAppleScraperLib(lib);
    const entries = await client.fetchChart({
      store: "apple",
      market: "US",
      collection: "top-grossing",
      limit: 200,
    });
    expect(captured.args?.collection).toBe("TOP_GROSSING_IOS");
    expect(captured.args?.country).toBe("us");
    expect(captured.args?.num).toBe(200);
    expect(entries.length).toBe(2);
    expect(entries[0]?.appId).toBe("com.calai.calai");
    expect(entries[0]?.title).toBe("Cal AI: Calorie Tracker");
  });

  test("fetchApp returns enriched details with inAppPurchases", async () => {
    const client = createAppleScraperLib(makeMock());
    const detail = await client.fetchApp({
      store: "apple",
      market: "US",
      appId: "1604029305",
    });
    expect(detail.appId).toBe("com.calai.calai");
    expect(detail.description).toContain("AI-powered");
    expect(detail.inAppPurchases).toBe(true);
  });

  test("rejects non-apple store query", async () => {
    const client = createAppleScraperLib(makeMock());
    await expect(
      client.fetchChart({
        store: "google",
        market: "US",
        collection: "top-grossing",
        limit: 50,
      }),
    ).rejects.toThrow("non-apple query");
  });

  test("rejects unsupported collection", async () => {
    const client = createAppleScraperLib(makeMock());
    await expect(
      client.fetchChart({
        store: "apple",
        market: "US",
        collection: "top-grossing-magic" as never,
        limit: 50,
      }),
    ).rejects.toThrow("unsupported apple collection");
  });

  test("mapToRawAppData applies rank from chart position", () => {
    const apple = grossingFixture[0]!;
    const raw = mapToRawAppData({
      store: "apple",
      market: "US",
      rank: 1,
      entry: {
        appId: apple.appId,
        title: apple.title,
        developer: apple.developer,
        primaryGenre: apple.primaryGenre,
        price: apple.price,
        currency: apple.currency,
        free: apple.free,
        score: apple.score,
        reviews: apple.reviews,
        ratings: apple.ratings,
        icon: apple.icon,
        screenshots: apple.screenshots,
        released: apple.released,
        updated: apple.updated,
      },
      scrapedAtIso: "2026-04-29T00:00:00.000Z",
    });
    expect(raw.store).toBe("apple");
    expect(raw.rank).toBe(1);
    expect(raw.priceUsd).toBe(0);
    expect(raw.iapPresent).toBe(false);
    expect(raw.screenshotUrls).toHaveLength(2);
  });
});
