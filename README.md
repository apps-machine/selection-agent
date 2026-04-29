# @apps-machine/selection-agent

> Rank app opportunities globally — across 50+ markets, dual-store (Apple App Store + Google Play) — by localization gap, paywall complexity, estimated revenue, and Claude judges (text + vision).

```bash
# After npm publish (lands in milestone M7):
npx @apps-machine/selection-agent demo

# Pre-publish (today): clone + run via Bun
git clone https://github.com/apps-machine/selection-agent && cd selection-agent
bun install
bun src/cli/index.ts demo
```

Zero config, no API key. ~30s to your first ranked brief from cached data.

## What it does

1. Scrapes top grossing charts across markets (Apple + Google).
2. Scores each candidate on a composite of localization gap × paywall complexity × revenue × velocity.
3. Runs Claude judges (text + vision in parallel) on the top N candidates.
4. Outputs a ranked markdown brief (or JSON via `--format json`).

Built for indie hackers shipping clones at scale. Open core, MIT licensed. Part of [Apps Machine](https://github.com/apps-machine).

## Install

```bash
bun add -g @apps-machine/selection-agent
# or run ad-hoc
npx @apps-machine/selection-agent --help
```

Requires [Bun](https://bun.sh) ≥ 1.0.

## Commands

```bash
selection-agent demo                       # cached snapshot, no API key — works today
selection-agent scan                        # live dual-store scan (M2-M6, needs ANTHROPIC_API_KEY)
selection-agent scan --no-llm               # heuristics only (M3 — heuristic scorers shipped)
selection-agent scan --top 50               # limit candidates (M2)
selection-agent scan --format json          # JSON output (M2)
selection-agent snapshot                    # daily Track B writer (M5)
selection-agent report --compare-judges     # text vs vision judge divergence (M6)
selection-agent --help                      # full help — works today
```

The agent ranks markets globally — there is no `--market BR` flag. Filter via your founder risk thresholds (e.g., 3 simultaneous markets max, lang quality ≥ 8/10) downstream.

## Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Required for | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | `scan` (without `--no-llm`) | — |
| `ANTHROPIC_TEXT_JUDGE_MODEL` | optional | `claude-sonnet-4-6` |
| `ANTHROPIC_VISION_JUDGE_MODEL` | optional | `claude-sonnet-4-6` |
| `LOG_LEVEL` | optional | `info` |
| `SELECTION_AGENT_DB` | optional | `./.cache/selection-agent.sqlite` |

## Development

```bash
git clone https://github.com/apps-machine/selection-agent
cd selection-agent
bun install
bun test
bun run typecheck
bun src/cli/index.ts demo
```

Pre-commit: `git config core.hooksPath .githooks` (runs `gitleaks` if installed).

## Milestones

Phase 0 ships incrementally:

| Milestone | Scope | Status |
|---|---|---|
| M1 | Multi-repo open core scaffolding | shipped (v0.1.0) |
| M2 | Dual-OS dual-store scrapers + 3-tier resilience | shipped (v0.1.0) |
| M3 | Heuristic scoring (loc gap, paywall, revenue, composite) + token-bucket rate limiter + Playwright Apple fallback | shipped (v0.2.0) |
| M4 | Claude judges (text + vision) + lang quality eval | upcoming |
| M5 | Velocity scaffolding (Track B time-series) | upcoming |
| M6 | Demo dataset + orchestrator + reporting | upcoming |
| M7 | citty CLI polish + tests + eval baselines + npm publish | upcoming |

## Architecture

See [Apps Machine architecture](https://github.com/apps-machine) for the full 10-component pipeline. This repo is **Component 1** — the entry point.

## License

MIT — see [LICENSE](./LICENSE).

## Related

- [`@apps-machine/shared-types`](https://github.com/apps-machine/shared-types) — Zod schemas
- [Apps Machine org](https://github.com/apps-machine) — all 9 OSS components
