import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Opportunity } from "../../src/opportunities/schema.ts";
import { OpportunitySchema } from "../../src/opportunities/schema.ts";
import {
  deriveTags,
  renderBrief,
  THESIS_PROMPT_VERSION,
  type ThesisLlmClient,
} from "../../src/reporting/briefs.ts";
import { runMigrations } from "../../src/storage/schema.ts";
import { fixedOpportunity } from "./briefs.fixtures.ts";

// ─── Test doubles ─────────────────────────────────────────────────────

interface CapturedThesisCall {
  attempts: number;
  model: string;
  promptIncludes: string[];
}

function makeThesisClient(
  responses: Array<
    { kind: "ok"; text: string } | { kind: "throw"; error: unknown } | { kind: "empty" }
  >,
): { client: ThesisLlmClient; captured: CapturedThesisCall } {
  const captured: CapturedThesisCall = {
    attempts: 0,
    model: "",
    promptIncludes: [],
  };
  const client: ThesisLlmClient = {
    messages: {
      create: async (params: unknown) => {
        const idx = captured.attempts;
        captured.attempts += 1;
        const p = params as {
          model: string;
          messages: Array<{ content: string }>;
        };
        captured.model = p.model;
        captured.promptIncludes = [p.messages[0]?.content ?? ""];
        const r = responses[idx];
        if (!r) throw new Error(`no mock thesis response at idx ${idx}`);
        if (r.kind === "throw") throw r.error;
        if (r.kind === "empty") {
          return {
            id: "msg",
            type: "message" as const,
            role: "assistant" as const,
            content: [],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 0 },
          };
        }
        return {
          id: "msg",
          type: "message" as const,
          role: "assistant" as const,
          content: [{ type: "text" as const, text: r.text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 60 },
        };
      },
    },
  };
  return { client, captured };
}

function panicClient(): ThesisLlmClient {
  return {
    messages: {
      create: async () => {
        throw new Error("panicClient: LLM was called when it should not have been");
      },
    },
  };
}

function inMemoryDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

// ─── Happy path ───────────────────────────────────────────────────────

describe("renderBrief — happy path", () => {
  test("full Opportunity renders all sections with dryRun thesis", async () => {
    const opp = fixedOpportunity();
    const out = await renderBrief(opp, { dryRun: true });

    // Source / Target
    expect(out).toContain("**Source:** com.example.calai in us");
    expect(out).toContain("**Target:** id");

    // Thesis (dry-run placeholder)
    expect(out).toContain("**Thesis**");
    expect(out).toContain("Thesis: [dry-run placeholder]");

    // Signals — all four present + mechanic_evidence
    expect(out).toContain("**Signals**");
    expect(out).toContain("- locGap: 8.5/10");
    expect(out).toContain("- velocity: 6.0/10");
    expect(out).toContain("- incumbent_vulnerability: 7.5/10");
    expect(out).toContain("- cpi_ltv_proxy: 7.0/10");
    expect(out).toContain("- mechanic_evidence: Core loop: photograph meal");

    // Predicted economics
    expect(out).toContain("**Predicted economics**");
    expect(out).toContain("CPI: $0.5-$1.5");
    expect(out).toContain("LTV: $4-$12");
    expect(out).toContain("Capital to validate: $500");

    // Tags — should derive at least tier2-localization (locGap 8.5 > 7 + market in TIER_2)
    expect(out).toContain("**Tags:**");
    expect(out).toContain("tier2-localization");

    // Validation plan
    expect(out).toContain("**Validation plan**");
    expect(out).toContain("Step 1:");
    expect(out).toContain("Kill criterion: roas_d14 below 0.4");

    // Evidence
    expect(out).toContain("**Evidence**");
    expect(out).toContain("https://apps.apple.com/id/app/cal-ai/id1234567890 — Cal AI listing");
    expect(out).toContain("https://www.indiehackers.com/post/cal-ai-mrr-300k");

    // Output validates as a non-empty string
    expect(out.length).toBeGreaterThan(200);
  });

  test("fixedOpportunity validates against the Opportunity Zod schema", () => {
    // Defensive: make sure the fixture itself remains contract-conformant
    // so test assumptions don't drift away from the production shape.
    const opp = fixedOpportunity();
    const parsed = OpportunitySchema.safeParse(opp);
    if (!parsed.success) {
      throw new Error(`fixture invalid: ${parsed.error.message}`);
    }
    expect(parsed.success).toBe(true);
  });
});

// ─── Null safety: signals ─────────────────────────────────────────────

