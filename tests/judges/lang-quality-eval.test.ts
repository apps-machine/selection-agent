import { describe, expect, test } from "bun:test";
import {
  type LangQualityClient,
  evaluateLanguageQuality,
} from "../../src/judges/lang-quality-eval.ts";
import { isErr, isOk } from "../../src/util/result.ts";

const phrases = [
  "Unlock premium",
  "Start free trial",
  "Track your progress",
];

interface MockResponse {
  toolName: string;
  input: Record<string, unknown>;
}

interface CapturedCall {
  attempts: number;
  toolNames: string[];
}

function makeMockClient(responses: MockResponse[]): {
  client: LangQualityClient;
  captured: CapturedCall;
} {
  const captured: CapturedCall = { attempts: 0, toolNames: [] };
  const client: LangQualityClient = {
    messages: {
      create: async (params) => {
        const idx = captured.attempts;
        captured.attempts += 1;
        const requestedToolName = params.tools?.[0]?.name ?? "";
        captured.toolNames.push(requestedToolName);
        const r = responses[idx];
        if (!r) throw new Error(`no mock at idx ${idx}`);
        return {
          id: "msg",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `tu_${idx}`,
              name: r.toolName,
              input: r.input,
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 200, output_tokens: 100 },
        };
      },
    },
  };
  return { client, captured };
}

describe("evaluateLanguageQuality", () => {
  test("happy path: 3 phrases, mean score 9.0 → passes=true", async () => {
    const { client, captured } = makeMockClient([
      {
        toolName: "translate_phrases",
        input: {
          translations: [
            "Desbloquear premium",
            "Iniciar avaliação gratuita",
            "Acompanhe seu progresso",
          ],
        },
      },
      {
        toolName: "back_translate_phrases",
        input: {
          backTranslations: [
            "Unlock premium",
            "Start free trial",
            "Track your progress",
          ],
        },
      },
      {
        toolName: "score_equivalence_batch",
        input: {
          scores: [
            { score: 9.5, note: "exact" },
            { score: 9.0, note: "exact" },
            { score: 8.5, note: "minor reword" },
          ],
        },
      },
    ]);

    const result = await evaluateLanguageQuality({
      language: "pt-BR",
      market: "br",
      phrases,
      client,
    });
    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.language).toBe("pt-BR");
    expect(result.value.passes).toBe(true);
    expect(result.value.semanticEquivalenceScore).toBeCloseTo(9.0, 1);
    expect(result.value.perPhraseResults).toHaveLength(3);
    expect(captured.attempts).toBe(3);
    expect(captured.toolNames).toEqual([
      "translate_phrases",
      "back_translate_phrases",
      "score_equivalence_batch",
    ]);
  });

  test("mean score 6.0 → passes=false", async () => {
    const { client } = makeMockClient([
      {
        toolName: "translate_phrases",
        input: {
          translations: ["a", "b", "c"],
        },
      },
      {
        toolName: "back_translate_phrases",
        input: {
          backTranslations: ["wrong1", "wrong2", "wrong3"],
        },
      },
      {
        toolName: "score_equivalence_batch",
        input: {
          scores: [
            { score: 6.0, note: "drift" },
            { score: 6.0, note: "drift" },
            { score: 6.0, note: "drift" },
          ],
        },
      },
    ]);
    const result = await evaluateLanguageQuality({
      language: "pt-BR",
      market: "br",
      phrases,
      client,
    });
    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.passes).toBe(false);
    expect(result.value.semanticEquivalenceScore).toBeCloseTo(6.0, 1);
  });

  test("forward translation fails → err", async () => {
    const { client } = makeMockClient([
      {
        toolName: "translate_phrases",
        input: { wrongShape: true },
      },
    ]);
    const result = await evaluateLanguageQuality({
      language: "pt-BR",
      market: "br",
      phrases,
      client,
    });
    expect(isErr(result)).toBe(true);
  });

  test("translation count mismatch → err", async () => {
    const { client } = makeMockClient([
      {
        toolName: "translate_phrases",
        input: { translations: ["only-one"] },
      },
    ]);
    const result = await evaluateLanguageQuality({
      language: "pt-BR",
      market: "br",
      phrases,
      client,
    });
    expect(isErr(result)).toBe(true);
  });

  test("empty phrases input → err", async () => {
    const { client } = makeMockClient([]);
    const result = await evaluateLanguageQuality({
      language: "pt-BR",
      market: "br",
      phrases: [],
      client,
    });
    expect(isErr(result)).toBe(true);
  });

  test("invokes onTokenUsage 3 times (once per call)", async () => {
    const { client } = makeMockClient([
      {
        toolName: "translate_phrases",
        input: { translations: ["a", "b", "c"] },
      },
      {
        toolName: "back_translate_phrases",
        input: { backTranslations: ["a", "b", "c"] },
      },
      {
        toolName: "score_equivalence_batch",
        input: {
          scores: [
            { score: 9, note: "" },
            { score: 9, note: "" },
            { score: 9, note: "" },
          ],
        },
      },
    ]);
    const usages: Array<{ input: number; output: number }> = [];
    await evaluateLanguageQuality({
      language: "pt-BR",
      market: "br",
      phrases,
      client,
      onTokenUsage: (u) => usages.push({ input: u.input, output: u.output }),
    });
    expect(usages).toHaveLength(3);
  });

  test("backTranslationAccuracy is normalized 0-1 (mean score / 10)", async () => {
    const { client } = makeMockClient([
      {
        toolName: "translate_phrases",
        input: { translations: ["a", "b", "c"] },
      },
      {
        toolName: "back_translate_phrases",
        input: { backTranslations: ["a", "b", "c"] },
      },
      {
        toolName: "score_equivalence_batch",
        input: {
          scores: [
            { score: 8.0, note: "" },
            { score: 8.0, note: "" },
            { score: 8.0, note: "" },
          ],
        },
      },
    ]);
    const result = await evaluateLanguageQuality({
      language: "ja",
      market: "jp",
      phrases,
      client,
    });
    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.backTranslationAccuracy).toBeCloseTo(0.8, 2);
    expect(result.value.passes).toBe(true);
  });
});
