/**
 * ★ CRITICAL ★ — citation rejection tests for llm-augment.
 *
 * Per agent-v1-foundation.md: NO URL → field stays null. NO fabrication.
 * If LLM response can't be parsed by ClaimWithCitation.parse(), the field
 * is null. Backtest precision depends on this — a single fabricated
 * "winner" label corrupts the entire ground-truth corpus.
 *
 * Each test pins the rejection at the Zod layer (not just a downstream
 * "we logged a warning" — Zod must actually throw, the function must
 * actually return claim=null).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  augmentField,
  ClaimWithCitation,
  type LlmAugmentClient,
} from "../../src/ground-truth/llm-augment.ts";
import { runMigrations } from "../../src/storage/schema.ts";

interface ToolUseInput {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface FakeMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<ToolUseInput | { type: "text"; text: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

function makeFakeClient(response: FakeMessage | (() => Promise<FakeMessage>)): LlmAugmentClient {
  return {
    messages: {
      create: typeof response === "function" ? async () => response() : async () => response,
    },
  };
}

function toolUseResp(input: unknown): FakeMessage {
  return {
    id: "msg_x",
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: "x", name: "claim_with_citation", input }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function textOnlyResp(text: string): FakeMessage {
  return {
    id: "msg_x",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

const APP = { app_id: "com.x", market: "id", name: "TestApp" };

describe("ClaimWithCitation Zod schema (unit)", () => {
  test("happy: parses valid claim", () => {
    const r = ClaimWithCitation.safeParse({
      value: "high",
      evidence_url: "https://twitter.com/some/post/123",
      source_quote: "this app made $50k MRR last month per dev tweet",
    });
    expect(r.success).toBe(true);
  });

  test("rejects missing evidence_url", () => {
    const r = ClaimWithCitation.safeParse({
      value: "high",
      source_quote: "x".repeat(30),
    });
    expect(r.success).toBe(false);
  });

  test("rejects evidence_url that is NOT a valid URL", () => {
    const r = ClaimWithCitation.safeParse({
      value: "high",
      evidence_url: "not-a-url",
      source_quote: "x".repeat(30),
    });
    expect(r.success).toBe(false);
  });

  test("rejects source_quote shorter than 20 chars", () => {
    const r = ClaimWithCitation.safeParse({
      value: "high",
      evidence_url: "https://x.com/post",
      source_quote: "too short",
    });
    expect(r.success).toBe(false);
  });

  test("rejects value not in low/mid/high enum", () => {
    const r = ClaimWithCitation.safeParse({
      value: "medium",
      evidence_url: "https://x.com/post",
      source_quote: "x".repeat(30),
    });
    expect(r.success).toBe(false);
  });
});

describe("augmentField — rejection paths (★ CRITICAL ★)", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
  });

  test("happy: valid {value, evidence_url, source_quote} → claim populated", async () => {
    const client = makeFakeClient(
      toolUseResp({
        value: "high",
        evidence_url: "https://twitter.com/dev/status/123",
        source_quote: "Last month we did $50k MRR — proud milestone for the indie team.",
      }),
    );
    const r = await augmentField("revenue estimate", APP, { client });
    expect(r.claim).not.toBeNull();
    expect(r.claim?.value).toBe("high");
    expect(r.source_urls).toEqual(["https://twitter.com/dev/status/123"]);
  });

  test("LLM returns NO URL → Zod throws → field stays null", async () => {
    const client = makeFakeClient(
      toolUseResp({
        value: "high",
        // no evidence_url field at all
        source_quote: "this app is doing well based on chart position",
      }),
    );
    const r = await augmentField("revenue estimate", APP, { client });
    expect(r.claim).toBeNull();
    expect(r.source_urls).toEqual([]);
    // Provenance is still populated for replay.
    expect(r.response_hash.length).toBe(64);
    expect(r.response_archived.length).toBeGreaterThan(0);
  });

  test("LLM returns invalid URL format ('not-a-url') → Zod throws → null", async () => {
    const client = makeFakeClient(
      toolUseResp({
        value: "high",
        evidence_url: "not-a-url",
        source_quote: "the dev told someone in DM that they're at $50k MRR",
      }),
    );
    const r = await augmentField("revenue estimate", APP, { client });
    expect(r.claim).toBeNull();
  });

  test("LLM returns refusal text (no tool_use) → caught, field null", async () => {
    const client = makeFakeClient(
      textOnlyResp("I cannot find verifiable revenue information for this app."),
    );
    const r = await augmentField("revenue estimate", APP, { client });
    expect(r.claim).toBeNull();
    expect(r.source_urls).toEqual([]);
    // Refusal text is archived for replay (the response_archived field
    // contains the text content even when there's no tool use).
    expect(r.response_archived).toContain("cannot find");
  });

  test("LLM returns short source_quote (refusal in disguise) → Zod throws → null", async () => {
    const client = makeFakeClient(
      toolUseResp({
        value: "low",
        evidence_url: "https://example.com/x",
        source_quote: "no data", // < 20 chars
      }),
    );
    const r = await augmentField("revenue estimate", APP, { client });
    expect(r.claim).toBeNull();
  });

  test("LLM timeout → retry once, then null", async () => {
    let attempts = 0;
    const client: LlmAugmentClient = {
      messages: {
        create: async () => {
          attempts++;
          throw new Error("timeout");
        },
      },
    };
    const r = await augmentField("revenue estimate", APP, { client });
    expect(r.claim).toBeNull();
    // MAX_RETRIES=1 → 2 attempts total (initial + 1 retry).
    expect(attempts).toBe(2);
  });

  test("transient failure then success on retry → claim populated", async () => {
    let attempts = 0;
    const client: LlmAugmentClient = {
      messages: {
        create: async () => {
          attempts++;
          if (attempts < 2) throw new Error("transient");
          return toolUseResp({
            value: "mid",
            evidence_url: "https://producthunt.com/posts/x",
            source_quote: "this app is doing well based on user feedback in the comments",
          });
        },
      },
    };
    const r = await augmentField("revenue estimate", APP, { client });
    expect(r.claim?.value).toBe("mid");
    expect(attempts).toBe(2);
  });
});

describe("augmentField — provenance persistence", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
  });

  test("persists full provenance to signal_snapshots when persist opt provided", async () => {
    const client = makeFakeClient(
      toolUseResp({
        value: "high",
        evidence_url: "https://twitter.com/dev/status/123",
        source_quote: "We did $50k MRR last month — sharing the dashboard screenshot.",
      }),
    );
    const t = 1_700_000_000_000;
    await augmentField("revenue estimate", APP, {
      client,
      persist: { db, app_id: APP.app_id, signal_name: "public_revenue_estimate", t },
    });
    const row = db
      .prepare<
        {
          value: number | null;
          llm_model: string | null;
          llm_prompt_version: string;
          llm_request_hash: string | null;
          llm_response_hash: string | null;
          llm_response_archived: string | null;
          source_urls_json: string | null;
        },
        [string, string, number]
      >(
        `SELECT value, llm_model, llm_prompt_version, llm_request_hash,
                llm_response_hash, llm_response_archived, source_urls_json
         FROM signal_snapshots
         WHERE app_id = ? AND signal_name = ? AND t = ?`,
      )
      .get(APP.app_id, "public_revenue_estimate", t);
    expect(row).not.toBeNull();
    expect(row?.value).toBe(8); // bandToScore("high") = 8
    expect(row?.llm_model).toBe("claude-opus-4-7");
    expect(row?.llm_prompt_version).toBe("v1.0.0");
    expect(row?.llm_request_hash?.length).toBe(64);
    expect(row?.llm_response_hash?.length).toBe(64);
    expect(JSON.parse(row?.source_urls_json ?? "[]")).toEqual([
      "https://twitter.com/dev/status/123",
    ]);
  });

  test("persists null value with provenance even when claim rejected (replay can distinguish)", async () => {
    const client = makeFakeClient(
      toolUseResp({
        value: "high",
        // missing evidence_url → Zod rejects
        source_quote: "x".repeat(30),
      }),
    );
    const t = 1_700_000_000_000;
    await augmentField("revenue estimate", APP, {
      client,
      persist: { db, app_id: APP.app_id, signal_name: "public_revenue_estimate", t },
    });
    const row = db
      .prepare<{ value: number | null; source_urls_json: string | null }, [string, string, number]>(
        `SELECT value, source_urls_json FROM signal_snapshots
         WHERE app_id = ? AND signal_name = ? AND t = ?`,
      )
      .get(APP.app_id, "public_revenue_estimate", t);
    expect(row?.value).toBeNull();
    expect(JSON.parse(row?.source_urls_json ?? "[]")).toEqual([]);
  });

  test("request_hash is stable for the same prompt → replay can deduplicate", async () => {
    const client = makeFakeClient(
      toolUseResp({
        value: "high",
        evidence_url: "https://x.com/y",
        source_quote: "long enough quote string to satisfy the schema constraint",
      }),
    );
    const r1 = await augmentField("revenue estimate", APP, { client });
    const r2 = await augmentField("revenue estimate", APP, { client });
    expect(r1.request_hash).toBe(r2.request_hash);
  });
});