describe("renderBrief — null safety", () => {
  test("missing signals omitted, not rendered as null/10", async () => {
    const opp = fixedOpportunity({
      signal_values: {
        locGap: null,
        velocity: 5,
        incumbent_vulnerability: null,
        cpi_ltv_proxy: 7,
      },
    });
    const out = await renderBrief(opp, { dryRun: true });

    // The two non-null signals appear
    expect(out).toContain("- velocity: 5.0/10");
    expect(out).toContain("- cpi_ltv_proxy: 7.0/10");

    // The two null signals do NOT appear at all
    expect(out).not.toContain("- locGap");
    expect(out).not.toContain("- incumbent_vulnerability");

    // No literal "null" string crept in
    expect(out).not.toContain("null/10");
    expect(out).not.toContain(": null");
  });

  test("all signals null → '(none computed)' placeholder", async () => {
    const opp = fixedOpportunity({
      signal_values: {
        locGap: null,
        velocity: null,
        incumbent_vulnerability: null,
        cpi_ltv_proxy: null,
      },
      // mechanic also stripped so the section is fully empty
      metadata: {
        signal_pipeline_version: "v1.0.0",
        scoring_version: "v1.0.0",
      },
    });
    const out = await renderBrief(opp, { dryRun: true });
    expect(out).toContain("**Signals**");
    expect(out).toContain("(none computed)");
  });

  test("missing cpi_high → omits range, shows just cpi_low+", async () => {
    const opp = fixedOpportunity({
      predicted: {
        cpi_low: 0.5,
        // cpi_high absent
        ltv_low: 4,
        ltv_high: 12,
        validation_budget_usd: 500,
      },
    });
    const out = await renderBrief(opp, { dryRun: true });
    expect(out).toContain("CPI: $0.5+");
    expect(out).not.toContain("CPI: $0.5-");
    expect(out).toContain("LTV: $4-$12");
  });

  test("predicted entirely missing → '(no predictions)' placeholder", async () => {
    const opp = fixedOpportunity({ predicted: {} });
    const out = await renderBrief(opp, { dryRun: true });
    expect(out).toContain("**Predicted economics**");
    expect(out).toContain("(no predictions)");
  });

  test("no tags derived → 'Tags: (none derived)'", async () => {
    // All thresholds intentionally NOT met
    const opp = fixedOpportunity({
      target_market: "us", // tier-1, blocks tier2-localization
      signal_values: {
        locGap: 5, // < 7
        velocity: 5, // < 7
        incumbent_vulnerability: 4, // < 7
        cpi_ltv_proxy: 4, // < 6
      },
    });
    const out = await renderBrief(opp, { dryRun: true });
    expect(out).toContain("**Tags:** (none derived)");
  });

  test("mechanic_evidence missing in metadata → mechanic line omitted", async () => {
    const opp = fixedOpportunity({
      metadata: {
        signal_pipeline_version: "v1.0.0",
        scoring_version: "v1.0.0",
      },
    });
    const out = await renderBrief(opp, { dryRun: true });
    expect(out).not.toContain("mechanic_evidence");
  });

  test("evidence array empty → renderBrief throws", async () => {
    // Bypass the Zod schema (which enforces ≥1) by hand-constructing the object.
    // This is the defensive guard for callers that bypass schema validation.
    const opp = fixedOpportunity({ evidence: [] as unknown as Opportunity["evidence"] });
    await expect(renderBrief(opp, { dryRun: true })).rejects.toThrow(/evidence is empty/);
  });
});

// ─── Tag derivation ───────────────────────────────────────────────────

