import { describe, expect, test } from "bun:test";
import { RawAppDataSchema } from "../../src/types/raw-app-data.ts";

const baseValid = {
  store: "apple" as const,
  appId: "com.example.app",
  market: "us",
  name: "Example",
  developer: "Example Co.",
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
  scrapedAt: "2026-04-29T12:00:00.000Z",
};

describe("RawAppDataSchema — datetime offset tolerance (regression)", () => {
  test("accepts releaseDate with timezone offset (chart list format)", () => {
    // Apple's chart list() returns timestamps with TZ offsets like
    // "2023-05-18T00:00:00-07:00". Earlier we used z.string().datetime()
    // which rejects offsets — that silently killed every snapshot write
    // against real Apple data. Lock the tolerance with this test.
    const r = RawAppDataSchema.safeParse({
      ...baseValid,
      releaseDate: "2023-05-18T00:00:00-07:00",
    });
    expect(r.success).toBe(true);
  });

  test("accepts releaseDate in Z form (per-app endpoint format)", () => {
    const r = RawAppDataSchema.safeParse({
      ...baseValid,
      releaseDate: "2023-05-18T07:00:00Z",
    });
    expect(r.success).toBe(true);
  });

  test("accepts lastUpdated with timezone offset", () => {
    const r = RawAppDataSchema.safeParse({
      ...baseValid,
      lastUpdated: "2026-04-26T23:09:12+02:00",
    });
    expect(r.success).toBe(true);
  });

  test("rejects clearly malformed datetime strings", () => {
    const r = RawAppDataSchema.safeParse({
      ...baseValid,
      releaseDate: "not-a-date",
    });
    expect(r.success).toBe(false);
  });
});

describe("RawAppDataSchema — trackId field (M7)", () => {
  test("accepts a string trackId (Apple numeric id)", () => {
    const r = RawAppDataSchema.safeParse({ ...baseValid, trackId: "1234567890" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.trackId).toBe("1234567890");
  });

  test("accepts an explicit null trackId (Google entries always carry null)", () => {
    const r = RawAppDataSchema.safeParse({ ...baseValid, trackId: null });
    expect(r.success).toBe(true);
    expect(r.success && r.data.trackId).toBeNull();
  });

  test("missing trackId defaults to null (M5/M6 snapshot row back-compat)", () => {
    // Existing app_snapshot rows persisted before M7 lack `trackId`. The
    // schema's `.default(null)` makes them parse cleanly with trackId=null,
    // so velocity scoring against pre-M7 history doesn't blow up.
    const r = RawAppDataSchema.safeParse(baseValid);
    expect(r.success).toBe(true);
    expect(r.success && r.data.trackId).toBeNull();
  });

  test("rejects a non-string non-null trackId", () => {
    const r = RawAppDataSchema.safeParse({ ...baseValid, trackId: 12345 });
    expect(r.success).toBe(false);
  });
});

import { mapToRawAppData } from "../../src/scrapers/api.ts";

describe("mapToRawAppData — Google human-readable date coercion (M7 smoke regression)", () => {
  test("Google's 'Apr 21, 2014' format coerces to ISO 8601 (was: silently killed snapshot writes)", () => {
    // The first M7 smoke run caught this: google-play-scraper returns
    // released as a human-readable string (e.g., "Apr 21, 2014"), not ISO
    // 8601. RawAppDataSchema.releaseDate is `z.string().datetime({ offset
    // }).nullable()` — the human format threw, writeSnapshot fell through
    // to the catch, and Track B silently wrote zero Google rows. We now
    // coerce at mapToRawAppData via Date.parse and emit ISO 8601 Z-form.
    const raw = mapToRawAppData({
      store: "google",
      market: "us",
      rank: 1,
      entry: {
        appId: "com.example.app",
        title: "Example",
        released: "Apr 21, 2014",
        updated: "Mar 15, 2026",
      },
      scrapedAtIso: "2026-04-29T12:00:00.000Z",
    });
    expect(raw.releaseDate).not.toBeNull();
    expect(raw.lastUpdated).not.toBeNull();
    // Coerced output round-trips through the schema cleanly (no validation
    // error → snapshot writes succeed).
    const parsed = RawAppDataSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  test("ISO 8601 with offset (Apple chart) passes through unchanged", () => {
    const raw = mapToRawAppData({
      store: "apple",
      market: "us",
      rank: 1,
      entry: {
        appId: "com.x.y",
        released: "2023-05-18T00:00:00-07:00",
        updated: "2026-04-26T23:09:12+02:00",
      },
      scrapedAtIso: "2026-04-29T12:00:00.000Z",
    });
    expect(raw.releaseDate).toBe("2023-05-18T00:00:00-07:00");
    expect(raw.lastUpdated).toBe("2026-04-26T23:09:12+02:00");
  });

  test("unparseable date string → null (no throw)", () => {
    const raw = mapToRawAppData({
      store: "google",
      market: "us",
      rank: 1,
      entry: { appId: "com.x.y", released: "not a date at all", updated: "" },
      scrapedAtIso: "2026-04-29T12:00:00.000Z",
    });
    expect(raw.releaseDate).toBeNull();
    expect(raw.lastUpdated).toBeNull();
  });

  test("undefined released/updated → null", () => {
    const raw = mapToRawAppData({
      store: "google",
      market: "us",
      rank: 1,
      entry: { appId: "com.x.y" },
      scrapedAtIso: "2026-04-29T12:00:00.000Z",
    });
    expect(raw.releaseDate).toBeNull();
    expect(raw.lastUpdated).toBeNull();
  });
});
