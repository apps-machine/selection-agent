import type { RankedCandidate, ScoredCandidate } from "../orchestrator/types.ts";

/**
 * Mean confidence across whatever judges ran. Missing judges count as
 * 0 — running with one judge is strictly less informative than running
 * with both, so missing-judge candidates lose the tie-break against
 * fully-judged ones at the same composite.
 */
function judgeConfidence(c: ScoredCandidate): number {
  const present: number[] = [];
  if (c.textJudge !== null) present.push(c.textJudge.confidence);
  if (c.visionJudge !== null) present.push(c.visionJudge.confidence);
  if (present.length === 0) return 0;
  const sum = present.reduce((a, b) => a + b, 0);
  return sum / present.length;
}

/**
 * Deterministic 4-level sort:
 *   1. composite score descending
 *   2. judgeConfidence descending (mean of text + vision; 0 when both null)
 *   3. ratingsCount descending — popularity as a "less risky validation" tiebreak
 *      (null treated as 0)
 *   4. (store, appId, market) ascending lexical — final pin so the same input
 *      always produces the same order, even under shuffle
 */
export function rank(candidates: ScoredCandidate[], topN: number): RankedCandidate[] {
  const sorted = [...candidates].sort((a, b) => {
    const compositeDelta = b.composite.composite - a.composite.composite;
    if (compositeDelta !== 0) return compositeDelta;

    const confDelta = judgeConfidence(b) - judgeConfidence(a);
    if (confDelta !== 0) return confDelta;

    const aRC = a.app.ratingsCount ?? 0;
    const bRC = b.app.ratingsCount ?? 0;
    const ratingsDelta = bRC - aRC;
    if (ratingsDelta !== 0) return ratingsDelta;

    const aKey = `${a.app.store}|${a.app.appId}|${a.app.market}`;
    const bKey = `${b.app.store}|${b.app.appId}|${b.app.market}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  return sorted.slice(0, topN).map((c, i) => ({ ...c, rank: i + 1 }));
}
