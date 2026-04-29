# Eval suites

Live-LLM eval suites for M4 judges. Skipped by default; activated via env vars.

## Activation

```bash
# Run text-judge + lang-quality evals (vision is wired but todo'd until screenshots are dropped in)
EVALS=1 ANTHROPIC_API_KEY=sk-ant-… bun test evals/

# Seed/refresh baselines after a deliberate prompt or model change
EVALS=1 WRITE_BASELINE=1 ANTHROPIC_API_KEY=sk-ant-… bun test evals/
```

## Files

| File | Purpose |
|---|---|
| `text-judge.eval.ts` | 10 cases (Cal AI, PictureThis, Remini, indie EN-only, machine-translated paywall, etc.). Asserts `locGapScore` within case-defined min/max range and signal flags. |
| `vision-judge.eval.ts` | 10 cases — wired structurally; activation needs real screenshot binaries dropped under `fixtures/screenshots/{case-id}/`. |
| `lang-quality.eval.ts` | Runs the 50-phrase back-translation eval against the 6 founder-confirmed target markets. Baseline entry says `en/us` must score ≥ 9.0. |
| `fixtures/text-judge-cases.json` | Hand-crafted RawAppData fixtures + expected score ranges. |
| `fixtures/vision-judge-cases.json` | Case definitions; needs binaries to run. |
| `fixtures/lang-corpus.json` | 50 EN phrases — paywall + onboarding + ASO domain (founder-confirmed corpus type B). |
| `fixtures/lang-targets.json` | The 6 Phase 0 markets: US, JP, DE, FR, BR, ES. |
| `baselines/` | JSON snapshots of last green run per eval. CI fails when current run drifts > 10%. |

## Regression policy

`REGRESSION_THRESHOLD = 0.1` (10% normalized score drift). When the threshold trips:

1. Inspect the case + the diff vs. the baseline blob.
2. If the regression is intentional (prompt change, model upgrade), re-run with `WRITE_BASELINE=1`.
3. If unintentional, revert the change that caused it.

## Cost expectations (Sonnet 4.6, 2026 pricing)

| Eval | Calls | Approx cost |
|---|---|---|
| text-judge (10 cases) | 10 | ~$0.05 |
| vision-judge (10 cases × 5 screenshots) | 10 | ~$0.30 |
| lang-quality (6 markets × 3 calls) | 18 | ~$0.20 |

Full eval sweep: ~$0.55. Fits inside the $20/scan budget cap by 36×.
