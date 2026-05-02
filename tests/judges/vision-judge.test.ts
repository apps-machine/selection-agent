import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  generateMechanicEvidence,
  type ImageFetcher,
  judgeAppVision,
  MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT,
  type VisionJudgeClient,
} from "../../src/judges/vision-judge.ts";
import { runMigrations } from "../../src/storage/schema.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";
import { isErr, isOk } from "../../src/util/result.ts";

const sampleApp: RawAppData = {
  store: "apple",
  appId: "1234567890",
  trackId: "1234567890",
  market: "jp",
  name: "FocusFlow",
  developer: "Indie Co",
  category: "Productivity",
  rank: 47,
  rating: 4.6,
  ratingsCount: 12_000,
  priceUsd: 0,
  iapPresent: true,
  description: "Track your focus sessions.",
  screenshotUrls: [
    "https://example.com/s1.png",
    "https://example.com/s2.png",
    "https://example.com/s3.png",
  ],
  iconUrl: "https://example.com/icon.png",
  releaseDate: "2024-01-01T00:00:00.000Z",
  lastUpdated: "2026-04-01T00:00:00.000Z",
  scrapedAt: "2026-04-29T00:00:00.000Z",
};

const validToolInput = {
  culturalFitScore: 4.0,
  reasoning: "Screenshots show US-style food imagery in JP listing.",
  signals: {
    screenshotsLocalized: false,
    imagesCulturallyAdapted: false,
    textInLanguage: true,
    screenshotFreshness: "stale",
  },
  confidence: 0.7,
};

interface CapturedVisionCall {
  attempts: number;
  imagesIncluded: number;
  toolName: string;
  model: string;
}

function makeMockClient(
  responses: Array<
    | { kind: "ok"; toolInput: Record<string, unknown> }
    | { kind: "throw"; error: unknown }
    | { kind: "no-tool-use" }
  >,
): { client: VisionJudgeClient; captured: CapturedVisionCall } {
  const captured: CapturedVisionCall = {
    attempts: 0,
    imagesIncluded: 0,
    toolName: "",
    model: "",
  };
  const client: VisionJudgeClient = {
    messages: {
      create: async (params) => {
        const idx = captured.attempts;
        captured.attempts += 1;
        captured.model = params.model;
        captured.toolName = params.tools?.[0]?.name ?? "";
        const blocks = params.messages[0]?.content ?? [];
        captured.imagesIncluded = blocks.filter((b) => b.type === "image").length;
        const r = responses[idx];
        if (!r) throw new Error(`no mock response at idx ${idx}`);
        if (r.kind === "throw") throw r.error;
        if (r.kind === "no-tool-use") {
          return {
            id: "msg",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "I refuse." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1000, output_tokens: 30 },
          };
        }
        return {
          id: "msg",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "score_cultural_fit",
              input: r.toolInput,
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 1500, output_tokens: 80 },
        };
      },
    },
  };
  return { client, captured };
}

function fetcherWith(
  results: Record<string, { mediaType: string; base64: string } | { error: Error }>,
): ImageFetcher {
  return async (url) => {
    const r = results[url];
    if (!r) throw new Error(`no mock for ${url}`);
    if ("error" in r) throw r.error;
    return r;
  };
}

