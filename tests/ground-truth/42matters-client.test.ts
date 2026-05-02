import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bulkExtractCohort,
  createClient,
  type FortyTwoMattersClient,
} from "../../src/ground-truth/42matters-client.ts";
import { runMigrations } from "../../src/storage/schema.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a fake fetch that maps URL pathname → JSON response. Captures call
 * history so tests can assert auth header, query params, or call counts.
 */
function makeFakeFetch(routes: Record<string, unknown>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const u = new URL(url);
    const route = routes[u.pathname];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    return new Response(JSON.stringify(route), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("createClient — auth + env", () => {
  const ENV = "FORTYTWO_MATTERS_API_KEY";
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = originalEnv;
    }
  });

  test("throws clear error when no API key is set", () => {
    expect(() => createClient()).toThrow(/API key not set/);
    expect(() => createClient()).toThrow(/agent-v1-foundation\.md/);
  });

  test("uses env var when opts.apiKey not provided", async () => {
    process.env[ENV] = "envkey";
    const { fetch, calls } = makeFakeFetch({
      "/v3.0/apps/lookup_history.json": { app: { title: "X" } },
    });
    const client = createClient({ fetch });
    await client.fetchAppMetadata("com.x", "id", Date.now());
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer envkey" });
  });

  test("opts.apiKey overrides env var", async () => {
    process.env[ENV] = "env-key";
    const { fetch, calls } = makeFakeFetch({
      "/v3.0/apps/lookup_history.json": { app: { title: "X" } },
    });
    const client = createClient({ apiKey: "opt-key", fetch });
    await client.fetchAppMetadata("com.x", "id", Date.now());
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer opt-key" });
  });
});

describe("fetchAppMetadata", () => {
  test("happy path: parses 42matters response into AppMetadata", async () => {
    const { fetch } = makeFakeFetch({
      "/v3.0/apps/lookup_history.json": {
        app: {
          title: "Test App",
          developer: "Test Dev",
          category: "productivity",
          description: "Nice app",
          rating: 4.5,
          ratings_count: 1234,
          iap: true,
          icon: "https://x/icon.png",
          last_updated: "2024-01-15",
        },
      },
    });
    const client = createClient({ apiKey: "k", fetch });
    const meta = await client.fetchAppMetadata("com.x", "id", 1_700_000_000_000);
    expect(meta).not.toBeNull();
    expect(meta?.name).toBe("Test App");
    expect(meta?.rating).toBe(4.5);
    expect(meta?.iap_present).toBe(true);
    expect(meta?.market).toBe("id");
    expect(meta?.captured_at).toBe(1_700_000_000_000);
  });

  test("returns null when 42matters returns no app", async () => {
    const { fetch } = makeFakeFetch({
      "/v3.0/apps/lookup_history.json": { app: null },
    });
    const client = createClient({ apiKey: "k", fetch });
    const meta = await client.fetchAppMetadata("com.x", "id", Date.now());
    expect(meta).toBeNull();
  });

  test("returns null on 404 (no snapshot at requested t)", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const client = createClient({ apiKey: "k", fetch: fetchImpl });
    const meta = await client.fetchAppMetadata("com.x", "id", Date.now());
    expect(meta).toBeNull();
  });
});

describe("fetchAppReviews + fetchHistoricalRanks", () => {
  test("fetchAppReviews returns parsed array", async () => {
    const { fetch } = makeFakeFetch({
      "/v3.0/apps/reviews.json": {
        reviews: [
          { review_id: "r1", rating: 5, posted_at: "2024-01-01", body: "nice" },
          { review_id: "r2", rating: 1, posted_at: "2024-01-02", body: "bad" },
        ],
      },
    });
    const client = createClient({ apiKey: "k", fetch });
    const reviews = await client.fetchAppReviews("com.x", "id", Date.now() - 86_400_000);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.review_id).toBe("r1");
    expect(reviews[0]?.rating).toBe(5);
  });

  test("fetchHistoricalRanks parses date strings to unix ms", async () => {
    const { fetch } = makeFakeFetch({
      "/v3.0/apps/rankings_history.json": {
        ranks: [
          { date: "2024-01-15", rank: 5, chart: "top-grossing", category: "productivity" },
          { date: "2024-01-16", rank: 7, chart: "top-grossing", category: "productivity" },
        ],
      },
    });
    const client = createClient({ apiKey: "k", fetch });
    const ranks = await client.fetchHistoricalRanks(
      "com.x",
      "id",
      Date.parse("2024-01-01"),
      Date.parse("2024-01-31"),
    );
    expect(ranks).toHaveLength(2);
    expect(ranks[0]?.rank).toBe(5);
    expect(ranks[0]?.captured_at).toBe(Date.parse("2024-01-15"));
  });
});