describe("deriveTags — null safety + threshold checks (Codex Round 2 #5)", () => {
  test("full Opportunity in tier-2 with all signals firing → all 3 tags", () => {
    const opp = fixedOpportunity({
      target_market: "id", // tier-2 SEA
      signal_values: {
        locGap: 8, // > 7 ⇒ tier2-localization (with id)
        velocity: 8, // > 7 ⇒ hot-wave candidate (but locGap > 4 disqualifies)
        incumbent_vulnerability: 8, // > 7
        cpi_ltv_proxy: 7, // > 6 ⇒ incumbent-toppling
      },
    });
    const tags = deriveTags(opp);
    expect(tags).toContain("tier2-localization");
    expect(tags).toContain("incumbent-toppling");
    // hot-wave: requires locGap < 4 OR null. Our locGap is 8, so NOT hot-wave.
    expect(tags).not.toContain("hot-wave");
  });

  test("hot-wave fires when locGap is null and velocity > 7", () => {
    const opp = fixedOpportunity({
      target_market: "us", // tier-1, no tier2-localization
      signal_values: {
        locGap: null, // explicit null
        velocity: 9, // > 7
        incumbent_vulnerability: 5,
        cpi_ltv_proxy: 5,
      },
    });
    const tags = deriveTags(opp);
    expect(tags).toContain("hot-wave");
    expect(tags).not.toContain("tier2-localization");
    expect(tags).not.toContain("incumbent-toppling");
  });

  test("hot-wave fires when locGap < 4 and velocity > 7", () => {
    const opp = fixedOpportunity({
      target_market: "us",
      signal_values: {
        locGap: 2, // < 4
        velocity: 9,
        incumbent_vulnerability: 5,
        cpi_ltv_proxy: 5,
      },
    });
    expect(deriveTags(opp)).toContain("hot-wave");
  });

  test("all 3 tags possible when locGap is null + velocity high + incumbent high", () => {
    // Edge case: with locGap=null, tier2-localization can't fire (rule
    // requires locGap > 7), but hot-wave + incumbent-toppling can both fire.
    const opp = fixedOpportunity({
      target_market: "id",
      signal_values: {
        locGap: null,
        velocity: 9,
        incumbent_vulnerability: 8,
        cpi_ltv_proxy: 7,
      },
    });
    const tags = deriveTags(opp);
    expect(tags).toContain("hot-wave");
    expect(tags).toContain("incumbent-toppling");
    expect(tags).not.toContain("tier2-localization");
  });

  test("null signals never crash threshold checks (undefined > N silently false bug)", () => {
    // Codex Round 2 #5: the bug is that `undefined > 7` silently evaluates
    // false, which would lead to silent missed tags rather than a crash.
    // The explicit null check turns the silent miss into intentional behavior.
    // This test asserts deriveTags() does NOT throw and returns [] for an
    // opportunity with all-null signals.
    const opp = fixedOpportunity({
      signal_values: {
        locGap: null,
        velocity: null,
        incumbent_vulnerability: null,
        cpi_ltv_proxy: null,
      },
    });
    expect(() => deriveTags(opp)).not.toThrow();
    expect(deriveTags(opp)).toEqual([]);
  });

  test("tier2-localization requires BOTH high locGap AND tier-2 market", () => {
    // High locGap in tier-1 market → NO tag
    const tier1 = fixedOpportunity({
      target_market: "us",
      signal_values: {
        locGap: 9,
        velocity: 5,
        incumbent_vulnerability: 5,
        cpi_ltv_proxy: 5,
      },
    });
    expect(deriveTags(tier1)).not.toContain("tier2-localization");

    // Low locGap in tier-2 market → NO tag
    const tier2LowGap = fixedOpportunity({
      target_market: "id",
      signal_values: {
        locGap: 6,
        velocity: 5,
        incumbent_vulnerability: 5,
        cpi_ltv_proxy: 5,
      },
    });
    expect(deriveTags(tier2LowGap)).not.toContain("tier2-localization");
  });

  test("incumbent-toppling requires BOTH incumbent_vuln > 7 AND cpi_ltv_proxy > 6", () => {
    // High vuln but low cpi_ltv → no tag
    const onlyVuln = fixedOpportunity({
      signal_values: {
        locGap: 3,
        velocity: 3,
        incumbent_vulnerability: 9,
        cpi_ltv_proxy: 5, // < 6
      },
    });
    expect(deriveTags(onlyVuln)).not.toContain("incumbent-toppling");

    // High cpi_ltv but low vuln → no tag
    const onlyCpi = fixedOpportunity({
      signal_values: {
        locGap: 3,
        velocity: 3,
        incumbent_vulnerability: 5, // < 7
        cpi_ltv_proxy: 8,
      },
    });
    expect(deriveTags(onlyCpi)).not.toContain("incumbent-toppling");
  });

  test("no mechanic-export tag emitted in v1 (only re-introduced in v2)", () => {
    // The deleted mechanic-export tag is a guardrail check: ensure no path
    // accidentally re-emits it.
    const opp = fixedOpportunity({
      target_market: "id",
      signal_values: {
        locGap: 9,
        velocity: 9,
        incumbent_vulnerability: 9,
        cpi_ltv_proxy: 9,
      },
      metadata: {
        signal_pipeline_version: "v1.0.0",
        scoring_version: "v1.0.0",
        mechanic_evidence: "Some loop description.",
      },
    });
    expect(deriveTags(opp)).not.toContain("mechanic-export");
  });
});

// ─── LLM thesis call + persistence ────────────────────────────────────

