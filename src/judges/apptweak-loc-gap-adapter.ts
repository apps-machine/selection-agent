/**
 * AppTweak metadata → minimal RawAppData adapter.
 *
 * The locGap text-judge consumes RawAppData; AppTweak gives us a slimmer
 * shape (title/subtitle/description/icon at most). Fields the judge prompt
 * doesn't critically rely on (developer, category, rating, screenshots) are
 * stubbed to safe defaults rather than fetched from a second endpoint.
 *
 * Returns null when metadata is null — that signals the underlying app has
 * NO localized listing in the requested language (AppTweak 422). The caller
 * (apptweak-loc-gap-runner) treats null as locGap=10 (max gap) without
 * spending an API call.
 */
import type { AppTweakMetadataRecord } from "../ground-truth/apptweak-jsonl.ts";
import type { RawAppData, Store } from "../types/raw-app-data.ts";

const STORE_MAP: Record<"apple" | "googleplay", Store> = {
  apple: "apple",
  googleplay: "google",
};

export function adaptApptweakToRawAppData(record: AppTweakMetadataRecord): RawAppData | null {
  if (record.metadata === null) return null;
  const md = record.metadata;
  return {
    store: STORE_MAP[record.store],
    appId: record.app_id,
    trackId: record.store === "apple" ? record.app_id : null,
    market: record.market,
    name: md.title ?? "",
    developer: "unknown",
    category: "unknown",
    rank: null,
    rating: null,
    ratingsCount: null,
    priceUsd: 0,
    iapPresent: false,
    description: md.description ?? "",
    screenshotUrls: [],
    iconUrl: null,
    releaseDate: null,
    lastUpdated: null,
    scrapedAt: new Date(record.t0).toISOString(),
  };
}
