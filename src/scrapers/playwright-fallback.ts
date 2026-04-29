// Playwright Apple App Store fallback.
//
// When the primary `app-store-scraper` lib trips Akamai bot detection (Apple
// returns 403 / blank HTML), this fallback drives a real headless Chromium
// against apps.apple.com to recover chart + app metadata.
//
// Lazy-loaded: `playwright` is only imported when the fallback is invoked, so
// installs that never use it skip the chromium download. Opt-in via
// `scrapeCharts({ fallbacks: { apple: createPlaywrightAppleFallback() } })`.
//
// If chromium is not installed when the fallback runs, the user gets a clear
// error pointing at `bunx playwright install chromium`.

import type {
  AppDetails,
  AppQuery,
  ChartEntry,
  ChartQuery,
  Collection,
  ScraperLib,
} from "./api.ts";

interface PlaywrightLikePage {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}

interface PlaywrightLikeContext {
  newPage(): Promise<PlaywrightLikePage>;
  close(): Promise<void>;
}

interface PlaywrightLikeBrowser {
  newContext(opts?: { userAgent?: string }): Promise<PlaywrightLikeContext>;
  close(): Promise<void>;
}

export interface PlaywrightFallbackOptions {
  /** Override for testing — defaults to lazy-loading playwright + launching chromium. */
  launchBrowser?: () => Promise<PlaywrightLikeBrowser>;
  /** Per-page navigation timeout in ms. Default 30s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 30_000;

const COLLECTION_SLUG: Record<Collection, string> = {
  "top-grossing": "top-grossing-apps",
  "top-free": "top-free-apps",
  "top-paid": "top-paid-apps",
};

function chartUrl(market: string, collection: Collection): string {
  return `https://apps.apple.com/${market.toLowerCase()}/charts/iphone/${COLLECTION_SLUG[collection]}`;
}

function appUrl(market: string, appId: string): string {
  return `https://apps.apple.com/${market.toLowerCase()}/app/id${appId}`;
}

async function defaultLaunchBrowser(): Promise<PlaywrightLikeBrowser> {
  let chromium: { launch: (opts: unknown) => Promise<PlaywrightLikeBrowser> };
  try {
    const mod = (await import("playwright")) as Record<string, unknown>;
    chromium = (mod.chromium ?? (mod.default as Record<string, unknown> | undefined)?.chromium) as
      | { launch: (opts: unknown) => Promise<PlaywrightLikeBrowser> }
      | undefined as { launch: (opts: unknown) => Promise<PlaywrightLikeBrowser> };
    if (!chromium || typeof chromium.launch !== "function") {
      throw new Error("missing chromium export");
    }
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(
      "Playwright Apple fallback requires `playwright` and chromium. " +
        "Install with: bun add -D playwright && bunx playwright install chromium. " +
        `(cause: ${cause})`,
    );
  }
  return chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

export function parseChartHtml(html: string): ChartEntry[] {
  const idPattern = /\/app\/[a-z0-9-]+\/id(\d+)/gi;
  const seen = new Set<string>();
  const entries: ChartEntry[] = [];
  for (const m of html.matchAll(idPattern)) {
    const id = m[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      entries.push({ appId: id });
    }
  }
  return entries;
}

interface JsonLdAuthor {
  name?: unknown;
}
interface JsonLdRating {
  ratingValue?: unknown;
  ratingCount?: unknown;
}
interface JsonLdMobileApp {
  "@type"?: unknown;
  name?: unknown;
  url?: unknown;
  author?: JsonLdAuthor;
  description?: unknown;
  image?: unknown;
  applicationCategory?: unknown;
  aggregateRating?: JsonLdRating;
}

function pickJsonLdApp(parsed: unknown): JsonLdMobileApp | null {
  if (Array.isArray(parsed)) {
    const found = parsed.find(
      (x) => x && typeof x === "object" && (x as JsonLdMobileApp)["@type"] === "MobileApplication",
    );
    return (found as JsonLdMobileApp | undefined) ?? null;
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as JsonLdMobileApp;
    if (obj["@type"] === "MobileApplication") return obj;
  }
  return null;
}

export function parseAppHtml(html: string): AppDetails | null {
  const ldMatch = html.match(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!ldMatch) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(ldMatch[1]!);
  } catch {
    return null;
  }
  const app = pickJsonLdApp(parsed);
  if (!app) return null;

  const url = typeof app.url === "string" ? app.url : "";
  const idMatch = url.match(/id(\d+)/);
  const rating = app.aggregateRating ?? {};

  return {
    appId: idMatch?.[1] ?? "",
    title: typeof app.name === "string" ? app.name : undefined,
    developer: typeof app.author?.name === "string" ? app.author.name : undefined,
    description: typeof app.description === "string" ? app.description : undefined,
    icon: typeof app.image === "string" ? app.image : undefined,
    primaryGenre:
      typeof app.applicationCategory === "string" ? app.applicationCategory : undefined,
    score: typeof rating.ratingValue === "number" ? rating.ratingValue : undefined,
    ratings: typeof rating.ratingCount === "number" ? rating.ratingCount : undefined,
  };
}

export function createPlaywrightAppleFallback(
  opts: PlaywrightFallbackOptions = {},
): ScraperLib {
  const launch = opts.launchBrowser ?? defaultLaunchBrowser;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  async function withPage<T>(fn: (page: PlaywrightLikePage) => Promise<T>): Promise<T> {
    const browser = await launch();
    try {
      const ctx = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
          "(KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      });
      try {
        const page = await ctx.newPage();
        try {
          return await fn(page);
        } finally {
          await page.close();
        }
      } finally {
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  }

  return {
    async fetchChart(query: ChartQuery): Promise<ChartEntry[]> {
      if (query.store !== "apple") {
        throw new Error(`apple fallback received non-apple query: ${query.store}`);
      }
      const url = chartUrl(query.market, query.collection);
      return withPage(async (page) => {
        await page.goto(url, { timeout, waitUntil: "domcontentloaded" });
        const html = await page.content();
        return parseChartHtml(html).slice(0, query.limit);
      });
    },
    async fetchApp(query: AppQuery): Promise<AppDetails> {
      if (query.store !== "apple") {
        throw new Error(`apple fallback received non-apple query: ${query.store}`);
      }
      const url = appUrl(query.market, query.appId);
      return withPage(async (page) => {
        await page.goto(url, { timeout, waitUntil: "domcontentloaded" });
        const html = await page.content();
        const parsed = parseAppHtml(html);
        if (!parsed) {
          throw new Error(
            `Playwright Apple fallback: failed to parse app page for ${query.appId} (${query.market})`,
          );
        }
        return { ...parsed, appId: parsed.appId || query.appId };
      });
    },
  };
}
