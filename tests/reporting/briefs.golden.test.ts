import { describe, expect, test } from "bun:test";
import { generateBrief } from "../../src/reporting/briefs.ts";
import { fixedScanResult } from "./briefs.fixtures.ts";

describe("generateBrief() — golden", () => {
  test("renders the canonical fixture into the pinned markdown", () => {
    const out = generateBrief(fixedScanResult());
    expect(out).toMatchSnapshot();
  });

  test("contains every required header and per-app section", () => {
    const out = generateBrief(fixedScanResult());
    expect(out).toContain("# Selection Agent — Scan 2026-04-29");
    expect(out).toContain("**Markets**: us, jp, de, fr, br, es");
    expect(out).toContain("**Apps scanned**: 280");
    expect(out).toContain("**Cost**: $1.23");
    expect(out).toContain("**Enrichment**: 279/280 enriched (1 chart-only fallback)");
    expect(out).toContain("## Top 2 candidates");
    expect(out).toContain("### #1 — Cal AI: Calorie Tracker (apple, br) — composite 8.20/10");
    // The second candidate fell back to chart-only; the brief tags it visibly.
    expect(out).toContain("### #2 — Remini (google, jp) — composite 6.40/10 _(chart-only)_");
    expect(out).toContain("**Velocity**: scaffolding (J0/14)");
    expect(out).toContain("**Velocity**: 6.0/10");
    expect(out).toContain("**Cultural fit (vision)**: 7.0/10");
    expect(out).toContain("(no vision judge — empty screenshots)");
    // Apple link must use numeric trackId, not bundle ID — the M7 link fix.
    expect(out).toContain("https://apps.apple.com/br/app/id1234567890");
  });

  test("renders skipped enrichment label when --no-enrich was set", () => {
    const skipped = {
      ...fixedScanResult(),
      enrichmentSkipped: true,
      enrichmentFailedCount: 0,
    };
    const out = generateBrief(skipped);
    expect(out).toContain("**Enrichment**: skipped (--no-enrich)");
  });

  test("renders fully-enriched label when no fallback occurred", () => {
    const allEnriched = {
      ...fixedScanResult(),
      enrichmentFailedCount: 0,
      candidates: fixedScanResult().candidates.map((c) => ({
        ...c,
        enrichmentSource: "enriched" as const,
      })),
    };
    const out = generateBrief(allEnriched);
    expect(out).toContain("**Enrichment**: 280/280 enriched");
    expect(out).not.toContain("_(chart-only)_");
  });

  test("brief still renders with zero candidates", () => {
    const empty = { ...fixedScanResult(), candidates: [], appsScanned: 0, costUsd: 0 };
    const out = generateBrief(empty);
    expect(out).toContain("## Top 0 candidates");
    expect(out).toContain("_No candidates passed scoring this run._");
  });
});
