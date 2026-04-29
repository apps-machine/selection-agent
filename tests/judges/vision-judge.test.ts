import { describe, expect, test } from "bun:test";
import {
  type ImageFetcher,
  judgeAppVision,
  type VisionJudgeClient,
} from "../../src/judges/vision-judge.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";
import { isErr, isOk } from "../../src/util/result.ts";

const sampleApp: RawAppData = {
  store: "apple",
  appId: "1234567890",
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
