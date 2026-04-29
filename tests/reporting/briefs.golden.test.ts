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
    expect(out).toContain("## Top 2 candidates");
    expect(out).toContain("### #1 — Cal AI: Calorie Tracker (apple, br) — composite 8.20/10");
    expect(out).toContain("### #2 — Remini (google, jp) — composite 6.40/10");
    expect(out).toContain("**Velocity**: scaffolding (J0/14)");
    expect(out).toContain("**Velocity**: 6.0/10");
    expect(out).toContain("**Cultural fit (vision)**: 7.0/10");
    expect(out).toContain("(no vision judge — empty screenshots)");
  });

  test("brief still renders with zero candidates", () => {
    const empty = { ...fixedScanResult(), candidates: [], appsScanned: 0, costUsd: 0 };
    const out = generateBrief(empty);
    expect(out).toContain("## Top 0 candidates");
    expect(out).toContain("_No candidates passed scoring this run._");
  });
});
