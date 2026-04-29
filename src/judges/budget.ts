export const DEFAULT_BUDGET_USD = 20;

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICING_USD_PER_MTOK: Readonly<Record<string, ModelPricing>> = {
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-7": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 0.8, outputPerMTok: 4 },
};

const FALLBACK_PRICING: ModelPricing = MODEL_PRICING_USD_PER_MTOK[
  "claude-sonnet-4-6"
]!;

export interface CallUsage {
  model: string;
  input: number;
  output: number;
}

export function estimateCallCostUsd(usage: CallUsage): number {
  const p = MODEL_PRICING_USD_PER_MTOK[usage.model] ?? FALLBACK_PRICING;
  return (
    (usage.input * p.inputPerMTok) / 1_000_000 +
    (usage.output * p.outputPerMTok) / 1_000_000
  );
}

export interface ModelBreakdown {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostBudgetOptions {
  capUsd?: number;
  envHint?: string;
}

export class CostBudget {
  private readonly capUsd: number;
  private readonly envHint: string;
  private spent = 0;
  private byModel: Map<string, ModelBreakdown> = new Map();

  constructor(opts: CostBudgetOptions = {}) {
    this.capUsd = opts.capUsd ?? DEFAULT_BUDGET_USD;
    this.envHint = opts.envHint ?? "SELECTION_AGENT_BUDGET_USD or --budget flag";
  }

  record(usage: CallUsage): void {
    const cost = estimateCallCostUsd(usage);
    this.spent += cost;
    const key = usage.model;
    const cur = this.byModel.get(key) ?? {
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    cur.callCount += 1;
    cur.inputTokens += usage.input;
    cur.outputTokens += usage.output;
    cur.costUsd += cost;
    this.byModel.set(key, cur);
  }

  /**
   * Records the usage AND throws if the running spend has exceeded the cap.
   * Use as the `onTokenUsage` callback for judges to fail-fast instead of
   * letting a runaway loop spend through the cap silently.
   */
  recordAndAssert(usage: CallUsage): void {
    this.record(usage);
    this.assertUnderBudget();
  }

  spentUsd(): number {
    return this.spent;
  }

  cap(): number {
    return this.capUsd;
  }

  assertUnderBudget(): void {
    if (this.spent > this.capUsd) {
      throw new Error(
        [
          `🛑 selection-agent: scan exceeded cost budget`,
          `Cause: spent $${this.spent.toFixed(4)} > cap $${this.capUsd.toFixed(2)}`,
          `Fix: re-run with a higher cap via ${this.envHint}`,
          `Docs: https://github.com/apps-machine/selection-agent#cost-budget`,
        ].join("\n"),
      );
    }
  }

  breakdownByModel(): Record<string, ModelBreakdown> {
    return Object.fromEntries(this.byModel.entries());
  }
}
