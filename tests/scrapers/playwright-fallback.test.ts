import { describe, expect, test } from "bun:test";
import {
  createPlaywrightAppleFallback,
  parseAppHtml,
  parseChartHtml,
} from "../../src/scrapers/playwright-fallback.ts";

interface FakePage {
  goto: (url: string, opts?: { timeout?: number; waitUntil?: string }) => Promise<void>;
  content: () => Promise<string>;
  close: () => Promise<void>;
  closed: boolean;
  visited: string[];
}

function makeFakeBrowser(html: string) {
  const page: FakePage = {
    visited: [],
    closed: false,
    async goto(url: string) {
      this.visited.push(url);
    },
    async content() {
      return html;
    },
    async close() {
      this.closed = true;
    },
  };
  let ctxClosed = false;
  let browserClosed = false;
  const browser = {
    async newContext() {
      return {
        async newPage() {
          return page;
        },
        async close() {
          ctxClosed = true;
        },
      };
    },
    async close() {
      browserClosed = true;
    },
  };
  return {
    page,
    browser,
    isCtxClosed: () => ctxClosed,
    isBrowserClosed: () => browserClosed,
    launch: async () => browser,
  };
}

const APP_HTML_WITH_JSONLD = `<!DOCTYPE html>
<html><head>
<script type="application/ld+json">
{
  "@type": "MobileApplication",
  "name": "Cal AI",
  "url": "https://apps.apple.com/us/app/cal-ai/id6480417616",
  "author": { "@type": "Organization", "name": "Cal AI Inc." },
  "description": "Best calorie counter.",
  "image": "https://example.com/icon.png",
  "applicationCategory": "Health & Fitness",
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": 4.8, "ratingCount": 12345 }
}
</script>
</head><body></body></html>`;

const CHART_HTML = `<!DOCTYPE html>
<html><body>
<a href="/us/app/cal-ai/id6480417616">Cal AI</a>
<a href="/us/app/picturethis/id1252497129">PictureThis</a>
<a href="/us/app/remini/id1352082603">Remini</a>
<a href="/us/app/cal-ai/id6480417616">Cal AI (duplicate)</a>
</body></html>`;

describe("parseAppHtml", () => {
  test("extracts JSON-LD MobileApplication fields", () => {
    const out = parseAppHtml(APP_HTML_WITH_JSONLD);
    expect(out).not.toBeNull();
    expect(out!.appId).toBe("6480417616");
    expect(out!.title).toBe("Cal AI");
    expect(out!.developer).toBe("Cal AI Inc.");
    expect(out!.description).toBe("Best calorie counter.");
    expect(out!.score).toBe(4.8);
    expect(out!.ratings).toBe(12345);
    expect(out!.primaryGenre).toBe("Health & Fitness");
  });

  test("returns null when no JSON-LD present", () => {
    expect(parseAppHtml("<html><body>Nothing here</body></html>")).toBeNull();
  });

  test("returns null when JSON-LD is malformed", () => {
    const html = `<script type="application/ld+json">{ not valid json</script>`;
    expect(parseAppHtml(html)).toBeNull();
  });
});

describe("parseChartHtml", () => {
  test("extracts unique appIds from chart links", () => {
    const entries = parseChartHtml(CHART_HTML);
    const ids = entries.map((e) => e.appId).sort();
    expect(ids).toEqual(["1252497129", "1352082603", "6480417616"]);
  });

  test("returns empty array when no app links", () => {
    expect(parseChartHtml("<html><body></body></html>")).toEqual([]);
  });
});

describe("createPlaywrightAppleFallback", () => {
  test("returns a ScraperLib with fetchChart + fetchApp", () => {
    const lib = createPlaywrightAppleFallback({
      launchBrowser: async () => ({
        newContext: async () => ({ newPage: async () => null as never, close: async () => {} }),
        close: async () => {},
      } as never),
    });
    expect(typeof lib.fetchChart).toBe("function");
    expect(typeof lib.fetchApp).toBe("function");
  });

  test("fetchChart navigates to the correct URL and returns parsed entries", async () => {
    const fake = makeFakeBrowser(CHART_HTML);
    const lib = createPlaywrightAppleFallback({ launchBrowser: fake.launch });
    const entries = await lib.fetchChart({
      store: "apple",
      market: "us",
      collection: "top-grossing",
      limit: 100,
    });
    expect(fake.page.visited[0]).toBe(
      "https://apps.apple.com/us/charts/iphone/top-grossing-apps",
    );
    expect(entries.map((e) => e.appId).sort()).toEqual(
      ["1252497129", "1352082603", "6480417616"],
    );
    expect(fake.page.closed).toBe(true);
    expect(fake.isCtxClosed()).toBe(true);
    expect(fake.isBrowserClosed()).toBe(true);
  });

  test("fetchChart respects limit", async () => {
    const fake = makeFakeBrowser(CHART_HTML);
    const lib = createPlaywrightAppleFallback({ launchBrowser: fake.launch });
    const entries = await lib.fetchChart({
      store: "apple",
      market: "us",
      collection: "top-grossing",
      limit: 2,
    });
    expect(entries).toHaveLength(2);
  });

  test("fetchApp navigates to the correct URL and parses JSON-LD", async () => {
    const fake = makeFakeBrowser(APP_HTML_WITH_JSONLD);
    const lib = createPlaywrightAppleFallback({ launchBrowser: fake.launch });
    const out = await lib.fetchApp({ store: "apple", market: "us", appId: "6480417616" });
    expect(fake.page.visited[0]).toBe("https://apps.apple.com/us/app/id6480417616");
    expect(out.appId).toBe("6480417616");
    expect(out.title).toBe("Cal AI");
  });

  test("fetchApp throws clear error when JSON-LD missing", async () => {
    const fake = makeFakeBrowser("<html>nothing</html>");
    const lib = createPlaywrightAppleFallback({ launchBrowser: fake.launch });
    await expect(
      lib.fetchApp({ store: "apple", market: "us", appId: "999" }),
    ).rejects.toThrow(/parse app page/i);
  });

  test("rejects non-apple queries", async () => {
    const fake = makeFakeBrowser(CHART_HTML);
    const lib = createPlaywrightAppleFallback({ launchBrowser: fake.launch });
    await expect(
      lib.fetchChart({
        store: "google" as never,
        market: "us",
        collection: "top-grossing",
        limit: 10,
      }),
    ).rejects.toThrow(/non-apple/i);
  });

  test("closes browser even when fetchApp throws", async () => {
    const fake = makeFakeBrowser("<html>nothing</html>");
    const lib = createPlaywrightAppleFallback({ launchBrowser: fake.launch });
    await expect(
      lib.fetchApp({ store: "apple", market: "us", appId: "1" }),
    ).rejects.toThrow();
    expect(fake.isBrowserClosed()).toBe(true);
  });

  test("market code is lowercased in URL", async () => {
    const fake = makeFakeBrowser(CHART_HTML);
    const lib = createPlaywrightAppleFallback({ launchBrowser: fake.launch });
    await lib.fetchChart({
      store: "apple",
      market: "US",
      collection: "top-grossing",
      limit: 10,
    });
    expect(fake.page.visited[0]).toContain("/us/charts/");
  });
});