describe("trial expiration warning", () => {
  test("logs warn when days_remaining < 5 (no throw)", async () => {
    const { fetch } = makeFakeFetch({
      "/v3.0/apps/lookup_history.json": { app: { title: "X" } },
    });
    const now = 1_700_000_000_000;
    const trialExpires = now + 3 * DAY_MS; // 3 days remaining
    const client = createClient({
      apiKey: "k",
      fetch,
      trialExpiresAt: trialExpires,
      clock: () => now,
    });
    // Just exercising the path — pino's transport is silent in tests
    // (no assertions on log lines). We assert the function still completes.
    await client.fetchAppMetadata("com.x", "id", now);
  });

  test("expired trial does NOT throw at client level (caller decides)", async () => {
    const { fetch } = makeFakeFetch({
      "/v3.0/apps/lookup_history.json": { app: { title: "X" } },
    });
    const now = 1_700_000_000_000;
    const client = createClient({
      apiKey: "k",
      fetch,
      trialExpiresAt: now - DAY_MS,
      clock: () => now,
    });
    // Logs error but still attempts the fetch — the upstream API is the
    // one that ultimately rejects; the client doesn't pre-block.
    await client.fetchAppMetadata("com.x", "id", now);
  });
});

describe("bulkExtractCohort", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
  });

  function makeFakeClient(): FortyTwoMattersClient {
    return {
      async fetchAppMetadata(app_id, market, t) {
        return {
          app_id,
          market,
          captured_at: t,
          name: `name-${app_id}`,
          developer: "dev",
          category: "productivity",
          description: "desc",
          rating: 4.0,
          ratings_count: 100,
          iap_present: true,
          icon_url: null,
          last_updated: "2024-01-01",
        };
      },
      async fetchAppReviews(app_id, market, _since) {
        return [
          { app_id, market, review_id: "r1", rating: 5, posted_at: "2024-01-01", body: "ok" },
          { app_id, market, review_id: "r2", rating: 4, posted_at: "2024-01-02", body: "ok" },
        ];
      },
      async fetchHistoricalRanks(app_id, market, from, _to) {
        return [
          {
            app_id,
            market,
            chart: "top-grossing",
            category: "productivity",
            captured_at: from,
            rank: 5,
          },
        ];
      },
    };
  }

  test("happy bulk: 100 apps × 6 markets persists to all 3 tables", async () => {
    const apps = Array.from({ length: 100 }, (_, i) => `com.app${i}`);
    const markets = ["id", "vn", "th", "my", "ph", "bd"];
    const client = makeFakeClient();
    const stats = await bulkExtractCohort(client, db, {
      app_ids: apps,
      markets,
      t0_range: { from: Date.parse("2024-01-01"), to: Date.parse("2024-12-31") },
    });
    // 100 × 6 × 3 samples = 1800 metadata rows.
    expect(stats.metadataRows).toBe(1800);
    // 100 × 6 = 600 (app, market) pairs × 1 chart row each (mock returns 1).
    expect(stats.rankRows).toBe(600);
    expect(stats.errors).toBe(0);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("idempotent on re-run (no duplicate-row errors)", async () => {
    const apps = ["com.x", "com.y"];
    const markets = ["id", "vn"];
    const client = makeFakeClient();
    const cohort = {
      app_ids: apps,
      markets,
      t0_range: { from: Date.parse("2024-01-01"), to: Date.parse("2024-12-31") },
    };
    const first = await bulkExtractCohort(client, db, cohort);
    const second = await bulkExtractCohort(client, db, cohort);
    // Same call counts in stats; INSERT OR IGNORE prevents PK errors.
    expect(first.metadataRows).toBe(second.metadataRows);
    // DB row counts remain the same (no duplicates accumulated).
    const rows = db
      .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM app_metadata_snapshots")
      .get();
    expect(rows?.count).toBe(first.metadataRows);
  });

  test("counts errors when fetch throws", async () => {
    const flakyClient: FortyTwoMattersClient = {
      async fetchAppMetadata() {
        throw new Error("network down");
      },
      async fetchAppReviews() {
        throw new Error("network down");
      },
      async fetchHistoricalRanks() {
        throw new Error("network down");
      },
    };
    const stats = await bulkExtractCohort(flakyClient, db, {
      app_ids: ["com.x"],
      markets: ["id"],
      t0_range: { from: Date.parse("2024-01-01"), to: Date.parse("2024-12-31") },
    });
    // 3 samples × 2 fetches (metadata + reviews) + 1 ranks = 7 errors.
    expect(stats.errors).toBe(7);
    expect(stats.metadataRows).toBe(0);
  });
});
