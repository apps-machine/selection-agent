import { describe, expect, test } from "bun:test";
import {
  assertDriftWithinTolerance,
  assertPassesUnchanged,
  DEFAULT_TOLERANCE,
} from "../../evals/drift-gate.ts";

describe("assertDriftWithinTolerance", () => {
  test("default tolerance ±1.0 — 8.0 vs 9.0 passes", () => {
    const r = assertDriftWithinTolerance({ actual: 8.0, baseline: 9.0 });
    expect(r.ok).toBe(true);
  });

  test("default tolerance ±1.0 — 8.0 vs 9.5 fails (delta 1.5 > 1.0)", () => {
    const r = assertDriftWithinTolerance({ actual: 8.0, baseline: 9.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.delta).toBeCloseTo(1.5);
      expect(r.tolerance).toBe(DEFAULT_TOLERANCE);
      expect(r.reason).toContain("score drift");
      expect(r.reason).toContain("1.500");
      expect(r.reason).toContain("1.000");
    }
  });

  test("delta exactly equal to tolerance is OK (≤ inclusive)", () => {
    const r = assertDriftWithinTolerance({ actual: 8.0, baseline: 9.0, tolerance: 1.0 });
    expect(r.ok).toBe(true);
  });

  test("custom tolerance ±0.5 — 8.0 vs 8.4 passes", () => {
    const r = assertDriftWithinTolerance({ actual: 8.0, baseline: 8.4, tolerance: 0.5 });
    expect(r.ok).toBe(true);
  });

  test("custom tolerance ±0.5 — 8.0 vs 8.6 fails", () => {
    const r = assertDriftWithinTolerance({ actual: 8.0, baseline: 8.6, tolerance: 0.5 });
    expect(r.ok).toBe(false);
  });

  test("symmetric — direction of drift doesn't matter", () => {
    const up = assertDriftWithinTolerance({ actual: 9.0, baseline: 8.0 });
    const down = assertDriftWithinTolerance({ actual: 8.0, baseline: 9.0 });
    expect(up.ok).toBe(true);
    expect(down.ok).toBe(true);
  });

  test("zero tolerance is rejected (caller must specify > 0)", () => {
    const r = assertDriftWithinTolerance({ actual: 8.0, baseline: 8.0, tolerance: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("must be > 0");
    }
  });

  test("negative tolerance is rejected", () => {
    const r = assertDriftWithinTolerance({ actual: 8.0, baseline: 8.0, tolerance: -1 });
    expect(r.ok).toBe(false);
  });

  test("identical scores always pass", () => {
    const r = assertDriftWithinTolerance({ actual: 7.5, baseline: 7.5 });
    expect(r.ok).toBe(true);
  });
});

describe("assertPassesUnchanged", () => {
  test("both true → ok", () => {
    expect(assertPassesUnchanged({ actual: true, baseline: true }).ok).toBe(true);
  });

  test("both false → ok", () => {
    expect(assertPassesUnchanged({ actual: false, baseline: false }).ok).toBe(true);
  });

  test("true → false flip → fail (the case got worse)", () => {
    const r = assertPassesUnchanged({ actual: false, baseline: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("passes flag flipped");
      expect(r.reason).toContain("actual=false");
      expect(r.reason).toContain("baseline=true");
    }
  });

  test("false → true flip → fail (the case 'improved' but model behavior changed)", () => {
    // A flip in either direction is a regression worth blocking — even
    // "improvement" can mean the model is now over-confident on a case
    // we know should fail. The drift gate's job is to catch behavior
    // changes; the founder decides whether it's good or bad.
    const r = assertPassesUnchanged({ actual: true, baseline: false });
    expect(r.ok).toBe(false);
  });
});