describe("renderBrief — LLM thesis call + provenance", () => {
  test("dryRun=true → no LLM call, placeholder thesis", async () => {
    const opp = fixedOpportunity();
    const out = await renderBrief(opp, { dryRun: true, client: panicClient() });
    expect(out).toContain("Thesis: [dry-run placeholder]");
  });

  test("dryRun=false with mocked client → renders LLM thesis", async () => {
    const opp = fixedOpportunity();
    const { client, captured } = makeThesisClient([
      {
        kind: "ok",
        text: "Bahasa Indonesia opportunity for calorie tracking — Cal AI is unlocalized.",
      },
    ]);
    const out = await renderBrief(opp, { client });

    expect(out).toContain("Bahasa Indonesia opportunity for calorie tracking");
    expect(captured.attempts).toBe(1);
    expect(captured.model).toBe("claude-opus-4-7"); // DEFAULT_THESIS_MODEL

    // The prompt should include opportunity context
    const promptText = captured.promptIncludes[0] ?? "";
    expect(promptText).toContain("com.example.calai");
    expect(promptText).toContain("id"); // target market
    expect(promptText).toContain("locGap"); // signals embedded
  });

  test("dryRun=false + persist → writes signal_snapshots row with full provenance", async () => {
    const opp = fixedOpportunity();
    const { client } = makeThesisClient([{ kind: "ok", text: "Generated thesis paragraph here." }]);
    const db = inMemoryDb();
    const t = 1_700_000_000_000;

    await renderBrief(opp, {
      client,
      persist: { db, t },
      clock: () => 1_700_000_005_000,
    });

    const row = db
      .prepare<
        {
          app_id: string;
          signal_name: string;
          t: number;
          value: number | null;
          llm_model: string;
          llm_prompt_version: string;
          llm_request_hash: string;
          llm_response_hash: string;
          llm_response_archived: string;
          source_urls_json: string;
          computed_at: number;
        },
        []
      >(
        `SELECT app_id, signal_name, t, value, llm_model, llm_prompt_version,
                llm_request_hash, llm_response_hash, llm_response_archived,
                source_urls_json, computed_at
           FROM signal_snapshots
           WHERE signal_name = 'thesis'`,
      )
      .get();

    expect(row).not.toBeNull();
    if (!row) throw new Error("unreachable");
    expect(row.app_id).toBe("com.example.calai");
    expect(row.signal_name).toBe("thesis");
    expect(row.t).toBe(t);
    expect(row.value).toBeNull(); // thesis is text, not a number
    expect(row.llm_model).toBe("claude-opus-4-7");
    expect(row.llm_prompt_version).toBe(THESIS_PROMPT_VERSION);
    expect(row.llm_request_hash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
    expect(row.llm_response_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.llm_response_archived).toBe("Generated thesis paragraph here.");
    expect(row.source_urls_json).toBe("[]");
    expect(row.computed_at).toBe(1_700_000_005_000);
  });

  test("dryRun=true + persist provided → does NOT write to signal_snapshots", async () => {
    // Documented behavior: dryRun is a pure rendering path with no I/O. The
    // placeholder thesis isn't worth archiving.
    const opp = fixedOpportunity();
    const db = inMemoryDb();
    await renderBrief(opp, { dryRun: true, persist: { db, t: 0 } });
    const count = db
      .prepare<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM signal_snapshots WHERE signal_name = 'thesis'",
      )
      .get();
    expect(count?.n ?? 0).toBe(0);
  });

  test("dryRun=false + missing client → throws", async () => {
    const opp = fixedOpportunity();
    await expect(renderBrief(opp /* opts.client missing */)).rejects.toThrow(
      /opts\.client is required/,
    );
  });

  test("LLM returns empty text → falls back to opportunity.thesis", async () => {
    const opp = fixedOpportunity();
    const { client } = makeThesisClient([{ kind: "empty" }]);
    const out = await renderBrief(opp, { client });
    expect(out).toContain(opp.thesis);
  });

  test("LLM throws → falls back to opportunity.thesis (resilient render)", async () => {
    const opp = fixedOpportunity();
    const { client } = makeThesisClient([{ kind: "throw", error: new Error("API down") }]);
    const out = await renderBrief(opp, { client });
    expect(out).toContain(opp.thesis);
  });

  test("repeated render with same persist target reuses archived thesis (cache hit)", async () => {
    // The signal_snapshots row IS the durable cache — same prompt → same
    // request_hash → second render reuses the archive without re-calling LLM.
    const opp = fixedOpportunity();
    const db = inMemoryDb();
    const t = 1_700_000_000_000;

    // First call: LLM responds, row is written.
    const { client: c1, captured: cap1 } = makeThesisClient([
      { kind: "ok", text: "First-pass thesis." },
    ]);
    const out1 = await renderBrief(opp, { client: c1, persist: { db, t } });
    expect(out1).toContain("First-pass thesis.");
    expect(cap1.attempts).toBe(1);

    // Second call: panic client (must NOT be invoked) — cache hit reuses
    // the archived thesis from the prior row.
    const out2 = await renderBrief(opp, { client: panicClient(), persist: { db, t } });
    expect(out2).toContain("First-pass thesis.");
  });
});
