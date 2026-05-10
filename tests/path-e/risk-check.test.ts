/**
 * Unit tests for the Stage 3 risk-check evaluator.
 *
 * These exercise each of the five threshold checks independently, the
 * aggregate verdict logic, and the Zod schema parsing (full / partial /
 * invalid). Pure unit tests — no IO, no fixtures, no DB.
 */

import { describe, expect, test } from "bun:test";
import {
  evaluateCandidate,
  evaluateShortlist,
  type RiskCheckCandidate,
} from "../../src/path-e/risk-check.ts";
import {
  DEFAULT_CLONABLE_DNA_CLASSES,
  DEFAULT_SUPPORTED_MARKETS,
  RiskThresholdsSchema,
} from "../../src/path-e/risk-thresholds.ts";

function baseCandidate(overrides: Partial<RiskCheckCandidate> = {}): RiskCheckCandidate {
  return {
    app_id: "app1",
    store: "apple",
    markets_active: ["id", "vn", "th"],
    tenure_days_max: 200,
    has_subscription_iap: true,
    dna_class: "Productivity & Tools",
    ...overrides,
  };
}

const DEFAULTS = RiskThresholdsSchema.parse({});

describe("RiskThresholdsSchema", () => {
  test("empty object parses to fully populated defaults", () => {
    const t = RiskThresholdsSchema.parse({});
    expect(t.maxConcurrentMarkets).toBe(3);
    expect(t.minTenureDays).toBe(180);
    expect(t.requireSubscriptionIap).toBe(false);
    expect(t.supportedMarkets).toEqual([...DEFAULT_SUPPORTED_MARKETS]);
    expect(t.clonableDnaClasses).toEqual([...DEFAULT_CLONABLE_DNA_CLASSES]);
  });

  test("partial JSON fills in missing defaults", () => {
    const t = RiskThresholdsSchema.parse({ maxConcurrentMarkets: 5 });
    expect(t.maxConcurrentMarkets).toBe(5);
    expect(t.minTenureDays).toBe(180);
    expect(t.requireSubscriptionIap).toBe(false);
  });

  test("rejects invalid market codes (length != 2)", () => {
    expect(() =>
      RiskThresholdsSchema.parse({ supportedMarkets: ["usa", "id"] }),
    ).toThrow();
  });

  test("rejects out-of-range maxConcurrentMarkets", () => {
    expect(() => RiskThresholdsSchema.parse({ maxConcurrentMarkets: 0 })).toThrow();
    expect(() => RiskThresholdsSchema.parse({ maxConcurrentMarkets: 11 })).toThrow();
  });

  test("rejects non-integer minTenureDays", () => {
    expect(() => RiskThresholdsSchema.parse({ minTenureDays: 90.5 })).toThrow();
  });
});

describe("markets_spread check", () => {
  test("PASS when markets >= maxConcurrentMarkets", () => {
    const r = evaluateCandidate(baseCandidate({ markets_active: ["id", "vn", "th"] }), DEFAULTS);
    const c = r.checks.find((x) => x.name === "markets_spread");
    expect(c?.status).toBe("PASS");
    expect(c?.details).toContain("3 markets");
  });

  test("FAIL when markets < maxConcurrentMarkets", () => {
    const r = evaluateCandidate(baseCandidate({ markets_active: ["id", "vn"] }), DEFAULTS);
    const c = r.checks.find((x) => x.name === "markets_spread");
    expect(c?.status).toBe("FAIL");
  });

  test("FAIL when markets is empty", () => {
    const r = evaluateCandidate(baseCandidate({ markets_active: [] }), DEFAULTS);
    const c = r.checks.find((x) => x.name === "markets_spread");
    expect(c?.status).toBe("FAIL");
  });
});

describe("tenure check", () => {
  test("PASS when tenure >= minTenureDays", () => {
    const r = evaluateCandidate(baseCandidate({ tenure_days_max: 180 }), DEFAULTS);
    const c = r.checks.find((x) => x.name === "tenure");
    expect(c?.status).toBe("PASS");
  });

  test("FAIL when tenure < minTenureDays", () => {
    const r = evaluateCandidate(baseCandidate({ tenure_days_max: 90 }), DEFAULTS);
    const c = r.checks.find((x) => x.name === "tenure");
    expect(c?.status).toBe("FAIL");
    expect(c?.details).toContain("90");
  });
});

describe("subscription_iap check", () => {
  test("INFO when requireSubscriptionIap=false (default)", () => {
    const r = evaluateCandidate(baseCandidate({ has_subscription_iap: false }), DEFAULTS);
    const c = r.checks.find((x) => x.name === "subscription_iap");
    expect(c?.status).toBe("INFO");
  });

  test("PASS when requireSubscriptionIap=true and candidate has it", () => {
    const t = RiskThresholdsSchema.parse({ requireSubscriptionIap: true });
    const r = evaluateCandidate(baseCandidate({ has_subscription_iap: true }), t);
    const c = r.checks.find((x) => x.name === "subscription_iap");
    expect(c?.status).toBe("PASS");
  });

  test("FAIL when requireSubscriptionIap=true and candidate lacks it", () => {
    const t = RiskThresholdsSchema.parse({ requireSubscriptionIap: true });
    const r = evaluateCandidate(baseCandidate({ has_subscription_iap: false }), t);
    const c = r.checks.find((x) => x.name === "subscription_iap");
    expect(c?.status).toBe("FAIL");
  });
});

