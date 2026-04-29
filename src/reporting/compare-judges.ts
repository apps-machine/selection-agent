import type { JudgeResult, TextJudgeResult, VisionJudgeResult } from "../judges/schemas.ts";

export interface JudgeDivergencePair {
  store: "apple" | "google";
  appId: string;
  market: string;
  text: TextJudgeResult;
  vision: VisionJudgeResult;
  /** |locGapScore − culturalFitScore|, 0–10. */
  divergence: number;
}

export interface JudgeDivergenceReport {
  pairs: JudgeDivergencePair[];
  unpairedTextCount: number;
  unpairedVisionCount: number;
}

function pairKey(r: JudgeResult): string {
  return `${r.store}|${r.appId}|${r.market}`;
}

/**
 * Pairs text + vision results for the same `(store, appId, market)` tuple,
 * computes `|locGapScore − culturalFitScore|`, and returns the pairs in
 * divergence-descending order. Tie-break is the same lex order the ranker
 * uses, so re-running on the same input is deterministic.
 *
 * Unpaired results (only text, or only vision) are counted but excluded —
 * "divergence" is undefined for them.
 */
export function compareJudges(results: readonly JudgeResult[]): JudgeDivergenceReport {
  const texts = new Map<string, TextJudgeResult>();
  const visions = new Map<string, VisionJudgeResult>();

  for (const r of results) {
    if (r.kind === "text") texts.set(pairKey(r), r);
    else visions.set(pairKey(r), r);
  }

  const pairs: JudgeDivergencePair[] = [];
  for (const [key, text] of texts) {
    const vision = visions.get(key);
    if (!vision) continue;
    pairs.push({
      store: text.store,
      appId: text.appId,
      market: text.market,
      text,
      vision,
      divergence: Math.abs(text.locGapScore - vision.culturalFitScore),
    });
  }

  pairs.sort((a, b) => {
    const d = b.divergence - a.divergence;
    if (d !== 0) return d;
    const ak = `${a.store}|${a.appId}|${a.market}`;
    const bk = `${b.store}|${b.appId}|${b.market}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  let unpairedTextCount = 0;
  for (const key of texts.keys()) if (!visions.has(key)) unpairedTextCount += 1;
  let unpairedVisionCount = 0;
  for (const key of visions.keys()) if (!texts.has(key)) unpairedVisionCount += 1;

  return { pairs, unpairedTextCount, unpairedVisionCount };
}

export function renderJudgeDivergenceMarkdown(report: JudgeDivergenceReport): string {
  const lines: string[] = [];
  lines.push("# Judge divergence report");
  lines.push("");
  lines.push(
    `Paired ${report.pairs.length} text+vision result(s); ` +
      `${report.unpairedTextCount} text-only, ${report.unpairedVisionCount} vision-only (excluded).`,
  );
  lines.push("");
  if (report.pairs.length === 0) {
    lines.push("_No paired text+vision judge results to compare._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| App | Store | Market | Loc gap | Cultural fit | Δ |");
  lines.push("|---|---|---|---|---|---|");
  for (const p of report.pairs) {
    lines.push(
      `| ${p.appId} | ${p.store} | ${p.market} | ${p.text.locGapScore.toFixed(1)} | ` +
        `${p.vision.culturalFitScore.toFixed(1)} | ${p.divergence.toFixed(1)} |`,
    );
  }
  lines.push("");
  lines.push("## Reasoning side-by-side");
  lines.push("");
  for (const p of report.pairs) {
    lines.push(`### ${p.appId} (${p.store}, ${p.market})`);
    lines.push("");
    lines.push(`- **Text judge** (${p.text.locGapScore.toFixed(1)}): ${p.text.reasoning}`);
    lines.push(
      `- **Vision judge** (${p.vision.culturalFitScore.toFixed(1)}): ${p.vision.reasoning}`,
    );
    lines.push("");
  }
  return lines.join("\n");
}
