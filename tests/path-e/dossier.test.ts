/**
 * Unit tests for the Stage 5 dossier generator.
 *
 * Pure unit tests — no IO, no DB, no fixtures. Each test feeds an in-memory
 * shortlist row through the pure functions and asserts on the rendered
 * markdown.
 */

import { describe, expect, test } from "bun:test";
import {
  buildDossier,
  DEFAULT_DOSSIER_TEMPLATE,
  findCandidate,
  parseCandidateRef,
  type ShortlistCandidate,
} from "../../src/path-e/dossier.ts";

function fullCandidate(overrides: Partial<ShortlistCandidate> = {}): ShortlistCandidate {
  return {
    app_id: "544007664",
    store: "apple",
    title: "Tidy Phone Pro",
    publisher_name: "Indie Studios LLC",
    publisher_app_count: 2,
    dna_class: "Productivity & Tools",
    dna_subclass: "File cleanup",
    markets_active: ["id", "th", "vn"],
    tenure_days_max: 318,
    best_rank: 12,
    has_subscription_iap: true,
    iap_count: 4,
    score: 0.7234,
    clonability_hypothesis: "CLONE: junk-file scanner with locale-aware media tags.",
    ...overrides,
  };
}

const FIXED_DATE = new Date("2026-05-10T12:00:00Z");

describe("parseCandidateRef", () => {
  test("happy path: app_id + apple", () => {
    expect(parseCandidateRef("544007664:apple")).toEqual({
      app_id: "544007664",
      store: "apple",
    });
  });

  test("happy path: dotted package id + googleplay", () => {
    expect(parseCandidateRef("com.example.tidyphone:googleplay")).toEqual({
      app_id: "com.example.tidyphone",
      store: "googleplay",
    });
  });

  test("error: empty string", () => {
    expect(() => parseCandidateRef("")).toThrow(/empty/);
  });

  test("error: missing colon", () => {
    expect(() => parseCandidateRef("544007664")).toThrow(/missing colon/);
  });

  test("error: unknown store", () => {
    expect(() => parseCandidateRef("544007664:windows")).toThrow(/unknown store/);
  });

  test("error: empty app_id", () => {
    expect(() => parseCandidateRef(":apple")).toThrow(/empty app_id/);
  });
});

describe("findCandidate", () => {
  test("finds the matching row inside a `shortlist` envelope", () => {
    const sl = {
      shortlist: [
        fullCandidate({ app_id: "111", store: "apple" }),
        fullCandidate({ app_id: "222", store: "googleplay" }),
      ],
    };
    const hit = findCandidate(sl, "222", "googleplay");
    expect(hit?.app_id).toBe("222");
    expect(hit?.store).toBe("googleplay");
  });

  test("returns null when no match", () => {
    const sl = { shortlist: [fullCandidate({ app_id: "111", store: "apple" })] };
    expect(findCandidate(sl, "999", "apple")).toBeNull();
  });

  test("accepts a top-level array", () => {
    const arr = [fullCandidate({ app_id: "abc", store: "apple" })];
    expect(findCandidate(arr, "abc", "apple")?.app_id).toBe("abc");
  });

  test("matches store strictly (apple vs googleplay)", () => {
    const sl = { shortlist: [fullCandidate({ app_id: "111", store: "apple" })] };
    expect(findCandidate(sl, "111", "googleplay")).toBeNull();
  });
});

