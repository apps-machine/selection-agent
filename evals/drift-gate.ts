/**
 * Eval drift gate. Pure helpers used by every `evals/*.eval.ts` suite to
 * decide whether a fresh judge run has drifted unacceptably from the
 * committed baseline.
 *
 * Internal-only — NOT exported from the package. The drift logic was
 * previously inlined in each eval file; M7 pulls it out so the policy is
 * auditable in one place and unit-testable without spending Anthropic
 * tokens. Keeping it internal-only (vs a SemVer'd public export) means
 * tolerance semantics can evolve without breaking external consumers
 * (there are none).
 *
 * Drift policy:
 *  - score drift: |actual − baseline| ≤ tolerance (default 1.0 on a 0-10
 *    scale, i.e., ±10%). Outside tolerance fails.
 *  - passes flag: a hard equality check. The `passes` flag captures a
 *    binary judgement (`semanticEquivalenceScore >= 7`-style); flipping
 *    it across a baseline cycle is always a regression worth blocking.
 *
 * Both helpers return a Result-style discriminated union instead of
 * throwing — eval files can decide whether to log + skip or hard-fail
 * (CI gate hard-fails).
 */

export const DEFAULT_TOLERANCE = 1.0;

export interface DriftAssertionInput {
  actual: number;
  baseline: number;
  /** Absolute delta tolerance on a 0-10 scale. Defaults to ±1.0 (10%). */
  tolerance?: number;
}

export type DriftAssertionResult =
  | { ok: true }
  | { ok: false; reason: string; delta: number; tolerance: number };

/**
 * Assert that `actual` is within `tolerance` of `baseline`. Returns a
 * Result so callers can format messages with the eval's case id.
 */
export function assertDriftWithinTolerance(input: DriftAssertionInput): DriftAssertionResult {
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
  if (tolerance <= 0) {
    return {
      ok: false,
      reason: `tolerance must be > 0, got ${tolerance}`,
      delta: Number.NaN,
      tolerance,
    };
  }
  const delta = Math.abs(input.actual - input.baseline);
  if (delta <= tolerance) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `score drift ${delta.toFixed(3)} exceeds tolerance ${tolerance.toFixed(3)} (actual=${input.actual}, baseline=${input.baseline})`,
    delta,
    tolerance,
  };
}

export interface PassesAssertionInput {
  actual: boolean;
  baseline: boolean;
}

export type PassesAssertionResult = { ok: true } | { ok: false; reason: string };

/**
 * Assert that the `passes` flag matches the baseline. Flipping a passes
 * flag is always a hard fail — no tolerance. The flag captures a binary
 * judgement (e.g., `semanticEquivalenceScore >= 7`) and a flip means the
 * eval's verdict for that case has changed direction.
 */
export function assertPassesUnchanged(input: PassesAssertionInput): PassesAssertionResult {
  if (input.actual === input.baseline) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `passes flag flipped: actual=${input.actual}, baseline=${input.baseline}`,
  };
}
