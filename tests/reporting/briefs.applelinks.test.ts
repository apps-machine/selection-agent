import { describe, expect, test } from "bun:test";
import { appStoreLink } from "../../src/reporting/briefs.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";

function mkApp(args: {
  store: "apple" | "google";
  appId: string;
  trackId?: string | null;
  market?: string;
}): RawAppData {
  return {
    store: args.store,
    appId: args.appId,
    trackId: args.trackId === undefined ? null : args.trackId,
    market: args.market ?? "us",
    name: args.appId,
    developer: "Dev",
    category: "Productivity",
    rank: null,
    rating: null,
    ratingsCount: null,
    priceUsd: 0,
    iapPresent: false,
    description: "",
    screenshotUrls: [],
    iconUrl: null,
    releaseDate: null,
    lastUpdated: null,
    scrapedAt: "2026-04-29T00:00:00.000Z",
  };
}

describe("appStoreLink — Apple trackId regression", () => {
  test("Apple app with trackId → uses numeric trackId in URL", () => {
    const app = mkApp({
      store: "apple",
      appId: "com.google.ios.youtube", // bundle ID
      trackId: "544007664", // YouTube's real trackId
      market: "us",
    });
    expect(appStoreLink(app)).toBe("https://apps.apple.com/us/app/id544007664");
  });

  test("Apple app without trackId → falls back to appId (best-effort)", () => {
    // Older lib versions or chart entries that didn't surface trackId. The
    // fallback may produce a 404 URL but it's the best we have without the
    // numeric id. This regression test is the pre-M7 behavior, kept as a
    // documented fallback rather than a feature.
    const app = mkApp({
      store: "apple",
      appId: "com.google.ios.youtube",
      trackId: null,
      market: "us",
    });
    expect(appStoreLink(app)).toBe("https://apps.apple.com/us/app/idcom.google.ios.youtube");
  });

  test("Apple link respects market", () => {
    const app = mkApp({
      store: "apple",
      appId: "com.x.y",
      trackId: "1234567890",
      market: "jp",
    });
    expect(appStoreLink(app)).toBe("https://apps.apple.com/jp/app/id1234567890");
  });

  test("Google app → unchanged URL format (trackId ignored)", () => {
    const app = mkApp({
      store: "google",
      appId: "com.example.remini",
      trackId: null,
      market: "br",
    });
    expect(appStoreLink(app)).toBe(
      "https://play.google.com/store/apps/details?id=com.example.remini&gl=br",
    );
  });

  test("Google app with trackId set (defensive: should not happen) still uses appId", () => {
    // Defensive: Google entries should never carry a trackId. If one slips
    // through (e.g., a future shared-types refactor), the link must still
    // route to play.google.com using appId, NOT trackId. Otherwise we'd
    // generate /id<trackId> URLs that 404 on the Play Store.
    const app = mkApp({
      store: "google",
      appId: "com.example.remini",
      trackId: "999999",
      market: "us",
    });
    expect(appStoreLink(app)).toBe(
      "https://play.google.com/store/apps/details?id=com.example.remini&gl=us",
    );
  });
});
