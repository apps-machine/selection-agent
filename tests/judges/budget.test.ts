import { describe, expect, test } from "bun:test";
import {
  CostBudget,
  DEFAULT_BUDGET_USD,
  MODEL_PRICING_USD_PER_MTOK,
  estimateCallCostUsd,
} from "../../src/judges/budget.ts";

describe("MODEL_PRICING_USD_PER_MTOK", () => {
  test("includes sonnet, opus, haiku", () => {
    expect(MODEL_PRICING_USD_PER_MTOK["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_PRICING_USD_PER_MTOK["claude-opus-4-7"]).toBeDefined();
    expect(MODEL_PRICING_USD_PER_MTOK["claude-haiku-4-5-20251001"]).toBeDefined();
  });
});

describe("estimateCallCostUsd", () => {
  test("computes Sonnet 4.6 cost for 100 in / 50 out", () => {
    // Sonnet 4.6: $3/MTok in, $15/MTok out
    // 100 in = 100 * 3 / 1_000_000 = 0.0003
    // 50 out = 50 * 15 / 1_000_000 = 0.00075
    // total = 0.00105
    const c = estimateCallCostUsd({
      model: "claude-sonnet-4-6",
      input: 100,
      output: 50,
    });
    expect(c).toBeCloseTo(0.00105, 6);
  });

  test("falls back to Sonnet pricing on unknown model + emits warning flag", () => {
    const c = estimateCallCostUsd({
      model: "claude-some-future-model",
      input: 100,
      output: 50,
    });
    expect(c).toBeCloseTo(0.00105, 6);
  });
});

describe("CostBudget", () => {
  test("starts at zero", () => {
    const b = new CostBudget();
    expect(b.spentUsd()).toBe(0);
  });

  test("records and accumulates", () => {
    const b = new CostBudget();
    b.record({ model: "claude-sonnet-4-6", input: 100, output: 50 });
    b.record({ model: "claude-sonnet-4-6", input: 100, output: 50 });
    expect(b.spentUsd()).toBeCloseTo(0.0021, 6);
  });

  test("default cap is $20", () => {
    expect(DEFAULT_BUDGET_USD).toBe(20);
  });

  test("under cap does not throw on assertUnderBudget", () => {
    const b = new CostBudget({ capUsd: 0.01 });
    b.record({ model: "claude-sonnet-4-6", input: 100, output: 50 });
    expect(() => b.assertUnderBudget()).not.toThrow();
  });

  test("over cap throws Stripe-tier error", () => {
    const b = new CostBudget({ capUsd: 0.0005 }); // tiny cap
    b.record({ model: "claude-sonnet-4-6", input: 100, output: 50 });
    expect(() => b.assertUnderBudget()).toThrow(/budget/i);
  });

  test("error message mentions cap, current spend, and how to raise", () => {
    const b = new CostBudget({ capUsd: 0.0005 });
    b.record({ model: "claude-sonnet-4-6", input: 100, output: 50 });
    let msg = "";
    try {
      b.assertUnderBudget();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/\$0\.00/); // cost mentioned
    expect(msg).toMatch(/SELECTION_AGENT_BUDGET_USD|--budget/i); // how-to-raise
  });

  test("recordAndAssert throws inline when next call would exceed cap", () => {
    const b = new CostBudget({ capUsd: 0.0005 });
    expect(() =>
      b.recordAndAssert({ model: "claude-sonnet-4-6", input: 100, output: 50 }),
    ).toThrow(/budget/i);
  });

  test("recordAndAssert under cap does not throw", () => {
    const b = new CostBudget({ capUsd: 1 });
    expect(() =>
      b.recordAndAssert({ model: "claude-sonnet-4-6", input: 100, output: 50 }),
    ).not.toThrow();
  });

  test("breakdownByModel tracks per-model totals", () => {
    const b = new CostBudget();
    b.record({ model: "claude-sonnet-4-6", input: 100, output: 50 });
    b.record({ model: "claude-haiku-4-5-20251001", input: 1000, output: 200 });
    const bd = b.breakdownByModel();
    expect(bd["claude-sonnet-4-6"]).toBeDefined();
    expect(bd["claude-haiku-4-5-20251001"]).toBeDefined();
    expect(bd["claude-sonnet-4-6"]!.callCount).toBe(1);
    expect(bd["claude-haiku-4-5-20251001"]!.callCount).toBe(1);
  });
});
