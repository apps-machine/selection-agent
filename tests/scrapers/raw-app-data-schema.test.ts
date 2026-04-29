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
