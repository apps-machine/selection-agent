import type { AppDetails, AppQuery, ChartEntry, ChartQuery, ScraperLib } from "./api.ts";

export interface GoogleScraperLib {
  list(opts: { collection: string; country: string; num: number }): Promise<unknown[]>;
  app(opts: { appId: string; country: string }): Promise<unknown>;
  collection: Record<string, string>;
}

const GOOGLE_COLLECTION_MAP: Record<string, string> = {
  "top-grossing": "GROSSING",
  "top-free": "TOP_FREE",
  "top-paid": "TOP_PAID",
};

function normalizeGoogleEntry(raw: unknown): ChartEntry {
  const o = raw as Record<string, unknown>;
  const developer =
    typeof o.developer === "string" ? o.developer : (o.developerId as string | undefined);
  return {
    appId: String(o.appId ?? ""),
    title: typeof o.title === "string" ? o.title : undefined,
    developer,
    genre: typeof o.genre === "string" ? o.genre : undefined,
    primaryGenre: typeof o.genre === "string" ? o.genre : undefined,
    price: typeof o.price === "number" ? o.price : undefined,
    priceText: typeof o.priceText === "string" ? o.priceText : undefined,
    currency: typeof o.currency === "string" ? o.currency : undefined,
    free: typeof o.free === "boolean" ? o.free : undefined,
    score: typeof o.score === "number" ? o.score : undefined,
    reviews: typeof o.reviews === "number" ? o.reviews : undefined,
    ratings: typeof o.ratings === "number" ? o.ratings : undefined,
    icon: typeof o.icon === "string" ? o.icon : undefined,
    description:
      typeof o.summary === "string"
        ? o.summary
        : typeof o.description === "string"
          ? o.description
          : undefined,
    screenshots: Array.isArray(o.screenshots) ? (o.screenshots as string[]) : undefined,
    released: typeof o.released === "string" ? o.released : undefined,
    updated: typeof o.updated === "string" ? o.updated : undefined,
  };
}

export function createGoogleScraperLib(lib: GoogleScraperLib): ScraperLib {
  return {
    async fetchChart(query: ChartQuery): Promise<ChartEntry[]> {
      if (query.store !== "google") {
        throw new Error(`google client received non-google query: ${query.store}`);
      }
      const collection = GOOGLE_COLLECTION_MAP[query.collection];
      if (!collection) {
        throw new Error(`unsupported google collection: ${query.collection}`);
      }
      const raw = await lib.list({
        collection,
        country: query.market.toLowerCase(),
        num: query.limit,
      });
      return raw.map(normalizeGoogleEntry);
    },
    async fetchApp(query: AppQuery): Promise<AppDetails> {
      if (query.store !== "google") {
        throw new Error(`google client received non-google query: ${query.store}`);
      }
      const raw = await lib.app({
        appId: query.appId,
        country: query.market.toLowerCase(),
      });
      const entry = normalizeGoogleEntry(raw);
      const o = raw as Record<string, unknown>;
      return {
        ...entry,
        inAppPurchases:
          typeof o.offersIAP === "boolean"
            ? o.offersIAP
            : typeof o.IAPRange === "string"
              ? true
              : undefined,
      };
    },
  };
}

export async function loadDefaultGoogleClient(): Promise<ScraperLib> {
  const mod = await import("google-play-scraper");
  const lib =
    (mod as unknown as { default?: GoogleScraperLib }).default ??
    (mod as unknown as GoogleScraperLib);
  return createGoogleScraperLib(lib);
}