describe("judgeAppVision", () => {
  test("happy path: fetches all 3 screenshots, returns ok with screenshotsAnalyzed=3", async () => {
    const { client, captured } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    const fetcher = fetcherWith({
      "https://example.com/s1.png": { mediaType: "image/png", base64: "AAA" },
      "https://example.com/s2.png": { mediaType: "image/png", base64: "BBB" },
      "https://example.com/s3.png": { mediaType: "image/png", base64: "CCC" },
    });
    const result = await judgeAppVision({
      app: sampleApp,
      client,
      fetchImage: fetcher,
    });
    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.kind).toBe("vision");
    expect(result.value.screenshotsAnalyzed).toBe(3);
    expect(result.value.culturalFitScore).toBe(4.0);
    expect(captured.toolName).toBe("score_cultural_fit");
    expect(captured.imagesIncluded).toBe(3);
  });

  test("partial 404: 1 of 3 fails → continues with 2, screenshotsAnalyzed=2", async () => {
    const { client, captured } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    const fetcher = fetcherWith({
      "https://example.com/s1.png": { mediaType: "image/png", base64: "AAA" },
      "https://example.com/s2.png": {
        error: Object.assign(new Error("not found"), { status: 404 }),
      },
      "https://example.com/s3.png": { mediaType: "image/png", base64: "CCC" },
    });
    const result = await judgeAppVision({
      app: sampleApp,
      client,
      fetchImage: fetcher,
    });
    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.screenshotsAnalyzed).toBe(2);
    expect(captured.imagesIncluded).toBe(2);
  });

  test("returns err when ALL screenshots fail to fetch", async () => {
    const { client } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    const fetcher = fetcherWith({
      "https://example.com/s1.png": { error: new Error("net") },
      "https://example.com/s2.png": { error: new Error("net") },
      "https://example.com/s3.png": { error: new Error("net") },
    });
    const result = await judgeAppVision({
      app: sampleApp,
      client,
      fetchImage: fetcher,
    });
    expect(isErr(result)).toBe(true);
  });

  test("returns err when app has no screenshot URLs", async () => {
    const { client } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    const fetcher = fetcherWith({});
    const result = await judgeAppVision({
      app: { ...sampleApp, screenshotUrls: [] },
      client,
      fetchImage: fetcher,
    });
    expect(isErr(result)).toBe(true);
  });

  test("caps at maxScreenshots=5 default", async () => {
    const manyShots = {
      ...sampleApp,
      screenshotUrls: Array.from({ length: 10 }, (_, i) => `https://example.com/s${i}.png`),
    };
    const { client, captured } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    const fetchResults: Record<string, { mediaType: string; base64: string }> = {};
    for (const u of manyShots.screenshotUrls) {
      fetchResults[u] = { mediaType: "image/png", base64: "X" };
    }
    const fetcher = fetcherWith(fetchResults);
    const result = await judgeAppVision({
      app: manyShots,
      client,
      fetchImage: fetcher,
    });
    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.screenshotsAnalyzed).toBe(5);
    expect(captured.imagesIncluded).toBe(5);
  });

  test("retries on transient 429", async () => {
    const e429 = Object.assign(new Error("rate limited"), { status: 429 });
    const { client, captured } = makeMockClient([
      { kind: "throw", error: e429 },
      { kind: "ok", toolInput: validToolInput },
    ]);
    const fetcher = fetcherWith({
      "https://example.com/s1.png": { mediaType: "image/png", base64: "A" },
      "https://example.com/s2.png": { mediaType: "image/png", base64: "B" },
      "https://example.com/s3.png": { mediaType: "image/png", base64: "C" },
    });
    const result = await judgeAppVision({
      app: sampleApp,
      client,
      fetchImage: fetcher,
      retry: { initialDelayMs: 1, maxDelayMs: 4, jitter: false, maxAttempts: 3 },
    });
    expect(isOk(result)).toBe(true);
    expect(captured.attempts).toBe(2);
  });

  test("no_tool_use response → err", async () => {
    const { client } = makeMockClient([{ kind: "no-tool-use" }]);
    const fetcher = fetcherWith({
      "https://example.com/s1.png": { mediaType: "image/png", base64: "A" },
      "https://example.com/s2.png": { mediaType: "image/png", base64: "B" },
      "https://example.com/s3.png": { mediaType: "image/png", base64: "C" },
    });
    const result = await judgeAppVision({
      app: sampleApp,
      client,
      fetchImage: fetcher,
    });
    expect(isErr(result)).toBe(true);
  });

  test("schema-invalid tool input → err", async () => {
    const { client } = makeMockClient([
      { kind: "ok", toolInput: { ...validToolInput, culturalFitScore: 99 } },
    ]);
    const fetcher = fetcherWith({
      "https://example.com/s1.png": { mediaType: "image/png", base64: "A" },
      "https://example.com/s2.png": { mediaType: "image/png", base64: "B" },
      "https://example.com/s3.png": { mediaType: "image/png", base64: "C" },
    });
    const result = await judgeAppVision({
      app: sampleApp,
      client,
      fetchImage: fetcher,
    });
    expect(isErr(result)).toBe(true);
  });

  test("rejects images larger than maxImageBytes (cost runaway guard)", async () => {
    const { client } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    const huge = "X".repeat(200);
    const fetcher = fetcherWith({
      "https://example.com/s1.png": { mediaType: "image/png", base64: "OK" },
      "https://example.com/s2.png": { mediaType: "image/png", base64: huge },
      "https://example.com/s3.png": { mediaType: "image/png", base64: "OK" },
    });
    const result = await judgeAppVision({
      app: sampleApp,
      client,
      fetchImage: fetcher,
      maxImageBytes: 10,
    });
    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.screenshotsAnalyzed).toBe(2);
  });

  test("passes AbortSignal to fetcher (timeout contract)", async () => {
    const { client } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    let signalSeen: AbortSignal | undefined;
    const fetcher: import("../../src/judges/vision-judge.ts").ImageFetcher = async (_url, opts) => {
      signalSeen = opts?.signal;
      return { mediaType: "image/png", base64: "AAA" };
    };
    await judgeAppVision({
      app: { ...sampleApp, screenshotUrls: ["https://example.com/only.png"] },
      client,
      fetchImage: fetcher,
    });
    expect(signalSeen).toBeDefined();
    expect(signalSeen instanceof AbortSignal).toBe(true);
  });

  test("invokes onTokenUsage callback", async () => {
    const { client } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    const fetcher = fetcherWith({
      "https://example.com/s1.png": { mediaType: "image/png", base64: "A" },
      "https://example.com/s2.png": { mediaType: "image/png", base64: "B" },
      "https://example.com/s3.png": { mediaType: "image/png", base64: "C" },
    });
    let captured: { input: number; output: number; model: string } | null = null;
    await judgeAppVision({
      app: sampleApp,
      client,
      fetchImage: fetcher,
      onTokenUsage: (u) => {
        captured = u;
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.input).toBe(1500);
    expect(captured!.output).toBe(80);
  });
});

