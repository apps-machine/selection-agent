# Eval suites

Baseline'd LLM eval suites, regression-tested every PR. Land in M4-M7:

- `text-judge.eval.ts` — 10 cases, see `.context/eng-review-test-plan.md` in studio-core
- `vision-judge.eval.ts` — 10 cases
- `lang-quality.eval.ts` — 50 phrases × N target languages, back-translation accuracy ≥85%

CI blocks merges that regress eval scores by > 10%.
