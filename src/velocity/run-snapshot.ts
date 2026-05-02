import type { ScraperLib } from "../scrapers/api.ts";
import { loadDefaultAppleClient } from "../scrapers/apple-store-client.ts";
import { type ChartScrapeJob, scrapeCharts } from "../scrapers/chart-scraper.ts";
import { loadDefaultGoogleClient } from "../scrapers/google-play-client.ts";
import { Cache } from "../storage/cache.ts";
import type { RawAppData, Store } from "../types/raw-app-data.ts";
import { writeSnapshot } from "./snapshot.ts";

/**
 * Tier-2 SEA cluster where the locGap thesis is empirically alive
 * (see m7.5-thesis-validation.md). Pivoted from the legacy Phase 0
 * tier-1 set (`us, jp, de, fr, br, es`) in v0.8.1 to match the scan
 * default updated in v0.7.0. Override with `--markets` to collect
 * a different cluster.
 */
const DEFAULT_SNAPSHOT_MARKETS = ["bd", "th", "vn", "my", "id"] as const;
const DEFAULT_SNAPSHOT_STORES: readonly Store[] = ["apple", "google"];

const ONE_HOUR_SECONDS = 60 * 60;

export interface RunSnapshotOpts {
  dbPath: string;
  limit: number;
  /** Override for tests. */
  cache?: Cache;
  /** Override for tests; defaults to the bundled libs via `loadDefault*Client`. */
  clients?: { apple: ScraperLib; google: ScraperLib };
  /** Override for tests; defaults to today UTC `YYYY-MM-DD`. */
  snapshotDay?: string;
  /** Markets to snapshot; defaults to the 5 tier-2 SEA markets (DEFAULT_SNAPSHOT_MARKETS). */
  markets?: readonly string[];
}

export interface RunSnapshotResult {
  day: string;
  written: number;
  skipped: number;
  failures: number;
  failedMarkets: string[];
}

function rankKey(app: RawAppData): string {
  return `${app.store}:${app.appId}:${app.market}`;
}

/**
 * Scrapes the top-grossing chart for the default tier-2 SEA markets
 * on both stores and writes one snapshot row per app per UTC day.
 * Override `opts.markets` to collect a different cluster. Idempotent
 * via the `app_snapshot` UNIQUE constraint — re-running on the same
 * day re-uses scrape-cache (1 h TTL) and is mostly a no-op against
 * SQLite.
 */
export async function runSnapshot(opts: RunSnapshotOpts): Promise<RunSnapshotResult> {
  const cache = opts.cache ?? Cache.open(opts.dbPath);
  try {
    let clients: { apple: ScraperLib; google: ScraperLib };
    if (opts.clients) {
      clients = opts.clients;
    } else {
      const [apple, google] = await Promise.all([
        loadDefaultAppleClient(),
        loadDefaultGoogleClient(),
      ]);
      clients = { apple, google };
    }
    const markets = opts.markets ?? DEFAULT_SNAPSHOT_MARKETS;

    const jobs: ChartScrapeJob[] = [];
    for (const store of DEFAULT_SNAPSHOT_STORES) {
      for (const market of markets) {
        jobs.push({ store, market, collection: "top-grossing", limit: opts.limit });
      }
    }

    const report = await scrapeCharts(jobs, {
      cache,
      cacheTtlSeconds: ONE_HOUR_SECONDS,
      clients,
    });

    const allApps: RawAppData[] = [];
    const rankByKey = new Map<string, number>();
    for (const outcome of report.outcomes) {
      for (const app of outcome.apps) {
        allApps.push(app);
        if (app.rank !== null) rankByKey.set(rankKey(app), app.rank);
      }
    }

    const result = writeSnapshot({
      apps: allApps,
      cache,
      rankByKey,
      snapshotDay: opts.snapshotDay,
    });

    return {
      day: result.day,
      written: result.written,
      skipped: result.skipped,
      failures: report.failures.length,
      failedMarkets: report.failures.map((f) => `${f.job.store}:${f.job.market}`),
    };
  } finally {
    if (!opts.cache) cache.close();
  }
}
