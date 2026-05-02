import type { Opportunity } from "../../src/opportunities/schema.ts";
import type { RankedCandidate, ScanResult } from "../../src/orchestrator/types.ts";

export function fixedScanResult(): ScanResult {
  const candidates: RankedCandidate[] = [
    {
      rank: 1,
      app: {
        store: "apple",
        appId: "com.example.calai",
        trackId: "1234567890",
        market: "br",
        name: "Cal AI: Calorie Tracker",
        developer: "Cal AI Inc.",
        category: "Health & Fitness",
        rank: 3,
        rating: 4.7,
        ratingsCount: 89_432,
        priceUsd: 0,
        iapPresent: true,
        description: "Track your calories with AI photo recognition.",
        screenshotUrls: ["https://example.com/calai-1.png"],
        iconUrl: "https://example.com/calai-icon.png",
        releaseDate: null,
        lastUpdated: null,
        scrapedAt: "2026-04-29T12:00:00.000Z",
      },
      composite: {
        composite: 8.2,
        eligible: true,
        breakdown: { locGap: 9.0, revenue: 8.5, paywall: 6.5, velocity: null },
        weights: { locGap: 0.4, revenue: 0.4, paywall: 0.2, velocity: 0 },
      },
      textJudge: {
        kind: "text",
        appId: "com.example.calai",
        store: "apple",
        market: "br",
        locGapScore: 9.0,
        reasoning: "English-only listing on a Brazilian top chart, no PIX.",
        signals: {
          hasNativeLanguage: false,
          hasCulturalAdaptation: false,
          hasLocalizedPaywall: false,
          hasLocalPaymentMethod: false,
        },
        confidence: 0.85,
        modelVersion: "claude-sonnet-4-6",
      },
      visionJudge: {
        kind: "vision",
        appId: "com.example.calai",
        store: "apple",
        market: "br",
        culturalFitScore: 7.0,
        reasoning: "US-style food imagery, English captions on every screenshot.",
        signals: {
          screenshotsLocalized: false,
          imagesCulturallyAdapted: false,
          textInLanguage: false,
          screenshotFreshness: "stale",
        },
        screenshotsAnalyzed: 5,
        confidence: 0.75,
        modelVersion: "claude-sonnet-4-6",
      },
      enrichmentSource: "enriched",
    },
    {
      rank: 2,
      app: {
        store: "google",
        appId: "com.example.remini",
        trackId: null,
        market: "jp",
        name: "Remini",
        developer: "Bending Spoons",
        category: "Photo & Video",
        rank: 12,
        rating: 4.5,
        ratingsCount: 230_000,
        priceUsd: 0,
        iapPresent: true,
        description: "AI photo enhancer.",
        screenshotUrls: [],
        iconUrl: null,
        releaseDate: null,
        lastUpdated: null,
        scrapedAt: "2026-04-29T12:00:00.000Z",
      },
      composite: {
        composite: 6.4,
        eligible: true,
        breakdown: { locGap: 5.5, revenue: 7.0, paywall: 6.5, velocity: 6.0 },
        weights: { locGap: 0.3, revenue: 0.3, paywall: 0.15, velocity: 0.25 },
      },
      textJudge: {
        kind: "text",
        appId: "com.example.remini",
        store: "google",
        market: "jp",
        locGapScore: 5.5,
        reasoning: "Partial JP localization but paywall stays English.",
        signals: {
          hasNativeLanguage: true,
          hasCulturalAdaptation: false,
          hasLocalizedPaywall: false,
          hasLocalPaymentMethod: false,
        },
        confidence: 0.7,
        modelVersion: "claude-sonnet-4-6",
      },
      visionJudge: null,
      enrichmentSource: "chart-only",
    },
  ];
  return {
    runId: "run-2026-04-29T12-00-00",
    generatedAt: "2026-04-29T12:00:00.000Z",
    markets: ["us", "jp", "de", "fr", "br", "es"],
    appsScanned: 280,
    costUsd: 1.23,
    candidates,
    judgeResults: [],
    snapshotResult: { written: 280, skipped: 0, day: "2026-04-29" },
    failedSlices: [],
    enrichmentFailedCount: 1,
    enrichmentSkipped: false,
  };
}

// ──────────────────────────────────────────────────────────────────────
// v1 Opportunity fixtures (renderBrief consumers)
// ──────────────────────────────────────────────────────────────────────

/**
 * Canonical "happy path" Opportunity: all 4 v1 signals populated, full
 * predicted economics, mechanic_evidence in metadata, multiple citations.
 * Targets a tier-2 market (id) so the tier2-localization tag fires.
 *
 * Tweak via the optional `overrides` argument to exercise null-safety paths
 * without re-declaring the whole shape.
 */
export function fixedOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  const base: Opportunity = {
    id: "11111111-1111-1111-1111-111111111111",
    generated_at: "2026-04-29T12:00:00.000Z",
    source_app_id: "com.example.calai",
    source_market: "us",
    target_market: "id",
    category: "health",
    signal_values: {
      locGap: 8.5,
      velocity: 6.0,
      incumbent_vulnerability: 7.5,
      cpi_ltv_proxy: 7.0,
    },
    predicted: {
      cpi_low: 0.5,
      cpi_high: 1.5,
      ltv_low: 4,
      ltv_high: 12,
      validation_budget_usd: 500,
    },
    kill_metric: {
      metric: "roas_d14",
      threshold: 0.4,
      direction: "below",
    },
    score: 7.7,
    eligible: true,
    thesis:
      "Cal AI dominates US calorie tracking but ships English-only in Indonesia where Bahasa Indonesia + GoPay/OVO are table stakes — the localized clone wins on rails the incumbent can't run.",
    evidence: [
      {
        url: "https://apps.apple.com/id/app/cal-ai/id1234567890",
        claim: "Cal AI listing on the Indonesian App Store has no Bahasa translation.",
      },
      {
        url: "https://www.indiehackers.com/post/cal-ai-mrr-300k",
        claim: "IndieHackers thread reports Cal AI at $300k MRR globally.",
      },
    ],
    metadata: {
      signal_pipeline_version: "v1.0.0",
      scoring_version: "v1.0.0",
      mechanic_evidence:
        "Core loop: photograph meal → AI estimates calories → log to daily target. Novel mechanic: portion-size calibration via on-screen reference object instead of manual gram entry.",
    },
  };
  return { ...base, ...overrides };
}
