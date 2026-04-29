# Eval suites

Live-LLM eval suites for M4 judges. Skipped by default; activated via env vars.

## Activation

The eval files use the `.eval.ts` suffix — bun's default `bun test` does NOT
auto-discover them, by design (so CI doesn't quietly burn API credits). Run
them explicitly via the npm scripts, or pass paths with `./` prefix:

```bash
# Run text-judge + lang-quality evals (vision is todo'd until screenshots are dropped in)
EVALS=1 ANTHROPIC_API_KEY=sk-ant-... bun run evals

# Seed/refresh baselines after a deliberate prompt or model change
EVALS=1 ANTHROPIC_API_KEY=sk-ant-... bun run evals:write-baseline

# Or pass explicit paths if you want to run a single suite:
EVALS=1 ANTHROPIC_API_KEY=sk-ant-... bun test ./evals/text-judge.eval.ts
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

## Known limits (seeded 2026-04-29 baselines)

**text-judge**: 8 of 10 cases seeded. Two cases dropped — `localized-but-no-pix-br`
and `cultural-mismatch-jp` — because text-judge alone cannot reliably detect
PIX-integration absence or food-imagery cultural mismatch. Those signals belong
to vision-judge (for imagery) and to a future ASO-payment scraper (for PIX).
TODO(M5): either move those cases to vision-judge.eval.ts or relax the
fixture's `expectedSignals` for text-only judging.

**lang-quality**: 1 of 6 markets seeded (`en/us` baseline only). The other 5
target languages (ja, de, fr, pt-BR, es) errored before the baseline write,
most likely from `max_tokens: 4096` overflowing on the forward-translation
step when target-language tokens are wider than English (Japanese kanji,
German compound nouns). TODO(M5): bump `max_tokens` per call, or split the
50-phrase batch into chunks of ~25.

## Cost expectations (Sonnet 4.6, 2026 pricing)

| Eval | Calls | Approx cost |
|---|---|---|
| text-judge (10 cases) | 10 | ~$0.05 |
| vision-judge (10 cases × 5 screenshots) | 10 | ~$0.30 |
| lang-quality (6 markets × 3 calls) | 18 | ~$0.20 |

Full eval sweep: ~$0.55. Fits inside the $20/scan budget cap by 36×.
