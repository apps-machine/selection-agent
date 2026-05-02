import { describe, expect, test } from "bun:test";
import {
  CitationSchema,
  KillMetricSchema,
  OpportunityCategorySchema,
  OpportunityMarketSchema,
  OpportunitySchema,
  SignalValuesSchema,
} from "../../src/opportunities/schema.ts";

const MIN_VALID = {
  id: "11111111-2222-4333-8444-555555555555",
  generated_at: "2026-05-02T12:00:00Z",
  source_app_id: "com.foo.bar",
  source_market: "us",
  target_market: "id",
  category: "productivity",
  signal_values: {},
  predicted: {},
  kill_metric: {
    metric: "roas_d14",
    threshold: 0.5,
    direction: "below",
  },
  score: null,
  eligible: false,
  thesis: "US productivity app strong on tier-1; ID storefront is English-only.",
  evidence: [
    {
      url: "https://example.com/source-app",
      claim: "Source app dominates US productivity charts.",
    },
  ],
  metadata: {},
} as const;

describe("OpportunityMarketSchema", () => {
  test("accepts every v1 market", () => {
    for (const m of [
      "us",
      "jp",
      "de",
      "fr",
      "br",
      "es",
      "id",
      "vn",
      "th",
      "my",
      "ph",
      "bd",
    ] as const) {
      expect(OpportunityMarketSchema.parse(m)).toBe(m);
    }
  });

  test("rejects unknown markets", () => {
    expect(() => OpportunityMarketSchema.parse("xx")).toThrow();
    expect(() => OpportunityMarketSchema.parse("US")).toThrow();
  });
});

describe("OpportunityCategorySchema", () => {
  test("accepts productivity, games, etc.", () => {
    for (const c of ["health", "productivity", "games", "lifestyle", "finance"] as const) {
      expect(OpportunityCategorySchema.parse(c)).toBe(c);
    }
  });

  test("rejects unknown category", () => {
    expect(() => OpportunityCategorySchema.parse("metaverse")).toThrow();
  });
});

describe("CitationSchema", () => {
  test("parses minimal citation (url + claim)", () => {
    const c = CitationSchema.parse({
      url: "https://news.ycombinator.com/item?id=1",
      claim: "Reported MRR.",
    });
    expect(c.source_quote).toBeUndefined();
  });

  test("parses citation with source_quote", () => {
    const c = CitationSchema.parse({
      url: "https://news.ycombinator.com/item?id=1",
      claim: "Reported MRR.",
      source_quote: "We hit $20k MRR in month 6.",
    });
    expect(c.source_quote).toBe("We hit $20k MRR in month 6.");
  });

  test("rejects invalid URL", () => {
    expect(() => CitationSchema.parse({ url: "not-a-url", claim: "x" })).toThrow();
  });

  test("rejects empty claim", () => {
    expect(() => CitationSchema.parse({ url: "https://example.com", claim: "" })).toThrow();
  });
});

describe("KillMetricSchema", () => {
  test("parses valid below kill metric", () => {
    expect(
      KillMetricSchema.parse({ metric: "roas_d14", threshold: 0.5, direction: "below" }),
    ).toEqual({
      metric: "roas_d14",
      threshold: 0.5,
      direction: "below",
    });
  });

  test("parses valid above kill metric", () => {
    expect(KillMetricSchema.parse({ metric: "cpi", threshold: 5.0, direction: "above" })).toEqual({
      metric: "cpi",
      threshold: 5.0,
      direction: "above",
    });
  });

  test("rejects unknown direction", () => {
    expect(() =>
      KillMetricSchema.parse({ metric: "roas_d14", threshold: 0.5, direction: "wrong" }),
    ).toThrow();
  });

  test("rejects empty metric name", () => {
    expect(() =>
      KillMetricSchema.parse({ metric: "", threshold: 0.5, direction: "below" }),
    ).toThrow();
  });
});

describe("SignalValuesSchema", () => {
  test("accepts empty object (all signals missing)", () => {
    expect(SignalValuesSchema.parse({})).toEqual({});
  });

  test("accepts all 4 signals null", () => {
    const sv = SignalValuesSchema.parse({
      locGap: null,
      velocity: null,
      incumbent_vulnerability: null,
      cpi_ltv_proxy: null,
    });
    expect(sv.locGap).toBeNull();
    expect(sv.velocity).toBeNull();
  });

  test("accepts all 4 signals as valid scores", () => {
    const sv = SignalValuesSchema.parse({
      locGap: 7.5,
      velocity: 6.0,
      incumbent_vulnerability: 8.2,
      cpi_ltv_proxy: 5.5,
    });
    expect(sv.locGap).toBe(7.5);
    expect(sv.cpi_ltv_proxy).toBe(5.5);
  });

  test("rejects signal > 10", () => {
    expect(() => SignalValuesSchema.parse({ locGap: 12 })).toThrow();
  });

  test("rejects signal < 0", () => {
    expect(() => SignalValuesSchema.parse({ velocity: -1 })).toThrow();
  });
});

