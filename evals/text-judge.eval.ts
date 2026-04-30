import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { type JudgeClient, judgeAppText } from "../src/judges/text-judge.ts";
import { RawAppDataSchema } from "../src/types/raw-app-data.ts";
import { assertDriftWithinTolerance } from "./drift-gate.ts";
import cases from "./fixtures/text-judge-cases.json";

const SHOULD_RUN = process.env.EVALS === "1" && typeof process.env.ANTHROPIC_API_KEY === "string";

const BASELINE_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  "baselines",
  "text-judge.json",
);

// ±1.0 absolute tolerance on the 0-10 locGapScore = ±10% drift. Pulled into
// a constant so the M7 evals.yml gate can be re-tuned in one place if a
// later milestone introduces per-case overrides.
const SCORE_TOLERANCE = 1.0;

interface BaselineEntry {
  caseId: string;
  locGapScore: number;
  confidence: number;
  modelVersion: string;
  recordedAt: string;
}

function loadBaseline(): Record<string, BaselineEntry> {
  if (!existsSync(BASELINE_PATH)) return {};
  const raw = readFileSync(BASELINE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as { entries: BaselineEntry[] };
  return Object.fromEntries(parsed.entries.map((e) => [e.caseId, e]));
}

function saveBaseline(entries: BaselineEntry[]): void {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}

describe.skipIf(!SHOULD_RUN)("text-judge eval (live LLM, EVALS=1)", () => {
  const client = new Anthropic() as unknown as JudgeClient;
  const baseline = loadBaseline();
  const fresh: BaselineEntry[] = [];

  for (const c of cases.cases) {
    test(c.label, async () => {
      const app = RawAppDataSchema.parse(c.app);
      const result = await judgeAppText({ app, client });
      if (!result.ok) {
        throw new Error(`judgeAppText failed for ${c.id}: ${result.error.message}`);
      }
      const r = result.value;
      const min =
        "expectedLocGapMin" in c ? (c as { expectedLocGapMin: number }).expectedLocGapMin : 0;
      const max =
        "expectedLocGapMax" in c ? (c as { expectedLocGapMax: number }).expectedLocGapMax : 10;
      expect(r.locGapScore).toBeGreaterThanOrEqual(min);
      expect(r.locGapScore).toBeLessThanOrEqual(max);

      if (c.expectedSignals) {
        for (const [k, v] of Object.entries(c.expectedSignals)) {
          expect(r.signals[k as keyof typeof r.signals]).toBe(v as boolean);
        }
      }

      const prev = baseline[c.id];
      if (prev) {
        const drift = assertDriftWithinTolerance({
          actual: r.locGapScore,
          baseline: prev.locGapScore,
          tolerance: SCORE_TOLERANCE,
        });
        if (!drift.ok) {
          throw new Error(`text-judge drift on case "${c.id}": ${drift.reason}`);
        }
      }
      fresh.push({
        caseId: c.id,
        locGapScore: r.locGapScore,
        confidence: r.confidence,
        modelVersion: r.modelVersion,
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
