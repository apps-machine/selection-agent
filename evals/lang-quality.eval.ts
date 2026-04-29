import { describe, expect, test } from "bun:test";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import corpus from "./fixtures/lang-corpus.json";
import targets from "./fixtures/lang-targets.json";
import {
  type LangQualityClient,
  evaluateLanguageQuality,
} from "../src/judges/lang-quality-eval.ts";
import {
  LANG_QUALITY_PASS_THRESHOLD,
} from "../src/judges/schemas.ts";

const SHOULD_RUN =
  process.env.EVALS === "1" && typeof process.env.ANTHROPIC_API_KEY === "string";

const BASELINE_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  "baselines",
  "lang-quality.json",
);

const REGRESSION_THRESHOLD = 0.1;

interface BaselineEntry {
  language: string;
  market: string;
  semanticEquivalenceScore: number;
  passes: boolean;
  modelVersion: string;
  recordedAt: string;
}

function loadBaseline(): Record<string, BaselineEntry> {
  if (!existsSync(BASELINE_PATH)) return {};
  const raw = readFileSync(BASELINE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as { entries: BaselineEntry[] };
  return Object.fromEntries(parsed.entries.map((e) => [`${e.language}/${e.market}`, e]));
}

function saveBaseline(entries: BaselineEntry[]): void {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ version: 1, entries }, null, 2) + "\n",
  );
}

describe.skipIf(!SHOULD_RUN)("lang-quality eval (live LLM, EVALS=1)", () => {
  const client = new Anthropic() as unknown as LangQualityClient;
  const baseline = loadBaseline();
  const fresh: BaselineEntry[] = [];

  for (const t of targets.targets) {
    test(`${t.language} (${t.market}) — 50-phrase back-translation`, async () => {
      const result = await evaluateLanguageQuality({
        language: t.language,
        market: t.market,
        phrases: corpus.phrases,
        client,
      });
      if (!result.ok) {
        throw new Error(
          `evaluateLanguageQuality failed for ${t.language}/${t.market}: ${result.error.message}`,
        );
      }

      if (t.isBaseline) {
        expect(result.value.semanticEquivalenceScore).toBeGreaterThanOrEqual(9.0);
      }
      expect(result.value.passes).toBe(
        result.value.semanticEquivalenceScore >= LANG_QUALITY_PASS_THRESHOLD,
      );

      const key = `${t.language}/${t.market}`;
      const prev = baseline[key];
      if (prev) {
        const drift =
          Math.abs(result.value.semanticEquivalenceScore - prev.semanticEquivalenceScore) /
          10;
        expect(drift).toBeLessThanOrEqual(REGRESSION_THRESHOLD);
      }
      fresh.push({
        language: t.language,
        market: t.market,
        semanticEquivalenceScore: result.value.semanticEquivalenceScore,
        passes: result.value.passes,
        modelVersion: result.value.modelVersion,
        recordedAt: new Date().toISOString(),
      });
    });
  }

  test("write baseline (only when WRITE_BASELINE=1)", () => {
    if (process.env.WRITE_BASELINE === "1") {
      saveBaseline(fresh);
    }
  });
});