describe("OpportunitySchema — happy paths", () => {
  test("parses minimal valid Opportunity", () => {
    const parsed = OpportunitySchema.parse(MIN_VALID);
    expect(parsed.id).toBe(MIN_VALID.id);
    expect(parsed.eligible).toBe(false);
    expect(parsed.score).toBeNull();
    expect(parsed.signal_values).toEqual({});
  });

  test("parses full Opportunity with signals, predicted, outcome, metadata", () => {
    const full = {
      ...MIN_VALID,
      signal_values: {
        locGap: 7.5,
        velocity: 6.0,
        incumbent_vulnerability: 8.0,
        cpi_ltv_proxy: 5.5,
      },
      predicted: {
        cpi_low: 0.5,
        cpi_high: 1.5,
        ltv_low: 2.0,
        ltv_high: 4.0,
        validation_budget_usd: 500,
      },
      score: 7.2,
      eligible: true,
      actual_outcome: {
        measured_at: "2027-05-02T12:00:00Z",
        metric_value: 0.8,
        label: "winner" as const,
        revenue_proven: 4_500,
      },
      evidence: [
        { url: "https://example.com/a", claim: "Claim A." },
        { url: "https://example.com/b", claim: "Claim B.", source_quote: "Quote." },
      ],
      metadata: {
        signal_pipeline_version: "v1.0.0",
        scoring_version: "top3-mean-v1",
        mechanic_evidence: "App uses swipeable card metaphor consistent with TikTok pattern.",
      },
    };
    const parsed = OpportunitySchema.parse(full);
    expect(parsed.score).toBe(7.2);
    expect(parsed.actual_outcome?.label).toBe("winner");
    expect(parsed.evidence).toHaveLength(2);
    expect(parsed.metadata.mechanic_evidence).toContain("swipeable");
  });

  test("score=null + eligible=true is schema-accepted (downstream invariant)", () => {
    // Schema does not enforce score/eligible coupling — composer does.
    // See OpportunitySchema doc comment for rationale.
    const inconsistent = { ...MIN_VALID, score: null, eligible: true };
    const parsed = OpportunitySchema.parse(inconsistent);
    expect(parsed.score).toBeNull();
    expect(parsed.eligible).toBe(true);
  });

  test("score=number + eligible=false is schema-accepted (downstream invariant)", () => {
    const inconsistent = { ...MIN_VALID, score: 6.5, eligible: false };
    const parsed = OpportunitySchema.parse(inconsistent);
    expect(parsed.score).toBe(6.5);
    expect(parsed.eligible).toBe(false);
  });
});

describe("OpportunitySchema — load-bearing field rejections", () => {
  test("rejects when id missing", () => {
    const { id: _, ...rest } = MIN_VALID;
    expect(() => OpportunitySchema.parse(rest)).toThrow();
  });

  test("rejects when id is not a UUID", () => {
    expect(() => OpportunitySchema.parse({ ...MIN_VALID, id: "not-a-uuid" })).toThrow();
  });

  test("rejects when source_app_id missing", () => {
    const { source_app_id: _, ...rest } = MIN_VALID;
    expect(() => OpportunitySchema.parse(rest)).toThrow();
  });

  test("rejects when source_market missing", () => {
    const { source_market: _, ...rest } = MIN_VALID;
    expect(() => OpportunitySchema.parse(rest)).toThrow();
  });

  test("rejects when target_market missing", () => {
    const { target_market: _, ...rest } = MIN_VALID;
    expect(() => OpportunitySchema.parse(rest)).toThrow();
  });

  test("rejects when category missing", () => {
    const { category: _, ...rest } = MIN_VALID;
    expect(() => OpportunitySchema.parse(rest)).toThrow();
  });

  test("rejects when kill_metric missing", () => {
    const { kill_metric: _, ...rest } = MIN_VALID;
    expect(() => OpportunitySchema.parse(rest)).toThrow();
  });

  test("rejects when thesis missing", () => {
    const { thesis: _, ...rest } = MIN_VALID;
    expect(() => OpportunitySchema.parse(rest)).toThrow();
  });

  test("rejects when thesis is empty string", () => {
    expect(() => OpportunitySchema.parse({ ...MIN_VALID, thesis: "" })).toThrow();
  });

  test("rejects when evidence missing", () => {
    const { evidence: _, ...rest } = MIN_VALID;
    expect(() => OpportunitySchema.parse(rest)).toThrow();
  });

  test("rejects when evidence is empty array", () => {
    expect(() => OpportunitySchema.parse({ ...MIN_VALID, evidence: [] })).toThrow();
  });

  test("rejects when evidence contains invalid URL", () => {
    expect(() =>
      OpportunitySchema.parse({
        ...MIN_VALID,
        evidence: [{ url: "not a url at all", claim: "x" }],
      }),
    ).toThrow();
  });

  test("rejects when kill_metric has malformed direction enum", () => {
    expect(() =>
      OpportunitySchema.parse({
        ...MIN_VALID,
        kill_metric: { metric: "roas_d14", threshold: 0.5, direction: "wrong" },
      }),
    ).toThrow();
  });

  test("rejects when actual_outcome.label is malformed enum", () => {
    expect(() =>
      OpportunitySchema.parse({
        ...MIN_VALID,
        actual_outcome: {
          measured_at: "2027-05-02T12:00:00Z",
          metric_value: 0.8,
          label: "champion",
        },
      }),
    ).toThrow();
  });

  test("rejects when score > 10", () => {
    expect(() => OpportunitySchema.parse({ ...MIN_VALID, score: 15 })).toThrow();
  });

  test("rejects when score < 0", () => {
    expect(() => OpportunitySchema.parse({ ...MIN_VALID, score: -1 })).toThrow();
  });

  test("rejects when generated_at is not ISO8601 datetime", () => {
    expect(() => OpportunitySchema.parse({ ...MIN_VALID, generated_at: "2026-05-02" })).toThrow();
  });
});
