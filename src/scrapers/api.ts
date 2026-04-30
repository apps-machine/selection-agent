import type { RawAppData, Store } from "../types/raw-app-data.ts";

/** Subset of Apple App Store / Google Play list() entries we map to RawAppData. */
export interface ChartEntry {
  appId: string;
  /**
   * Apple-only numeric track id. Apple's `app-store-scraper` returns this as
   * `trackId` (with `id` as an alias on chart entries). The bundle ID is what
   * we put in `appId`. Google entries always carry `undefined`.
   */
  trackId?: string;
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

/**
 * Coerce a date-ish string to ISO 8601 with offset, or `null` on failure.
 *
 * `RawAppDataSchema.releaseDate` / `lastUpdated` are validated with
 * `z.string().datetime({ offset: true })`. Apple chart entries already
 * surface ISO 8601 with offset; Apple per-app endpoints surface ISO 8601 in
 * Z form (the M5/0.5.1 fix made the schema tolerate both). Google Play
 * surfaces a human-readable string like `"Apr 21, 2014"` which Zod rejects
 * — silently killing every Google snapshot write.
 *
 * Strategy: try ISO 8601 first (cheap pass-through if already valid); fall
 * back to `Date.parse` for English locale-formatted strings (covers
 * Google's format); on failure return `null`. We never throw — a bad date
 * is better as null than as a snapshot that silently fails to persist.
 */
function coerceIsoDate(input: string | undefined): string | null {
  if (!input) return null;
  // ISO 8601 with offset (Apple chart) — pass through.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/.test(input)) {
    return input;
  }
  // Anything else: parse via Date and re-emit as Z-form ISO 8601.
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function mapToRawAppData(args: MapToRawArgs): RawAppData {
  const { store, market, rank, entry, scrapedAtIso } = args;
  const category = entry.primaryGenre ?? entry.genre ?? "Unknown";
  const developer = asString(entry.developer);
  const priceUsd =
    typeof entry.price === "number" && (entry.currency === "USD" || entry.free) ? entry.price : 0;
  return {
    store,
    appId: entry.appId,
    trackId: entry.trackId ?? null,
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
    releaseDate: coerceIsoDate(entry.released),
    lastUpdated: coerceIsoDate(entry.updated),
    scrapedAt: scrapedAtIso,
  };
}
