import { describe, expect, test } from "bun:test";
import { type JudgeClient, judgeAppText } from "../../src/judges/text-judge.ts";
import type { RawAppData } from "../../src/types/raw-app-data.ts";
import { isErr, isOk } from "../../src/util/result.ts";

const sampleApp: RawAppData = {
  store: "apple",
  appId: "1234567890",
  trackId: "1234567890",
  market: "br",
  name: "FocusFlow",
  developer: "Indie Co",
  category: "Productivity",
  rank: 47,
  rating: 4.6,
  ratingsCount: 12_000,
  priceUsd: 0,
  iapPresent: true,
  description: "Track your focus sessions and become more productive.",
  screenshotUrls: ["https://example.com/s1.png"],
  iconUrl: "https://example.com/icon.png",
  releaseDate: "2024-01-01T00:00:00.000Z",
  lastUpdated: "2026-04-01T00:00:00.000Z",
  scrapedAt: "2026-04-29T00:00:00.000Z",
};

interface CapturedCall {
  model: string;
  toolName: string;
  promptText: string;
  attempts: number;
}

function makeMockClient(
  responses: Array<
    | { kind: "ok"; toolInput: Record<string, unknown> }
    | { kind: "throw"; error: unknown }
    | { kind: "no-tool-use" }
  >,
): { client: JudgeClient; captured: CapturedCall } {
  const captured: CapturedCall = {
    model: "",
    toolName: "",
    promptText: "",
    attempts: 0,
  };
  const client: JudgeClient = {
    messages: {
      create: async (params: {
        model: string;
        messages: Array<{ role: string; content: unknown }>;
        tools?: Array<{ name: string }>;
      }) => {
        const idx = captured.attempts;
        captured.attempts += 1;
        captured.model = params.model;
        captured.toolName = params.tools?.[0]?.name ?? "";
        const firstMsg = params.messages[0];
        captured.promptText =
          typeof firstMsg?.content === "string"
            ? firstMsg.content
            : JSON.stringify(firstMsg?.content ?? "");
        const r = responses[idx];
        if (!r) throw new Error(`no mock response at idx ${idx}`);
        if (r.kind === "throw") throw r.error;
        if (r.kind === "no-tool-use") {
          return {
            id: "msg_x",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "I refuse." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 20 },
          };
        }
        return {
          id: "msg_x",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "score_localization_gap",
              input: r.toolInput,
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    },
  };
  return { client, captured };
}

const validToolInput = {
  locGapScore: 7.5,
  reasoning: "Description English-only, no PT-BR localization in BR top chart.",
  signals: {
    hasNativeLanguage: false,
    hasCulturalAdaptation: false,
    hasLocalizedPaywall: false,
    hasLocalPaymentMethod: false,
  },
  confidence: 0.85,
};

describe("judgeAppText", () => {
  test("happy path: returns ok with a TextJudgeResult", async () => {
    const { client, captured } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    const result = await judgeAppText({ app: sampleApp, client });
    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.kind).toBe("text");
    expect(result.value.appId).toBe(sampleApp.appId);
    expect(result.value.market).toBe(sampleApp.market);
    expect(result.value.locGapScore).toBe(7.5);
    expect(result.value.modelVersion).toContain("sonnet");
    expect(captured.toolName).toBe("score_localization_gap");
  });

  test("uses claude-sonnet-4-6 by default", async () => {
    const { client, captured } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    await judgeAppText({ app: sampleApp, client });
    expect(captured.model).toBe("claude-sonnet-4-6");
  });

  test("respects explicit model override", async () => {
    const { client, captured } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    await judgeAppText({
      app: sampleApp,
      client,
      model: "claude-haiku-4-5-20251001",
    });
    expect(captured.model).toBe("claude-haiku-4-5-20251001");
  });

  test("prompt includes app metadata + market", async () => {
    const { client, captured } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    await judgeAppText({ app: sampleApp, client });
    expect(captured.promptText).toContain("FocusFlow");
    expect(captured.promptText).toContain("br");
    expect(captured.promptText).toContain("Productivity");
  });

  test("retries on transient 429, succeeds on third try", async () => {
    const e429 = Object.assign(new Error("rate limited"), { status: 429 });
    const { client, captured } = makeMockClient([
      { kind: "throw", error: e429 },
      { kind: "throw", error: e429 },
      { kind: "ok", toolInput: validToolInput },
    ]);
    const result = await judgeAppText({
      app: sampleApp,
      client,
      retry: { initialDelayMs: 1, maxDelayMs: 4, jitter: false, maxAttempts: 3 },
    });
    expect(isOk(result)).toBe(true);
    expect(captured.attempts).toBe(3);
  });

  test("does NOT retry on fatal 401", async () => {
    const e401 = Object.assign(new Error("invalid api key"), { status: 401 });
    const { client, captured } = makeMockClient([{ kind: "throw", error: e401 }]);
    const result = await judgeAppText({
      app: sampleApp,
      client,
      retry: { initialDelayMs: 1, jitter: false, maxAttempts: 5 },
    });
    expect(isErr(result)).toBe(true);
    expect(captured.attempts).toBe(1);
  });

  test("returns err when response has no tool_use block", async () => {
    const { client } = makeMockClient([{ kind: "no-tool-use" }]);
    const result = await judgeAppText({ app: sampleApp, client });
    expect(isErr(result)).toBe(true);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toMatch(/tool[_ ]use|no.+structured/i);
  });

  test("returns err when tool input fails Zod validation (score out of range)", async () => {
    const { client } = makeMockClient([
      { kind: "ok", toolInput: { ...validToolInput, locGapScore: 99 } },
    ]);
    const result = await judgeAppText({ app: sampleApp, client });
    expect(isErr(result)).toBe(true);
  });

  test("invokes onTokenUsage callback with token counts", async () => {
    const { client } = makeMockClient([{ kind: "ok", toolInput: validToolInput }]);
    let captured: { input: number; output: number; model: string } | null = null;
    await judgeAppText({
      app: sampleApp,
      client,
      onTokenUsage: (u) => {
        captured = u;
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.input).toBe(100);
    expect(captured!.output).toBe(50);
    expect(captured!.model).toBe("claude-sonnet-4-6");
  });
});
