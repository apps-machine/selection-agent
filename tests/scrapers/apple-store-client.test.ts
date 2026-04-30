import { describe, expect, test } from "bun:test";
import { mapToRawAppData } from "../../src/scrapers/api.ts";
import {
  type AppleScraperLib,
  createAppleScraperLib,
} from "../../src/scrapers/apple-store-client.ts";
import appDetailFixture from "../fixtures/apple-app-detail.json" with { type: "json" };
import grossingFixture from "../fixtures/apple-grossing-us.json" with { type: "json" };

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
    // The lib's `list()` validates against its own enum *values* (e.g.
    // "topGrossing" / "topgrossingapplications"), not the key string. We
    // look up the value on `lib.collection` before passing it through.
    expect(captured.args?.collection).toBe("topGrossing");
    expect(captured.args?.country).toBe("us");
    expect(captured.args?.num).toBe(200);
    expect(entries.length).toBe(2);
    expect(entries[0]?.appId).toBe("com.calai.calai");
    expect(entries[0]?.title).toBe("Cal AI: Calorie Tracker");
  });

  test("fetchChart surfaces numeric trackId separately from bundle-ID appId (M7)", async () => {
    // Apple's chart list() returns BOTH `id` (numeric trackId, e.g.
    // 1604029305) AND `appId` (bundle ID, e.g. "com.calai.calai"). Pre-M7
    // we squashed both into `appId` so the brief's link generator received
    // only the bundle ID and produced /id<bundleID> URLs that 404'd. M7
    // surfaces trackId separately so appStoreLink can route correctly.
    const client = createAppleScraperLib(makeMock());
    const entries = await client.fetchChart({
      store: "apple",
      market: "US",
      collection: "top-grossing",
      limit: 200,
    });
    expect(entries[0]?.appId).toBe("com.calai.calai");
    expect(entries[0]?.trackId).toBe("1604029305");
  });

  test("fetchApp surfaces trackId from the per-app endpoint (M7)", async () => {
    const client = createAppleScraperLib(makeMock());
    const detail = await client.fetchApp({
      store: "apple",
      market: "US",
      appId: "1604029305",
    });
    expect(detail.trackId).toBe("1604029305");
    expect(detail.appId).toBe("com.calai.calai");
  });

  test("mapToRawAppData propagates Apple trackId; Google entries get null", () => {
    const apple = grossingFixture[0]!;
    const rawApple = mapToRawAppData({
      store: "apple",
      market: "us",
      rank: 1,
      // The fixture is the raw Apple shape (id + appId). Pass through the
      // normalizer to get a ChartEntry with trackId surfaced, then map.
      entry: { ...apple, trackId: String(apple.id) },
      scrapedAtIso: "2026-04-29T12:00:00.000Z",
    });
    expect(rawApple.trackId).toBe("1604029305");

    // Google entries don't carry a trackId field at all → mapToRawAppData
    // defaults to null so the link generator picks the play.google.com path.
    const rawGoogle = mapToRawAppData({
      store: "google",
      market: "us",
      rank: 1,
      entry: {
        appId: "com.example.remini",
        title: "Remini",
        description: "AI photo enhancer.",
      },
      scrapedAtIso: "2026-04-29T12:00:00.000Z",
    });
    expect(rawGoogle.trackId).toBeNull();
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

  test("fetchApp routes numeric appId via `id` and bundle-ID appId via `appId` (M7 regression)", async () => {
    // The first M7 demo refresh exposed this: app-store-scraper's `app()`
    // takes EITHER `id` (numeric trackId) OR `appId` (bundle ID). Passing
    // a bundle ID as `id` fails (lib looks it up as a numeric trackId and
    // gets nothing) — 100% Apple enrichment failure across the 10-app
    // demo refresh run. Pin the routing here so a future refactor can't
    // re-flip the keys.
    const captured: Array<Record<string, unknown>> = [];
    const numericLib = makeMock({
      app: async (opts) => {
        captured.push(opts);
        return appDetailFixture;
      },
    });
    const bundleLib = makeMock({
      app: async (opts) => {
        captured.push(opts);
        return appDetailFixture;
      },
    });

    await createAppleScraperLib(numericLib).fetchApp({
      store: "apple",
      market: "US",
      appId: "1604029305", // numeric trackId
    });
    expect(captured[0]?.id).toBe("1604029305");
    expect(captured[0]?.appId).toBeUndefined();

    await createAppleScraperLib(bundleLib).fetchApp({
      store: "apple",
      market: "US",
      appId: "com.calai.calai", // bundle ID
    });
    expect(captured[1]?.appId).toBe("com.calai.calai");
    expect(captured[1]?.id).toBeUndefined();
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
