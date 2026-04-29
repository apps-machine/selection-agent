import { describe, expect, test } from "bun:test";
import { mapToRawAppData } from "../../src/scrapers/api.ts";
import {
  createGoogleScraperLib,
  type GoogleScraperLib,
} from "../../src/scrapers/google-play-client.ts";
import appDetailFixture from "../fixtures/google-app-detail.json" with { type: "json" };
import grossingFixture from "../fixtures/google-grossing-br.json" with { type: "json" };

function makeMock(overrides: Partial<GoogleScraperLib> = {}): GoogleScraperLib {
  return {
    list: async () => grossingFixture,
    app: async () => appDetailFixture,
    collection: { GROSSING: "topgrossing" },
    ...overrides,
  };
}

describe("google-play-client", () => {
  test("fetchChart maps top-grossing to GROSSING + lowercases market", async () => {
    const captured = {
      args: null as null | { collection: string; country: string; num: number },
    };
    const lib = makeMock({
      list: async (opts) => {
        captured.args = opts;
        return grossingFixture;
      },
    });
    const client = createGoogleScraperLib(lib);
    const entries = await client.fetchChart({
      store: "google",
      market: "BR",
      collection: "top-grossing",
      limit: 200,
    });
    expect(captured.args?.collection).toBe("GROSSING");
    expect(captured.args?.country).toBe("br");
    expect(entries[0]?.appId).toBe("com.duolingo.app");
    expect(entries[0]?.description).toContain("Aprenda");
  });

  test("fetchApp detects IAP from offersIAP boolean", async () => {
    const client = createGoogleScraperLib(makeMock());
    const detail = await client.fetchApp({
      store: "google",
      market: "BR",
      appId: "com.duolingo.app",
    });
    expect(detail.inAppPurchases).toBe(true);
  });

  test("rejects non-google store query", async () => {
    const client = createGoogleScraperLib(makeMock());
    await expect(
      client.fetchApp({
        store: "apple",
        market: "BR",
        appId: "x",
      }),
    ).rejects.toThrow("non-google query");
  });

  test("mapToRawAppData handles missing fields gracefully", () => {
    const raw = mapToRawAppData({
      store: "google",
      market: "BR",
      rank: 5,
      entry: { appId: "com.x.y" },
      scrapedAtIso: "2026-04-29T00:00:00.000Z",
    });
    expect(raw.store).toBe("google");
    expect(raw.name).toBe("com.x.y");
    expect(raw.developer).toBe("");
    expect(raw.category).toBe("Unknown");
    expect(raw.rating).toBeNull();
    expect(raw.ratingsCount).toBeNull();
    expect(raw.priceUsd).toBe(0);
  });
});