// ──────────────────────────────────────────────────────────────────────
// MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT — applied uniformly (M6 TODO resolved)
// ──────────────────────────────────────────────────────────────────────

describe("MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT — TODO at line 219 resolved", () => {
  test("constant is 3 (bumped from 2 during v1 mechanic_evidence work)", () => {
    expect(MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT).toBe(3);
  });

  test("judgeAppVision still returns ok with fewer screenshots (thin verdict allowed)", async () => {
    // The cultural-fit signal still proceeds below threshold — orchestrator
    // down-weights confidence using screenshotsAnalyzed. Refusing entirely
    // would erase the only cultural-fit signal we have for sparse apps.
    const thinApp = {
      ...sampleApp,
      screenshotUrls: ["https://example.com/only.png"],
    };
    const { client } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    const fetcher = fetcherWith({
      "https://example.com/only.png": { mediaType: "image/png", base64: "AAA" },
    });
    const result = await judgeAppVision({ app: thinApp, client, fetchImage: fetcher });
    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.screenshotsAnalyzed).toBe(1); // < MIN, but still ok
  });
});

// ──────────────────────────────────────────────────────────────────────
// generateMechanicEvidence — qualitative prose for v1 metadata.mechanic_evidence
// ──────────────────────────────────────────────────────────────────────

function makeMechanicClient(
  responses: Array<{ kind: "ok"; text: string } | { kind: "throw"; error: unknown }>,
): VisionJudgeClient {
  let idx = 0;
  return {
    messages: {
      create: async () => {
        const r = responses[idx];
        idx += 1;
        if (!r) throw new Error(`no mock response at idx ${idx - 1}`);
        if (r.kind === "throw") throw r.error;
        return {
          id: "msg",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: r.text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 200, output_tokens: 60 },
        };
      },
    },
  };
}