describe("supported_markets check", () => {
  test("PASS when all markets are supported", () => {
    const r = evaluateCandidate(baseCandidate({ markets_active: ["id", "vn"] }), DEFAULTS);
    const c = r.checks.find((x) => x.name === "supported_markets");
    expect(c?.status).toBe("PASS");
  });

  test("WARN when some markets are unsupported", () => {
    const t = RiskThresholdsSchema.parse({ supportedMarkets: ["id", "vn"] });
    const r = evaluateCandidate(baseCandidate({ markets_active: ["id", "xx", "vn"] }), t);
    const c = r.checks.find((x) => x.name === "supported_markets");
    expect(c?.status).toBe("WARN");
    expect(c?.details).toContain("xx");
  });

  test("FAIL when no markets are supported", () => {
    const t = RiskThresholdsSchema.parse({ supportedMarkets: ["us"] });
    const r = evaluateCandidate(baseCandidate({ markets_active: ["id", "vn"] }), t);
    const c = r.checks.find((x) => x.name === "supported_markets");
    expect(c?.status).toBe("FAIL");
  });

  test("FAIL when markets_active is empty", () => {
    const r = evaluateCandidate(baseCandidate({ markets_active: [] }), DEFAULTS);
    const c = r.checks.find((x) => x.name === "supported_markets");
    expect(c?.status).toBe("FAIL");
  });
});

describe("clonable_dna check", () => {
  test("PASS when dna_class is in the clonable set", () => {
    const r = evaluateCandidate(baseCandidate({ dna_class: "Productivity & Tools" }), DEFAULTS);
    const c = r.checks.find((x) => x.name === "clonable_dna");
    expect(c?.status).toBe("PASS");
  });

  test("FAIL when dna_class is not in the clonable set", () => {
    const r = evaluateCandidate(baseCandidate({ dna_class: "MMORPG" }), DEFAULTS);
    const c = r.checks.find((x) => x.name === "clonable_dna");
    expect(c?.status).toBe("FAIL");
  });

  test("FAIL when dna_class is null", () => {
    const r = evaluateCandidate(baseCandidate({ dna_class: null }), DEFAULTS);
    const c = r.checks.find((x) => x.name === "clonable_dna");
    expect(c?.status).toBe("FAIL");
    expect(c?.details).toContain("null");
  });
});

describe("aggregate verdict", () => {
  test("PASS when all checks PASS (or INFO)", () => {
    const r = evaluateCandidate(baseCandidate(), DEFAULTS);
    expect(r.overall).toBe("PASS");
  });

  test("FAIL when any check FAILs", () => {
    const r = evaluateCandidate(baseCandidate({ tenure_days_max: 30 }), DEFAULTS);
    expect(r.overall).toBe("FAIL");
  });

  test("WARN when no FAILs and at least one WARN", () => {
    const t = RiskThresholdsSchema.parse({ supportedMarkets: ["id", "vn"] });
    const r = evaluateCandidate(baseCandidate({ markets_active: ["id", "xx", "vn"] }), t);
    expect(r.overall).toBe("WARN");
  });

  test("INFO does not contribute to aggregate (PASS overall when only INFO present alongside PASSes)", () => {
    const r = evaluateCandidate(baseCandidate({ has_subscription_iap: false }), DEFAULTS);
    // subscription_iap is INFO (not required); rest PASS → overall PASS
    expect(r.overall).toBe("PASS");
    const sub = r.checks.find((x) => x.name === "subscription_iap");
    expect(sub?.status).toBe("INFO");
  });

  test("FAIL beats WARN", () => {
    const t = RiskThresholdsSchema.parse({
      supportedMarkets: ["id", "vn"],
      requireSubscriptionIap: true,
    });
    const r = evaluateCandidate(
      baseCandidate({ markets_active: ["id", "xx", "vn"], has_subscription_iap: false }),
      t,
    );
    expect(r.overall).toBe("FAIL");
  });
});

describe("evaluateShortlist", () => {
  test("annotates each candidate and tallies the summary", () => {
    const cands: RiskCheckCandidate[] = [
      baseCandidate({ app_id: "passing", markets_active: ["id", "vn", "th"] }),
      baseCandidate({ app_id: "failing", tenure_days_max: 10 }),
      baseCandidate({ app_id: "warning", markets_active: ["id", "xx", "vn"] }),
    ];
    const t = RiskThresholdsSchema.parse({ supportedMarkets: ["id", "vn", "th"] });
    const result = evaluateShortlist(cands, t);
    expect(result.summary.total).toBe(3);
    expect(result.summary.pass).toBe(1);
    expect(result.summary.warn).toBe(1);
    expect(result.summary.fail).toBe(1);
    expect(result.candidates[0]?.risk_check.overall).toBe("PASS");
    expect(result.candidates[1]?.risk_check.overall).toBe("FAIL");
    expect(result.candidates[2]?.risk_check.overall).toBe("WARN");
  });

  test("returns empty summary on empty input", () => {
    const r = evaluateShortlist([], DEFAULTS);
    expect(r.summary).toEqual({ total: 0, pass: 0, warn: 0, fail: 0 });
    expect(r.candidates).toEqual([]);
  });

  test("preserves passthrough fields on annotated candidates", () => {
    const cand = baseCandidate({ app_id: "x1" }) as RiskCheckCandidate & {
      score: number;
      title: string;
    };
    cand.score = 0.93;
    cand.title = "X1";
    const r = evaluateShortlist([cand], DEFAULTS);
    const annotated = r.candidates[0] as typeof cand & {
      risk_check: { overall: string };
    };
    expect(annotated.score).toBe(0.93);
    expect(annotated.title).toBe("X1");
    expect(annotated.risk_check.overall).toBe("PASS");
  });
});