describe("buildDossier with DEFAULT_DOSSIER_TEMPLATE", () => {
  test("renders all required sections with auto-populated candidate fields", () => {
    const md = buildDossier({
      slug: "tidyphone",
      candidate: fullCandidate(),
      shortlistSource: "/tmp/shortlist.json",
      now: FIXED_DATE,
    });

    // Front matter
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("slug: tidyphone");
    expect(md).toContain("stage: dossier");
    expect(md).toContain("verdict: PENDING");
    expect(md).toContain("date: 2026-05-10");
    expect(md).toContain("source: /tmp/shortlist.json");

    // Title
    expect(md).toContain("# tidyphone — discovery dossier (DRAFT)");

    // Auto-populated candidate
    expect(md).toContain("**App ID**: 544007664");
    expect(md).toContain("**Store**: apple");
    expect(md).toContain("**Title**: Tidy Phone Pro");
    expect(md).toContain("**Publisher**: Indie Studios LLC (apps: 2)");
    expect(md).toContain("**DNA**: Productivity & Tools / File cleanup");
    expect(md).toContain("**Markets active (tier-2 SEA top-100)**: id, th, vn");
    expect(md).toContain("**Tenure days (max)**: 318");
    expect(md).toContain("**Best rank**: 12");
    expect(md).toContain("**Subscription IAP**: yes (IAP count: 4)");
    expect(md).toContain("**Path E score**: 0.7234");
    expect(md).toContain("CLONE: junk-file scanner with locale-aware media tags.");

    // Section headings (the user fills these in)
    expect(md).toContain("## 2. Opportunity statement");
    expect(md).toContain("## 4. Nine strategic filters");
    expect(md).toContain("## 5. Business archetype");
    expect(md).toContain("## 6. ASO keywords");
    expect(md).toContain("## 7. AI hook decision");
    expect(md).toContain("## 8. Risk threshold compatibility");
    expect(md).toContain("## 9. Kill criteria (J60)");
    expect(md).toContain("## 10. Out of scope (v0)");
    expect(md).toContain("## 11. Founder signoff");

    // Nine filters present in the table
    expect(md).toContain("Solo-buildable in 4 weeks");
    expect(md).toContain("No content licensing dependencies");
    expect(md).toContain("No network-effect lock-in");
    expect(md).toContain("No regulatory exposure");
    expect(md).toContain("Market validation present");
    expect(md).toContain("ASO entry path exists");
    expect(md).toContain("Localization-as-moat OR other defensible wedge");
    expect(md).toContain("Privacy / ethical posture clean");
    expect(md).toContain("Multi-market same-template fit");

    // Risk threshold table — generic names, no studio-core paths
    expect(md).toContain("Max concurrent markets");
    expect(md).toContain("Capital per app validation");
    expect(md).toContain("Language quality minimum");
    expect(md).toContain("Kill ROAS d7");
    expect(md).toContain("Double-down ROAS d14");
    expect(md).toContain("Max portfolio apps");

    // Open-core boundary check — must NOT leak proprietary names
    expect(md).not.toContain("Atlas1m");
    expect(md).not.toContain("AppGap");
    expect(md).not.toContain("studio-core");
    expect(md).not.toContain("atlas1m-mobileapps");
  });

  test("renders has_subscription_iap=false as 'no'", () => {
    const md = buildDossier({
      slug: "x",
      candidate: fullCandidate({ has_subscription_iap: false }),
      shortlistSource: "s.json",
      now: FIXED_DATE,
    });
    expect(md).toContain("**Subscription IAP**: no");
  });

  test("missing optional fields render as empty string (not 'null')", () => {
    const md = buildDossier({
      slug: "x",
      candidate: {
        app_id: "1",
        store: "apple",
        title: null,
        publisher_name: null,
        publisher_app_count: null,
        dna_class: null,
        dna_subclass: null,
        markets_active: [],
        tenure_days_max: null,
        best_rank: null,
        has_subscription_iap: null,
        iap_count: null,
        score: null,
        clonability_hypothesis: null,
      },
      shortlistSource: "s.json",
      now: FIXED_DATE,
    });
    expect(md).not.toContain("null");
    expect(md).not.toContain("undefined");
    expect(md).toContain("**Title**: \n");
    expect(md).toContain("**Path E score**: \n");
  });

  test("uses today's date when `now` is omitted", () => {
    const md = buildDossier({
      slug: "x",
      candidate: fullCandidate(),
      shortlistSource: "s.json",
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(md).toContain(`date: ${today}`);
  });
});

describe("buildDossier with a custom template", () => {
  test("substitutes every supported token", () => {
    const template = [
      "slug={{slug}}",
      "date={{date}}",
      "src={{shortlist_source}}",
      "app_id={{candidate.app_id}}",
      "store={{candidate.store}}",
      "title={{candidate.title}}",
      "publisher_name={{candidate.publisher_name}}",
      "publisher_app_count={{candidate.publisher_app_count}}",
      "dna_class={{candidate.dna_class}}",
      "dna_subclass={{candidate.dna_subclass}}",
      "markets_active={{candidate.markets_active}}",
      "tenure_days_max={{candidate.tenure_days_max}}",
      "best_rank={{candidate.best_rank}}",
      "has_subscription_iap={{candidate.has_subscription_iap}}",
      "iap_count={{candidate.iap_count}}",
      "score={{candidate.score}}",
      "hypothesis={{candidate.clonability_hypothesis}}",
    ].join("\n");
    const md = buildDossier({
      slug: "demo",
      candidate: fullCandidate(),
      shortlistSource: "/tmp/sl.json",
      template,
      now: FIXED_DATE,
    });
    expect(md).toContain("slug=demo");
    expect(md).toContain("date=2026-05-10");
    expect(md).toContain("src=/tmp/sl.json");
    expect(md).toContain("app_id=544007664");
    expect(md).toContain("store=apple");
    expect(md).toContain("title=Tidy Phone Pro");
    expect(md).toContain("publisher_name=Indie Studios LLC");
    expect(md).toContain("publisher_app_count=2");
    expect(md).toContain("dna_class=Productivity & Tools");
    expect(md).toContain("dna_subclass=File cleanup");
    expect(md).toContain("markets_active=id, th, vn");
    expect(md).toContain("tenure_days_max=318");
    expect(md).toContain("best_rank=12");
    expect(md).toContain("has_subscription_iap=yes");
    expect(md).toContain("iap_count=4");
    expect(md).toContain("score=0.7234");
    expect(md).toContain("hypothesis=CLONE: junk-file scanner");
  });

  test("unknown tokens are preserved verbatim", () => {
    const template = "kept={{not_a_real_token}} known={{slug}}";
    const md = buildDossier({
      slug: "demo",
      candidate: fullCandidate(),
      shortlistSource: "s.json",
      template,
      now: FIXED_DATE,
    });
    expect(md).toContain("kept={{not_a_real_token}}");
    expect(md).toContain("known=demo");
  });

  test("empty optional fields render as empty string in custom templates", () => {
    const template =
      "title={{candidate.title}}|score={{candidate.score}}|hyp={{candidate.clonability_hypothesis}}";
    const md = buildDossier({
      slug: "x",
      candidate: { app_id: "1", store: "apple" },
      shortlistSource: "s.json",
      template,
      now: FIXED_DATE,
    });
    expect(md).toBe("title=|score=|hyp=");
  });
});

describe("DEFAULT_DOSSIER_TEMPLATE constant", () => {
  test("is a non-empty string with all 11 sections", () => {
    expect(typeof DEFAULT_DOSSIER_TEMPLATE).toBe("string");
    expect(DEFAULT_DOSSIER_TEMPLATE.length).toBeGreaterThan(500);
    for (let i = 1; i <= 11; i++) {
      expect(DEFAULT_DOSSIER_TEMPLATE).toContain(`## ${i}.`);
    }
  });
});
