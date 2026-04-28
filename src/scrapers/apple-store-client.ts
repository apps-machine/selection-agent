import type {
  AppDetails,
  ChartEntry,
  ChartQuery,
  AppQuery,
  ScraperLib,
} from "./api.ts";

/** Subset of `app-store-scraper` we use. Allows injecting a mock in tests. */
export interface AppleScraperLib {
  list(opts: {
    collection: string;
    country: string;
    num: number;
  }): Promise<unknown[]>;
  app(opts: { id?: string; appId?: string; country: string }): Promise<unknown>;
  collection: Record<string, string>;
}

const APPLE_COLLECTION_MAP: Record<string, string> = {
  "top-grossing": "TOP_GROSSING_IOS",
  "top-free": "TOP_FREE_IOS",
  "top-paid": "TOP_PAID_IOS",
};

function normalizeAppleEntry(raw: unknown): ChartEntry {
  const o = raw as Record<string, unknown>;
  const id = o.appId ?? o.id ?? o.trackId;
  return {
    appId: String(id ?? ""),
    title: typeof o.title === "string" ? o.title : (o.trackName as string | undefined),
    developer: typeof o.developer === "string" ? o.developer : (o.artistName as string | undefined),
    primaryGenre: typeof o.primaryGenre === "string" ? o.primaryGenre : (o.genre as string | undefined),
    genre: typeof o.genre === "string" ? o.genre : undefined,
    price: typeof o.price === "number" ? o.price : undefined,
    currency: typeof o.currency === "string" ? o.currency : undefined,
    free: typeof o.free === "boolean" ? o.free : undefined,
    score: typeof o.score === "number" ? o.score : undefined,
    reviews: typeof o.reviews === "number" ? o.reviews : undefined,
    ratings: typeof o.ratings === "number" ? o.ratings : undefined,
    icon: typeof o.icon === "string" ? o.icon : undefined,
    description: typeof o.description === "string" ? o.description : undefined,
    screenshots: Array.isArray(o.screenshots)
      ? (o.screenshots as string[])
      : undefined,
    released: typeof o.released === "string" ? o.released : undefined,
    updated: typeof o.updated === "string" ? o.updated : undefined,
  };
}

export function createAppleScraperLib(lib: AppleScraperLib): ScraperLib {
  return {
    async fetchChart(query: ChartQuery): Promise<ChartEntry[]> {
      if (query.store !== "apple") {
        throw new Error(`apple client received non-apple query: ${query.store}`);
      }
      const collection = APPLE_COLLECTION_MAP[query.collection];
      if (!collection) {
        throw new Error(`unsupported apple collection: ${query.collection}`);
      }
      const raw = await lib.list({
        collection,
        country: query.market.toLowerCase(),
        num: query.limit,
      });
      return raw.map(normalizeAppleEntry);
    },
    async fetchApp(query: AppQuery): Promise<AppDetails> {
      if (query.store !== "apple") {
        throw new Error(`apple client received non-apple query: ${query.store}`);
      }
      const raw = await lib.app({
        id: query.appId,
        country: query.market.toLowerCase(),
      });
      const entry = normalizeAppleEntry(raw);
      const o = raw as Record<string, unknown>;
      return {
        ...entry,
        inAppPurchases:
          typeof o.inAppPurchases === "boolean" ? o.inAppPurchases : undefined,
      };
    },
  };
}

/** Convenience: load the real `app-store-scraper` and return a wired-up client. */
export async function loadDefaultAppleClient(): Promise<ScraperLib> {
  const mod = await import("app-store-scraper");
  const lib = (mod as unknown as { default?: AppleScraperLib }).default
    ?? (mod as unknown as AppleScraperLib);
  return createAppleScraperLib(lib);
}
