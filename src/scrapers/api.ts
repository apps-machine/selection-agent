import type { RawAppData, Store } from "../types/raw-app-data.ts";

/** Subset of Apple App Store / Google Play list() entries we map to RawAppData. */
export interface ChartEntry {
  appId: string;
  title?: string;
  developer?: string | { devId?: string; devName?: string };
  genre?: string;
  primaryGenre?: string;
  price?: number;
  priceText?: string;
  currency?: string;
  free?: boolean;
  score?: number;
  reviews?: number;
  ratings?: number;
  icon?: string;
  description?: string;
  screenshots?: string[];
  released?: string;
  updated?: string;
}

export interface AppDetails extends ChartEntry {
  // Detail lookups typically include description + screenshots + IAP hints.
  inAppPurchases?: boolean;
  iapHints?: string[];
}

export type Collection = "top-grossing" | "top-free" | "top-paid";

export interface ChartQuery {
  store: Store;
  market: string;
  collection: Collection;
  limit: number;
}

export interface AppQuery {
  store: Store;
  market: string;
  appId: string;
}

export interface ScraperLib {
  fetchChart(query: ChartQuery): Promise<ChartEntry[]>;
  fetchApp(query: AppQuery): Promise<AppDetails>;
}

export interface MapToRawArgs {
  store: Store;
  market: string;
  rank: number | null;
  entry: ChartEntry | AppDetails;
  scrapedAtIso: string;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "devName" in value) {
    return String((value as { devName?: unknown }).devName ?? "");
  }
  return "";
}

function detectIap(entry: ChartEntry | AppDetails): boolean {
  if ("inAppPurchases" in entry && typeof entry.inAppPurchases === "boolean") {
    return entry.inAppPurchases;
  }
  if ("iapHints" in entry && Array.isArray(entry.iapHints)) {
    return entry.iapHints.length > 0;
  }
  return false;
}

export function mapToRawAppData(args: MapToRawArgs): RawAppData {
  const { store, market, rank, entry, scrapedAtIso } = args;
  const category = entry.primaryGenre ?? entry.genre ?? "Unknown";
  const developer = asString(entry.developer);
  const priceUsd =
    typeof entry.price === "number" && (entry.currency === "USD" || entry.free)
      ? entry.price
      : 0;
  return {
    store,
    appId: entry.appId,
    market,
    name: entry.title ?? entry.appId,
    developer,
    category,
    rank,
    rating: typeof entry.score === "number" ? entry.score : null,
    ratingsCount:
      typeof entry.ratings === "number"
        ? entry.ratings
        : typeof entry.reviews === "number"
        ? entry.reviews
        : null,
    priceUsd,
    iapPresent: detectIap(entry),
    description: entry.description ?? "",
    screenshotUrls: Array.isArray(entry.screenshots) ? entry.screenshots : [],
    iconUrl: entry.icon ?? null,
    releaseDate: entry.released ?? null,
    lastUpdated: entry.updated ?? null,
    scrapedAt: scrapedAtIso,
  };
}