describe("generateMechanicEvidence", () => {
  test("returns null when fewer than MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT", async () => {
    const client = makeMechanicClient([
      { kind: "throw", error: new Error("must NOT call LLM below threshold") },
    ]);
    const result = await generateMechanicEvidence(
      {
        appId: "com.x.y",
        name: "X",
        description: "desc",
        screenshotUrls: ["https://e.com/a.png", "https://e.com/b.png"], // 2 < 3
      },
      {
        client,
        fetchImage: async () => ({ mediaType: "image/png", base64: "AA" }),
      },
    );
    expect(result.evidence).toBeNull();
    expect(result.screenshots_analyzed).toBe(0);
    expect(result.request_hash).toBe("");
    expect(result.response_hash).toBe("");
  });

  test("returns paragraph when ≥3 screenshots fetched successfully", async () => {
    const client = makeMechanicClient([
      {
        kind: "ok",
        text: "Core loop: scan barcode → log calories. Novel mechanic: gamified streak rewards.",
      },
    ]);
    const result = await generateMechanicEvidence(
      {
        appId: "com.x.y",
        name: "X",
        description: "Calorie tracker.",
        screenshotUrls: ["https://e.com/a.png", "https://e.com/b.png", "https://e.com/c.png"],
      },
      {
        client,
        fetchImage: async () => ({ mediaType: "image/png", base64: "AAAA" }),
      },
    );
    expect(result.evidence).toContain("Core loop");
    expect(result.evidence).toContain("Novel mechanic");
    expect(result.screenshots_analyzed).toBe(3);
    expect(result.request_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.response_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("re-checks threshold AFTER fetch: partial CDN failure drops below MIN → null", async () => {
    const client = makeMechanicClient([
      { kind: "throw", error: new Error("must NOT call LLM below threshold") },
    ]);
    let i = 0;
    const fetcher: ImageFetcher = async () => {
      i += 1;
      if (i === 1) return { mediaType: "image/png", base64: "AA" };
      throw new Error(`CDN fail ${i}`);
    };
    const result = await generateMechanicEvidence(
      {
        appId: "com.x.y",
        name: "X",
        description: "desc",
        screenshotUrls: ["https://e.com/a.png", "https://e.com/b.png", "https://e.com/c.png"],
      },
      { client, fetchImage: fetcher },
    );
    expect(result.evidence).toBeNull();
    expect(result.screenshots_analyzed).toBe(1); // 1 < 3 after CDN failures
  });

  test("persists to signal_snapshots with full provenance", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const client = makeMechanicClient([{ kind: "ok", text: "Generated mechanic paragraph." }]);
    const t = 1_700_000_000_000;
    await generateMechanicEvidence(
      {
        appId: "com.persist.test",
        name: "Persist",
        description: "A persistence test.",
        screenshotUrls: ["https://e.com/a.png", "https://e.com/b.png", "https://e.com/c.png"],
      },
      {
        client,
        fetchImage: async () => ({ mediaType: "image/png", base64: "AAAA" }),
        persist: { db, t },
        clock: () => 1_700_000_005_000,
      },
    );

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
      >("SELECT * FROM signal_snapshots WHERE signal_name = 'mechanic_evidence'")
      .get();
    expect(row).not.toBeNull();
    if (!row) throw new Error("unreachable");
    expect(row.app_id).toBe("com.persist.test");
    expect(row.signal_name).toBe("mechanic_evidence");
    expect(row.t).toBe(t);
    expect(row.value).toBeNull(); // text, not numeric
    expect(row.llm_model).toBe("claude-opus-4-7");
    expect(row.llm_prompt_version).toBe("v1.0.0");
    expect(row.llm_response_archived).toBe("Generated mechanic paragraph.");
    expect(row.source_urls_json).toBe("[]");
    expect(row.computed_at).toBe(1_700_000_005_000);
  });

  test("does NOT persist when below threshold (no useful row to archive)", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const client = makeMechanicClient([
      { kind: "throw", error: new Error("must NOT call LLM below threshold") },
    ]);
    await generateMechanicEvidence(
      {
        appId: "com.x.y",
        name: "X",
        description: "desc",
        screenshotUrls: ["https://e.com/a.png"], // 1 < 3
      },
      {
        client,
        fetchImage: async () => ({ mediaType: "image/png", base64: "AA" }),
        persist: { db, t: 0 },
      },
    );
    const count = db
      .prepare<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM signal_snapshots WHERE signal_name = 'mechanic_evidence'",
      )
      .get();
    expect(count?.n ?? 0).toBe(0);
  });

  test("LLM throws → returns null evidence, does not crash", async () => {
    const client = makeMechanicClient([{ kind: "throw", error: new Error("API down") }]);
    const result = await generateMechanicEvidence(
      {
        appId: "com.x.y",
        name: "X",
        description: "desc",
        screenshotUrls: ["https://e.com/a.png", "https://e.com/b.png", "https://e.com/c.png"],
      },
      {
        client,
        fetchImage: async () => ({ mediaType: "image/png", base64: "AA" }),
        retry: { initialDelayMs: 1, maxDelayMs: 4, jitter: false, maxAttempts: 1 },
      },
    );
    expect(result.evidence).toBeNull();
    expect(result.request_hash).not.toBe(""); // hash known even on call failure
  });
});
