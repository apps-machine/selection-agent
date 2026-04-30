#!/usr/bin/env bun
/**
 * Live smoke test for `@apps-machine/selection-agent`.
 *
 * Hits the real `app-store-scraper` and `google-play-scraper` libs with the
 * smallest possible workload (top 1, market US, both stores, --no-llm).
 * Catches the class of regressions that pure unit tests miss — every test
 * file uses fakes that don't replicate upstream lib runtime quirks. PR #14
 * shipped 3 silent regressions (citty `--no-X` footgun, Apple collection
 * enum mismatch, Zod offset rejection) that all sailed past 320 unit tests.
 * This is the gate that catches the next one before npm sees it.
 *
 * Run:
 *   bun scripts/smoke.ts
 *
 * Exit codes:
 *   0 — pass
 *   1 — fail (any assertion or wall-time budget breach)
 *
 * Wall-time budget: 30 seconds. The pipeline rate-limits at 4 req/sec per
 * host with concurrency 8, so 1 chart × 1 store + 1 enrichment fits well
 * inside the budget on a healthy network.
 */
import { CostBudget } from "../src/judges/budget.ts";
import { runScan } from "../src/orchestrator/pipeline.ts";
import { loadDefaultAppleClient } from "../src/scrapers/apple-store-client.ts";
import { loadDefaultGoogleClient } from "../src/scrapers/google-play-client.ts";
import { Cache } from "../src/storage/cache.ts";

const WALL_BUDGET_MS = 30_000;
const SMOKE_DB_PATH = ":memory:";

interface AssertionResult {
  pass: boolean;
  name: string;
  detail?: string;
}

async function runSmoke(): Promise<{
  ok: boolean;
  results: AssertionResult[];
  durationMs: number;
}> {
  const started = Date.now();
  const results: AssertionResult[] = [];
  const cache = Cache.open(SMOKE_DB_PATH);

  try {
    const [apple, google] = await Promise.all([
      loadDefaultAppleClient(),
      loadDefaultGoogleClient(),
    ]);

    // No-op judge clients — --no-llm enforces they never fire. We pass stubs
    // that throw if invoked, so a regression that re-enables judges is loud.
    const stubClient = {
      messages: {
        async create(): Promise<never> {
          throw new Error("smoke: judge invoked despite --no-llm");
        },
      },
    };

    const result = await runScan({
      cache,
      markets: ["us"],
      stores: ["apple", "google"],
      topN: 1,
      noLlm: true,
      enrich: true,
      scrapers: { apple, google },
      // biome-ignore lint/suspicious/noExplicitAny: stub clients are typed via the runScan input shape, not the SDK
      textClient: stubClient as any,
      // biome-ignore lint/suspicious/noExplicitAny: same as above
      visionClient: stubClient as any,
      fetchImage: async () => {
        throw new Error("smoke: fetchImage invoked despite --no-llm");
      },
      budget: new CostBudget({ capUsd: 0 }),
      runIdSeed: "smoke",
    });

    const durationMs = Date.now() - started;

    results.push({
      pass: durationMs < WALL_BUDGET_MS,
      name: `wall-time < ${WALL_BUDGET_MS}ms`,
      detail: `actual ${durationMs}ms`,
    });

    results.push({
      pass: result.candidates.length >= 1,
      name: "≥ 1 candidate returned",
      detail: `actual ${result.candidates.length}`,
    });

    results.push({
      pass: result.snapshotResult.written > 0 || result.snapshotResult.skipped > 0,
      name: "snapshot persisted (written + skipped > 0)",
      detail: `written=${result.snapshotResult.written} skipped=${result.snapshotResult.skipped}`,
    });

    // The unblock test: composite must be non-zero for at least 1 candidate.
    // Zero composite for every candidate means enrichment didn't populate
    // ratings/description — exactly the M6 regression M7 was scoped to fix.
    const nonZero = result.candidates.filter((c) => c.composite.composite > 0).length;
    results.push({
      pass: nonZero >= 1,
      name: "≥ 1 candidate with composite > 0 (enrichment unblock)",
      detail: `${nonZero}/${result.candidates.length} non-zero`,
    });

    // Total enrichment failure check: when both stores are healthy, every
    // chart-only fallback is a regression signal. The first demo refresh
    // hit 10/10 silent Apple enrichment failures because the upstream lib
    // routes by `id` vs `appId` differently than we'd assumed. Asserting
    // ZERO chart-only fallbacks (not "≤ 50%") catches the bug at smoke's
    // small N: 1/2 = 50% would have passed a 50% threshold but is the
    // exact regression we're guarding against.
    results.push({
      pass: result.enrichmentFailedCount === 0,
      name: "zero enrichment failures",
      detail: `${result.enrichmentFailedCount}/${result.appsScanned} chart-only`,
    });

    // Apple trackId must be surfaced (M7 link fix). Direct field check —
    // not the constructed URL — so the bundle-ID-as-fallback path can't
    // accidentally pass.
    const appleCandidate = result.candidates.find((c) => c.app.store === "apple");
    if (appleCandidate) {
      const trackId = appleCandidate.app.trackId;
      const isPopulatedNumeric = typeof trackId === "string" && /^\d+$/.test(trackId);
      results.push({
        pass: isPopulatedNumeric,
        name: "Apple candidate has numeric trackId surfaced",
        detail: `trackId=${trackId ?? "null"} appId=${appleCandidate.app.appId}`,
      });
    }

    // Google link must use the play.google.com format with appId.
    const googleCandidate = result.candidates.find((c) => c.app.store === "google");
    if (googleCandidate) {
      const wellFormed = googleCandidate.app.appId.length > 0;
      results.push({
        pass: wellFormed,
        name: "Google candidate has non-empty appId",
        detail: `appId="${googleCandidate.app.appId}"`,
      });
    }

    const ok = results.every((r) => r.pass);
    return { ok, results, durationMs };
  } finally {
    cache.close();
  }
}

const { ok, results, durationMs } = await runSmoke();

console.log(`Selection Agent smoke — ${ok ? "PASS" : "FAIL"} (${durationMs}ms)`);
for (const r of results) {
  const icon = r.pass ? "✓" : "✗";
  const detail = r.detail ? ` — ${r.detail}` : "";
  console.log(`  ${icon} ${r.name}${detail}`);
}

process.exit(ok ? 0 : 1);
