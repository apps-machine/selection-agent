# Changelog

All notable changes to `@apps-machine/selection-agent` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] — 2026-05-08

The discovery methodology shipped as four CLI commands + a library API.
The package's primitive shifts from "live scan + judges" (v0.6-0.10) to
**"list the takeable" 5-stage discovery pipeline** (v0.11). The methodology
itself comes from empirical work: two consecutive predictive-ranker
investigations (locGap thesis + additive linear factor stack) returned DEAD
verdicts on tier-2 SEA mobile-app data, and the operator-correct reframe is
"filter durable winners + classify clonability" rather than "predict future
winners from public signal."

### Added

- **`selection-agent audit` CLI command** (Stage 1 pre-flight data audit) —
  runs 6 SQL checks against a local sqlite cache, surfaces coverage /
  point-in-time / precompute / app_invariants issues before discovery
  cycles. Exit 0 if all PASS or WARN, exit 1 if any FAIL. Per-check
  PASS/WARN/FAIL with markdown report output.
- **`selection-agent shortlist` CLI command** (Stage 2 shortlist pipeline)
  — 5-filter shortlist generator (durability, cross-market, DNA-clonable
  category, indie-vs-mega via LLM) producing a ranked CSV/JSON of
  clonable indie portfolio candidates. LLM clonability classifier
  optional via `--no-llm` flag; otherwise requires `ANTHROPIC_API_KEY`.
  Reference funnel sanity ranges documented inline so deviations are
  surfaced loud.
- **`selection-agent risk-check` CLI command** (Stage 3 risk-threshold
  evaluation) — annotates a shortlist with PASS/WARN/FAIL/INFO per check
  against a user-supplied Zod-validated thresholds JSON. 5 checks:
  `markets_spread`, `tenure`, `subscription_iap`, `supported_markets`,
  `clonable_dna`. Aggregate verdict per candidate, summary across
  shortlist. JSON or CSV output.
- **`selection-agent dossier` CLI command** (Stage 5 dossier generator) —
  generates a populated markdown dossier from shortlist + candidate ref.
  Default template includes 12 sections (front matter, candidate
  auto-populated from shortlist, opportunity placeholder, 9 strategic
  filters, archetype, ASO keywords, AI hook, risk thresholds, kill
  criteria, out-of-scope, operator signoff). Custom templates via
  `--template <path>` with mustache-style `{{...}}` token substitution.
- **Library API entry point** at `src/index.ts` — re-exports schemas,
  evaluators, and template constants for npm consumers building their
  own discovery tooling. Public exports: `RiskThresholdsSchema`,
  `RiskThresholds`, `DEFAULT_SUPPORTED_MARKETS`,
  `DEFAULT_CLONABLE_DNA_CLASSES`, `evaluateCandidate`,
  `evaluateShortlist`, `buildDossier`, `parseCandidateRef`,
  `findCandidate`, `DEFAULT_DOSSIER_TEMPLATE`, plus types.
- **`docs/discovery-methodology.md`** — productized methodology guide for
  npm consumers (5-stage pipeline, 7 anti-patterns, kill-criteria
  framework, lessons-learned, citations).
- **README rewrite** for the v0.11 audience — npm-front-page for solo
  indie operators discovering the package via `npm view` or the GitHub
  mirror.

### Changed

- `package.json` `files:` array now includes `docs/` so the methodology
  guide ships in the published tarball, and `CHANGELOG.md` so version
  history is visible to npm consumers without leaving the package.

### Engineering

- 880 tests pass (was 750 in v0.10.0). Added ~130 tests across 4 CLI
  command suites + library API surface.
- Typecheck clean.
- Open-core boundary preserved: no operator-specific or
  organization-internal references in any published file.

## [0.10.0] - 2026-05-07

Path B' verdict shipped: locGap LLM judge + 70-cohort backtest infrastructure
+ DEAD verdict on the localization-gap thesis. The infrastructure is reusable
for future thesis variants; the v1 production ranker carries a structural
weakness (velocity is anti-predictive) that should inform v2 design.

### Added

- `src/judges/apptweak-loc-gap-adapter.ts` — pure adapter: `AppTweakMetadataRecord`
  → minimal `RawAppData` for the locGap text-judge. Handles store name
  normalization (`googleplay` → `google`) and short-circuits null metadata
  (AppTweak 422 responses).
- `src/judges/apptweak-loc-gap-runner.ts` — streaming LLM-judge runner with
  resume + budget cap. Per-market `apptweakLocGapPromptVersion(market)`
  scheme: `v1.0.0-apptweak-{id,vn,th,my,bd,us,jp,kr,br,mx}`. Idempotent at
  the `signal_snapshots` PK level.
- `src/ground-truth/simple-winner-score.ts` — boolean alternative to v1's
  weighted formula: tier=`winner` iff present in top-100 within `t_measure ± 7d`.
  Exists alongside `winner-score.ts` (untouched) for backtests where review/
  revenue inputs are unavailable.
- `src/backtest/locgap-baseline-stats.ts` — pure stats reducer for sanity-check
  baselines per (market, t0).
- `src/backtest/pathb-multi-cohort.ts` — internal: 70-cohort batch runner +
  aggregate stats + paired-comparison deltas. Not in `package.json:files`
  whitelist (internal, not shipped to npm).
- `BacktestOptions.signal_prompt_version_filter` — per-signal prompt_version
  filter. Used by the multi-cohort runner to select the per-market locGap row
  for each cohort.
- `BacktestOptions.skip_leakage_check` + `GetFrozenCohortFeaturesOptions`
  opt-out — disables the post-t0-row leakage tripwire for batch-precomputed
  multi-cohort runs (where post-t0 rows are LATER cohorts, not leakage).
  The SELECT cutoff (`t<=t0`) still applies.

### Notes

- Path B verdict — locGap thesis DEAD. See `docs/planning/agent-v1-path-b-results.md`
  for the precision@K tables, paired-comparison deltas, and recommended
  next moves (re-frame as new-entrant prediction; tighten winner threshold;
  per-category breakdown).
- Velocity is anti-predictive on this dataset (precision@K consistently
  below random across 70 cohorts). v2 should de-weight velocity or replace
  it with a stability-style signal.
- LLM judge spend on the validation: ~$12 across multiple runs (initial
  $3.83 sunk on app+t0-only deduplication, ~$8 on per-market re-runs).

## [0.9.0] - 2026-05-05

Global AppTweak dataset + backtest consumers. Extends the Path B''' SEA-only
frozen dataset to a publishable-grade global dataset and lands the consumer
pipeline (Tasks 1-5 from the third handover) so the backtest is end-to-end
runnable as soon as the locGap LLM judge ships.

### Added

- `chart_snapshots.category` CHECK constraint extended to accept
  `top_grossing_overall` and `top_free_overall`. Market codes opened up
  to the ~130 ISO 3166-1 alpha-2 codes that AppTweak supports (was 5 SEA
  markets only). Migration is additive and idempotent for existing rows.
- `scripts/apptweak/discover-markets.ts` — probes 249 ISO codes ×
  `{iphone, android}` against the AppTweak chart endpoint and records
  per-(cc, device) coverage to `markets-coverage.tsv`. Use as the source
  of truth for which markets AppTweak supports before bulk-pulling.
- `scripts/apptweak/pull-charts.ts` and `pull-enrichment.ts`:
  parameterized via env vars (`APPTWEAK_KEY_VAR`,
  `APPTWEAK_MARKETS_IPHONE/ANDROID`, `APPTWEAK_CHART_TYPES`,
  `APPTWEAK_T0S`, `APPTWEAK_ENRICH_MARKETS`,
  `APPTWEAK_ENRICH_CHART_CATEGORY`). Defaults preserve original behavior;
  multi-account orchestration enabled for global pulls.
- `pull-enrichment.ts` reads `chart-snapshots.tsv.gz` (gzipped TSV) via
  `node:zlib.gunzipSync`. Auto-bootstraps `metadata.jsonl` from
  `metadata.jsonl.gz` on startup if needed; recompresses on exit. The
  uncompressed forms are now gitignored under `data/apptweak-*/`.
- `data/apptweak-2026-05-04/` extended to global coverage (private to
  the monorepo, not mirrored to OSS):
  - 11.7M chart rows, 136 unique markets, 258 (cc, device) combos.
  - 12 monthly enrichment t0s on tier-2 SEA (May 2025 → April 2026).
  - 5 tier-1 control markets (us/jp/kr/br/mx) at 2 t0s (2025-08-04 +
    2026-02-04) for cross-tier comparability.
  - Top-free across 32 unique markets.

### Internal (OSS-mirrored, not npm-published)

- `src/ground-truth/apptweak-import.ts`: TSV.gz loader, idempotent
  `INSERT OR IGNORE` on PK. Drops + recreates `idx_chart_snapshots_app`
  around bulk insert (Codex R2 #8 fix retained from `appgoblin-import` —
  converts O(N log N) per-row B-tree maintenance into a single rebuild).
- `src/ground-truth/apptweak-jsonl.ts`: streaming reader for
  `metadata.jsonl` + `metrics.jsonl`. Streams + indexes in memory rather
  than importing into SQLite — every consumer is a one-shot scan.
- `src/signals/rank-stability.ts`: extracted std-dev primitives from
  `winner-score.ts` so the v1 incumbent-vulnerability fallback can reuse
  the math without depending on winner-score orchestration. Two
  normalizers: retention-proxy (sd=0 → 1, sd ≥ breakeven → 0) and
  vulnerability (sd=0 → 0, sd ≥ breakeven → 10).
- `src/signals/incumbent-vulnerability.ts`: wires rank-stability as the
  v1 fallback path when no enrichment metrics are available.
- `src/backtest/{cli,harness}.ts`: wires the harness to AppTweak
  importers; previously hard-coded to the AppGoblin path.
- 4 new test files covering the new code paths. 739 / 739 pass.

### Empirical findings (recorded for future plans)

- AppTweak credit pricing: chart pulls match plan (~375 credits per
  (m, s, 12 mo)), but per-(m, s, t0) full enrichment is ~2,500 credits
  (metadata ~1,020 + metrics ~1,500), not ~1,100 as planned. ~2.3×
  overrun on enrichment. Cost model recalibrated mid-flight.
- Language code semantics in `/store/apps/metadata.json`: `jp:ja`,
  `kr:ko`, `id:id`, `vn:vi`, `th:th`, `my:ms`, `bd:bn` work; `us:en`,
  `br:pt`, `mx:es` and regional variants (`en-US`, `pt-BR`, `es-MX`,
  `es_419`) all fail with 422. `us:us`, `br:br` work (country code as
  language). `mx` requires omitting the language param entirely.
  `parseMarkets()` accepts an empty language segment for this case.
- Idempotence pitfall: state DB at
  `node_modules/.cache/apptweak/state.db` resets between sessions while
  `chart-snapshots.tsv.gz` persists. Phase 1 of the global pull
  re-pulled the 9 SEA combos already in the baseline TSV. Detected
  during Phase 2.a (which paid 2× for ~26k credits before being
  aborted). Fixed by deduping on the full row tuple. Future re-runs
  should preserve state across sessions or probe the TSV before
  triggering pulls.

## [0.8.1] - 2026-05-02

Forward-collection fix. Closes a v0.7.0 oversight discovered during agent v1 build.

### Fixed

- `snapshot` CLI default markets pivoted from the legacy Phase 0 tier-1
  cluster (`us, jp, de, fr, br, es`) to the tier-2 SEA cluster
  (`bd, th, vn, my, id`) where the locGap thesis is empirically alive
  per `m7.5-thesis-validation.md`. v0.7.0 pivoted `scan`'s
  `DEFAULT_MARKETS` but missed the snapshot path; the daily Track-B
  forward-collection cron was silently writing tier-1 ranks instead of
  the tier-2 cohort the v1 backtest plan needs.

### Added

- `snapshot` CLI now accepts `--markets <comma,sep,iso>` (matches
  `scan` flag shape). Override the default cluster without editing
  source. INVALID_MARKETS error surface with explicit fix hint.
- `forward-collection/` setup helpers in
  `packages/selection-agent/scripts/forward-collection/` — daily macOS
  launchd cron + plist template + setup script. One-command install of
  the daily forward-snapshot writer to `~/.appsmachine/charts.db`. See
  the directory's README for install / verify / uninstall.

### Internal

- `PHASE_0_MARKETS` constant in `src/velocity/run-snapshot.ts` renamed
  to `DEFAULT_SNAPSHOT_MARKETS` and pivoted to tier-2 SEA. Matches the
  `scan` default since v0.7.0.
- `PHASE_0_STORES` renamed to `DEFAULT_SNAPSHOT_STORES` (apple + google
  unchanged).

### Notes

- Background context: 42matters' "14-day trial" turned out to be a UI
  demo rather than an API trial. The v1 ground-truth pipeline therefore
  pivoted from "fallback to 42matters for historical metadata" to
  **path A + B**: validate v1 via real ROAS on shipped apps (path A,
  Hybrid C apps-first stays primary), and start collecting our own
  forward time-series TODAY (path B — this v0.8.1 ships the cron).
  Real backtest cohort becomes available at +6 months on accumulated
  data we own. Zero commercial dependency. See
  `docs/planning/agent-v1-foundation.md` for the full revised plan.

## [0.8.0] - 2026-05-02

Agent v1 foundation — Opportunity contract, 4-signal composer, backtest harness, and ground-truth pipeline. The selection-agent's primitive shifts from "ranked candidate list" (v0.7) to **structured Opportunity records** (v1) that flow through a leak-proof backtest pipeline.

### Added

- **Opportunity contract** (`src/opportunities/`) — new public Zod schema replacing the legacy composite scoring as the agent's primary output type. Three rings of fields: load-bearing (signal_values, predicted, kill_metric, actual_outcome, score, eligible) for backtest queries + outcome tracking; narrative (thesis prose + evidence URLs) for indie-maker reading; escape-hatch (`metadata`) for unproven fields that graduate into the contract once load-bearing across runs.
- **4 ranker signals** with composer:
  - `locGap` (existing M4 — text judge)
  - `velocity` (extended for v1: `src/velocity/v1-score.ts` reads chart_snapshots, 30d-smoothing filter, top-200 scope, persists to signal_snapshots with versioning)
  - `incumbent_vulnerability` (NEW: `src/signals/incumbent-vulnerability.ts` — deterministic, days_since_update + 90d rating trend; null when reviews missing)
  - `cpi_ltv_proxy` (NEW: `src/signals/cpi-ltv-proxy.ts` + JSON seed for tier-2 SEA categories; family-fallback for unseen categories within the same market)
- **Top-3 robust mean scoring** (`src/signals/composer.ts`) — `computeOpportunityScore(SignalValues)` returns `{ score, eligible }`. N<3 non-null signals returns `eligible: false` (Codex Round 2 #3 fix — no silent null-to-zero coercion).
- **Mechanic evidence** as descriptive text-only via `vision-judge.generateMechanicEvidence` — qualitative LLM paragraph, persisted in `metadata.mechanic_evidence`. NOT scored in v1; v2 promotes to ranker if Cohen's kappa across Claude/GPT ≥ 0.6 on a 100-item taxonomy validates inter-rater reliability.
- **Brief renderer** (`src/reporting/briefs.ts`) — replaced for the Opportunity contract via `renderBrief(opportunity, opts)`. LLM-generated thesis paragraph, full provenance persisted to signal_snapshots for backtest replay (Codex Round 2 #6). dryRun mode for offline tests/scripts.
- **Pattern tags** derived post-computation: `tier2-localization`, `hot-wave`, `incumbent-toppling`. Null-safe (Codex Round 2 #5: every threshold check preceded by explicit `!= null` guard — `undefined > 7` silently evaluates false in JS).
- **`runV1Pipeline()`** in `src/orchestrator/pipeline.ts` — composes ingestion (optional AppGoblin import + 42matters bulk-extract) → 4 signals → composer → mechanic_evidence → Opportunity assembly → brief render → persist. Missing 42matters API key warns + skips (does not throw).

### Internal (NOT exported via npm)

- `src/backtest/` — backtest harness with precision@K + lift over baselines (locGap_only, velocity_only) + leakage detection. The harness NEVER calls a live LLM (reads frozen rows from signal_snapshots).
- `src/ground-truth/` — winner-score forward-looking formula, 42matters API client (gated on commercial trial), AppGoblin TSV.xz ETL (streamed decompress + transaction-batched inserts per Codex Round 2 #8), wayback-fetch (demoted to optional enrichment per Day 1 audit), llm-augment with Zod-enforced citation enforcement (no fabrication; missing URL → field stays null).
- `src/signals/` — composer + 3 new signal implementations.
- `src/opportunities/` — Opportunity Zod contract.
- `src/orchestrator/cohort-freeze.ts` — sequencing primitive for backtest leakage prevention (Codex Round 2 #9). `freezeCohort()` captures (market, t0, app_ids); `getFrozenCohortFeatures()` reads ONLY pre-t0 rows AND throws on detection of any post-t0 leakage row.
- `src/cli/` — `--internal` CLI subcommands `backtest`, `winner-score`, `opportunity` (gated from `files:` whitelist; verified by `tests/cli/internal-publish-boundary.test.ts` via `npm pack --dry-run`).
- `scripts/run-first-backtest.ts` — synthetic-cohort smoke test that proves the harness works end-to-end before the real first backtest can run.

### Changed

- `src/scoring/composite.ts` — refactored to delegate to composer (top-3 robust mean replaces the v0.7 weighted-sum heuristic). Public `CompositeOutput` shape stable (`composite`, `breakdown`, `weights`); `weights` field repurposed from multipliers to participation flags.
- `src/scoring/market-revenue-weight.ts` — addressed pre-existing Phase 1 TODO with three category presets (`subscription`, `games`, `ads`). Backwards-compatible aliases preserved (`MARKET_REVENUE_WEIGHT` → `SUBSCRIPTION_REVENUE_WEIGHT`, `DEFAULT_REVENUE_WEIGHT` → `DEFAULT_SUBSCRIPTION_WEIGHT`).
- `src/judges/vision-judge.ts` — addressed pre-existing M6 TODO with `MIN_SCREENSHOTS_FOR_CONFIDENT_VERDICT` bumped to 3 (was 2). Centralized constant; `judgeAppVision` proceeds with thin signal but `generateMechanicEvidence` refuses below the threshold (qualitative prose grounded in 1-2 frames is hallucination bait).
- `src/util/rate-limit.ts` — extended with `withCircuitBreaker(fn, threshold)`, `withExpBackoff(fn, maxAttempts)`, persisted SQLite-backed queue (Codex Round 2 #7 — process-crash-resumable). Existing per-host concurrency unchanged; M2 scrapers continue to pass.
- `packages/selection-agent/package.json` `files:` field — explicit whitelist excludes internal modules (`src/backtest/`, `src/ground-truth/`, `src/opportunities/`, `src/signals/`, `scripts/`) from the public mirror via subtree-split. Codex Round 2 #10 enforcement.

### Storage schema

- 7 new tables via migration runner: `opportunities`, `winner_scores`, `signal_snapshots`, `chart_snapshots`, `app_metadata_snapshots`, `cohort_freezes`, `rate_limit_queue` (plus the meta `schema_migrations` ledger). All v1 signals persisted with `signal_pipeline_version` + `scoring_version` for backtest reproducibility (Codex Round 2 #6). Load-bearing signal columns are typed nullable REAL (Codex Round 2 #1 — JSON blob would block indexed queries).
- All LLM calls persisted with full provenance (`llm_model` + `llm_prompt_version` + `llm_request_hash` + `llm_response_hash` + `llm_response_archived` + `source_urls_json`) so backtest replay reads frozen rows ONLY (no live LLM calls).

### Tests

- 715 tests pass (was 365 at v0.7.0). +350 tests across 22 new test files for v1 modules (composer, signals, ground-truth, backtest harness, cohort-freeze, internal CLI, integration E2E).
- Critical regression tests: M2 scrapers continue to pass after the rate-limit extension.
- Critical leakage test: `tests/orchestrator/cohort-freeze.test.ts` — `getFrozenCohortFeatures` throws when a post-t0 signal_snapshots row exists for a frozen app.
- Critical citation rejection: `tests/ground-truth/llm-augment.test.ts` — Zod rejects LLM responses missing URL → field stays null (no fabrication).
- Integration E2E: `tests/integration/full-pipeline.test.ts` (4) + `tests/integration/backtest-e2e.test.ts` (4) — full v1 flow on synthetic fixtures.

### Strategic notes

- Hybrid C path locked: apps-first stays primary; v1 agent rewrite ships in parallel as prototype (per `docs/planning/agent-v1-foundation.md`).
- Day 1 audit: OSF + Wayback unviable for tier-2 SEA historical metadata. Pivoted to 42matters 14-day commercial trial + AppGoblin chart-rank time series.
- Decision point at week 3-4: 2 apps' real ROAS vs v1 backtest precision determines apps-first vs agent-first SaaS pivot.
- 7 codex Round 1 critiques deferred to v2 (mechanic_novelty taxonomy, missing analyst signals, hard gates, statistical rigor of decision gate, SaaS-specific kill criteria, SEA vs global strategic inconsistency, mechanic_evidence promotion). All 10 codex Round 2 critiques incorporated.

### Real first backtest gating

This release does NOT include the first real backtest report. The synthetic backtest (`scripts/run-first-backtest.ts` → `docs/planning/agent-v1-synthetic-backtest-results.md`) proves the harness works end-to-end. The REAL first backtest gates on user signing up for the 42matters 14-day trial; full prerequisite checklist in `docs/planning/agent-v1-real-backtest-checklist.md`.

## [0.7.1] - 2026-04-30

CLI first-impression polish: branded banner now greets every user the moment they invoke the CLI, and the missing-API-key error is finally a copy-pasteable recipe instead of a broken hint.

### Fixed

- **Missing-API-key error message** previously told users to type `Export ANTHROPIC_API_KEY=...` (capital E), which bash and zsh both reject with `command not found: Export`. Lowered to `export` and rewritten as a numbered, copy-pasteable recipe with a link to the Anthropic console, the full re-run command, and a pointer to `demo` for users without a key.

### Changed

- **Branded ASCII banner** is now printed once per CLI invocation — including the no-arg help screen and `--help` — instead of only `demo` and `scan`. The very first thing a `npx @apps-machine/selection-agent` user sees is the brand. JSON output (`--format json`) still skips the banner so machine consumers get pure JSON.
- `AgentError.fix` accepts `string | string[]`. Array form renders one indented line per step under the `fix:` header, enabling multi-step user guidance instead of cramming a recipe into a single sentence.

## [0.7.0] - 2026-04-30

Default scan markets pivoted to the tier-2 SEA cluster + Bangladesh, where the localization-gap thesis is empirically alive.

### Changed

- **Default markets** for `runScan` and the `selection-agent scan` CLI flipped from the original tier-1 list `[us, jp, de, fr, br, es]` to `[bd, th, vn, my, id]`. CLI consumers running `selection-agent scan --no-llm` (no `--markets` flag) now get a meaningfully different ranked output. Existing callers passing `markets: [...]` explicitly are unaffected.
- **`PHASE_0_MARKETS`** export deprecated and re-aliased to the new `DEFAULT_MARKETS`. Existing v0.6.x consumers continue to work; the rename is a soft transition.

### Added

- **`DEFAULT_MARKETS`** export from `src/orchestrator/pipeline.ts` — the canonical tier-2 cluster list. JSDoc on the constant documents the M7.5 empirical finding that drove the change.

### Why

M7.5's LLM-judged scans (2026-04-30, $0.56 total Anthropic spend across 40 candidates) found the locGap thesis is **dead in tier-1 markets** and **alive in tier-2**:

| Market | locGap≥6 hits | Avg locGap | Verdict |
|---|---|---|---|
| BD Bangladesh | 5/5 | 7.7/10 | strongest |
| TH Thailand | 4/4 | 7.0/10 | strong |
| VN Vietnam | 5/5 | 6.8/10 | alive |
| MY Malaysia | 5/5 | 6.2/10 | alive |
| ID Indonesia | 4/5 | 5.8/10 | alive |
| PH Philippines | 0/4 | 4.5/10 | weak (English is co-official) |
| BR Brazil | 0/5 | 1.0/10 | dead (Google/OpenAI ship native PT) |
| MX Mexico | 0/5 | 1.4/10 | dead (Google/OpenAI ship native ES) |

Top-grossing apps in tier-1 ship localized to those markets natively; tier-2 markets get default-English ports indefinitely. That's where the loc-gap arbitrage actually exists in 2026.

PH was deliberately excluded from the default list (English is co-official, weakening the gap). Callers can still pass `--markets ph` explicitly when comparing.

Full empirical write-up: `docs/planning/m7.5-thesis-validation.md`. CEO plan recording the decision: `~/.gstack/projects/apps-machine-studio/ceo-plans/2026-04-30-thesis-validation.md`.

### Notes

- The locGap heuristic itself still has known bugs (Cyrillic-character brittleness + Google `summary` field bias) that produce false positives in `--no-llm` mode. The LLM judges (text + vision) are the source of truth for ranking. Heuristic fix tracked as TODO-E in `TODOS.md`.

## [0.6.1] - 2026-04-30

Polish patch — branded ASCII banner + version sync.

### Added

- **Branded ASCII banner** at the top of every markdown CLI output (`demo` + `scan`). Compact "AM" monogram + version + tagline + repo URL. Renders cleanly in terminals AND in markdown viewers (wrapped in a code fence). JSON output (`--format json`) skips the banner so machine consumers still get pure JSON.
- **`renderBanner()` + `VERSION`** exported from new `src/cli/banner.ts`. Single source of truth: pulls version from `package.json` so a future bump flows everywhere automatically.

### Fixed

- **citty `meta.version`** was hardcoded `"0.0.1"` since pre-M1; now reads from `VERSION` constant (resolved from `package.json`). `selection-agent --version` now reports the correct version.

## [0.6.0] - 2026-04-30

M7 — enrichment + smoke gate + eval drift gate + npm publish. Closes Phase 0.

### The unblock

M6 wired the orchestrator end-to-end, but smoke-testing against real APIs found that scan returned composite **0.00/10 for every real-world candidate** — chart entries lack `ratingsCount` and `description`, so the heuristic scorers (revenue + locGap + paywall) computed zero across the board. M7 adds an app-detail enrichment pass between the chart scrape and the snapshot write, plus the missing process gates (live smoke, eval drift, npm publish) so the next bug found by an external user isn't another silent regression.

### Added

- **App-detail enrichment in `runScan`** — `src/orchestrator/enrich.ts` exports `mergeEnrichments(charts, outcomes, failures)` which joins chart entries with their per-app detail records keyed by `(store, appId, market)`. The pipeline calls `scrapeApps` (the existing M2 orchestrator with concurrency 8 + 3-tier resilience + cache) between `scrapeCharts` and `writeSnapshot`. Failed enrichments fall back to the chart entry — single-app failures don't kill the run.
- **`--enrich` CLI flag** (default `true`) — `selection-agent scan --no-enrich` for a cheap chart-only sweep when you don't need real composite scores. Declared as `enrich: { type: 'boolean', default: true }` per the citty `--no-X` convention pinned by PR #14's regression.
- **Shared `RateLimiter` in `runScan`** — one token bucket (capacity 8, refill 4/sec) shared between `scrapeCharts` (concurrency=6) and `scrapeApps` (concurrency=8). Without this, charts(6) + apps(8) = 14 concurrent calls per host trip Akamai/Google rate limits.
- **`enrichmentFailedCount` + `enrichmentSkipped` on `ScanResult`** — additive fields, not breaking. The brief renders `**Enrichment**: X/Y enriched (Z chart-only fallback)` (or `skipped (--no-enrich)`) in the header and tags each fallback candidate `_(chart-only)_` so the founder knows which scores to distrust.
- **`enrichmentSource` on `ScoredCandidate` / `RankedCandidate`** — `"enriched"` / `"chart-only"` / `"skipped"`. Powers the per-app brief tag.
- **`trackId: string | null` on `RawAppDataSchema`** — Apple App Store URLs require the numeric track id (`/id544007664`), not the bundle ID (`com.google.ios.youtube`). Pre-M7 we stored only the bundle ID and every Apple link 404'd. Apple scraper now extracts trackId from `o.trackId ?? o.id`. Field defaults to `null` so M5/M6 snapshot rows back-compat cleanly.
- **`appStoreLink(app: RawAppData)`** — refactored to take the full `RawAppData`. Apple uses `trackId` when present, falls back to `appId`. Google unchanged.
- **`coerceIsoDate(input)` in `mapToRawAppData`** — first M7 smoke run caught that google-play-scraper returns `released` as a human-readable string (`"Apr 21, 2014"`) which `RawAppDataSchema` rejected, silently killing every Google snapshot write. The new helper coerces to ISO 8601 Z-form via `Date.parse`, returns `null` on failure.
- **`scripts/smoke.ts` + `bun run smoke`** — live smoke test that hits the real `app-store-scraper` and `google-play-scraper` libs with the smallest possible workload (top 1, market US, both stores, --no-llm). Asserts wall-time < 30s, ≥1 candidate, snapshot persisted, composite > 0 (the unblock check), and well-formed app-store URLs.
- **`evals/drift-gate.ts`** — internal-only `assertDriftWithinTolerance` and `assertPassesUnchanged` pure helpers. Each `evals/*.eval.ts` suite now uses these instead of inline drift logic, and the unit tests in `tests/evals/drift-gate.test.ts` lock the policy without spending Anthropic tokens.
- **`bun run evals:check`** — `EVALS=1 bun test ./evals/*.eval.ts`. Runs the full eval suite against committed baselines and fails the workflow on any case drifting more than ±1.0 (10%) or flipping its `passes` flag.

### Changed

- **`src/orchestrator/pipeline.ts`** — pipeline now constructs `RateLimiter`, runs `scrapeApps` (when `enrich: true`), merges via `mergeEnrichments`, and pins `snapshotDay` + `getVelocityScore({ asOf })` to the orchestrator's clock so tests with a fixed `now` get deterministic snapshot rows. Pre-M7 the snapshot day defaulted to wall-clock `todayUtc()`, which made `pipeline.velocity-with-baseline.test.ts` flaky around UTC midnight.
- **`evals/text-judge.eval.ts` + `evals/lang-quality.eval.ts`** — drift checks now go through `assertDriftWithinTolerance` + `assertPassesUnchanged`. Tolerance pulled into a single `SCORE_TOLERANCE = 1.0` constant per file. Behavior unchanged — same ±10% bar, same per-case failures.

### Tests

- 365 tests pass (was 320). 45 new tests across enrichment unit + integration, Apple link regression, schema back-compat, Google date coercion, and drift-gate logic. Detailed list:
  - `tests/orchestrator/enrich.test.ts` (8) — happy / partial / total-fail / empty / appId-mismatch / rank preservation.
  - `tests/orchestrator/pipeline.enrichment.test.ts` (2) — composite > 0 with enriched data; **regression**: writeSnapshot persists enriched rows, not chart fallbacks.
  - `tests/orchestrator/pipeline.enrichment-failure.test.ts` (2) — 1/3 enrichments fail → 3 candidates returned, count=1, partial-fallback brief.
  - `tests/orchestrator/pipeline.no-enrich.test.ts` (2) — short-circuit: scrapeApps never called, default still runs enrichment.
  - `tests/cli.test.ts` (1) — subprocess `--no-enrich` wires through to JSON output (citty footgun guard).
  - `tests/reporting/briefs.applelinks.test.ts` (5) — Apple trackId → numeric URL; missing trackId → bundle-ID fallback; Google unchanged.
  - `tests/reporting/briefs.golden.test.ts` (2) — re-pinned snapshot includes header + per-app tag; new tests for skipped + fully-enriched copy.
  - `tests/scrapers/raw-app-data-schema.test.ts` (8) — trackId accepts string/null/missing/non-string-non-null; `mapToRawAppData` coerces Google human dates to ISO; ISO with offset passes through; unparseable → null.
  - `tests/scrapers/apple-store-client.test.ts` (3) — chart + per-app endpoints surface trackId; `mapToRawAppData` propagates it.
  - `tests/evals/drift-gate.test.ts` (13) — within / outside tolerance; symmetric drift; default tolerance; passes flip.

### Distribution

- **First-time npm publish.** Triggered by tag push `selection-agent/v0.6.0`. Workflow gates publish on `bun run check` (typecheck + lint + knip + tests) AND `bun run smoke` (live upstream).
- Requires `NPM_TOKEN` secret on the monorepo.
- npm publish via `npm publish --access public --provenance` (NOT `bun publish`).

### Notes

- `vision-judge.eval.ts` is structurally a TODO until the founder drops curated screenshot fixtures + runs `WRITE_BASELINE=1 bun run evals` once. The drift gate will fail loud when vision is activated without a baseline.
- Live verification snippet for the PR body: `bun src/cli/index.ts scan --no-llm --top 5 --markets us --stores apple --format markdown` should produce composite > 0 for ≥3 candidates, with every Apple App Store link using the numeric trackId form.

### M7.5 thesis validation (2026-04-30, $0.21 spend)

A diagnostic gate ran before this ship to test whether the locGap thesis is alive in 2026. Findings (full doc in `docs/planning/m7.5-thesis-validation.md`):

- **Tier-1 markets (BR, MX, JP, DE, FR…) — thesis dead.** Top-5 Apple grossing in BR + MX scored locGap≤2 across the board (avg 1.0/10 BR, 1.4/10 MX). Global apps localize natively to tier-1.
- **Tier-2 markets (ID, VN, TH, PH, MY…) — thesis alive.** Indonesia top-5 Apple grossing scored locGap=6-7 on 4 of 5 candidates (avg 5.8/10). ChatGPT, YouTube, and eFootball all ship default-English in Indonesia despite 270M-user market. The Rocket Internet 2015-2018 pattern still applies in the tier-2 SEA cluster.
- **Implementation bug surfaced.** The heuristic locGap scorer is brittle (a single Cyrillic character flips detection) and reads Google's `summary` instead of full `description`. v0.7.0 will fix both. v0.6.0 ships with this known limitation; LLM judges are the source of truth.

Phase 1 default markets will pivot from `[us,jp,de,fr,br,es]` to a subset of `[id,vn,th,my,ph]` in v0.7.0 based on a follow-up tier-2 scan.

## [0.5.1] - 2026-04-29

M6 smoke-test fallout. Three bugs surfaced when running `selection-agent scan --no-llm --markets us --stores apple` against real Apple data — none of them were caught by M6's unit tests (all unit tests use injected fakes that don't replicate the upstream lib's runtime quirks). Track B was silently dead in production until this release.

### Fixed

- **CLI `--no-llm` flag was silently ignored.** citty's `--no-X` convention sets `args.X = false` (NOT `args["no-X"] = true`). The CLI declared `"no-llm"` and read `args["no-llm"]`, which always evaluated to its default (`false`), so `--no-llm` had no effect and the pre-flight always demanded `ANTHROPIC_API_KEY`. Renamed the flag declaration to `llm: { default: true }` so passing `--no-llm` cleanly flips it. Two regression tests in `tests/cli.test.ts` invoke the CLI as a subprocess and assert (a) `--no-llm` does NOT trigger MISSING_API_KEY, (b) omitting both env var and `--no-llm` still rejects via pre-flight.
- **Apple chart scraper threw `Invalid collection TOP_GROSSING_IOS` against the real lib.** `app-store-scraper`'s `list({collection})` validates against its own enum *values* (e.g., `"topgrossingapplications"`), not the key strings (`"TOP_GROSSING_IOS"`). M2 passed the key string verbatim, which the lib rejects. Now we look up the value on `lib.collection[key]` so we tolerate any value-string drift between releases. Existing `apple-store-client.test.ts` assertion updated to match the value-passing semantics.
- **`releaseDate` Zod validation rejected real Apple chart data, silently killing every snapshot write.** Apple's chart `list()` returns timestamps with timezone offsets (`"2023-05-18T00:00:00-07:00"`), but `RawAppDataSchema` used `z.string().datetime()` which rejects offsets. M5's `writeSnapshot` re-parsed each payload through `SnapshotPayloadSchema` (which references `RawAppDataSchema`), so every real chart entry threw — Track B accumulated zero rows in production. Switched both `releaseDate` and `lastUpdated` to `z.string().datetime({ offset: true })`. New `tests/scrapers/raw-app-data-schema.test.ts` pins both formats.

### Notes

- 320 tests pass (was 314); 6 new regression tests added across the three fixes.
- Pre-existing limitations not addressed in this PATCH: chart entries lack `ratingsCount` / `description`, so heuristic scorers compute composite 0/10 for every real-world candidate. M7 scope (separate `scrapeApps` enrichment pass). Apple App Store links use bundle ID instead of numeric `trackId` — also M7 polish.

## [0.5.0] - 2026-04-29

M6 — orchestrator + reporting. `selection-agent scan` now produces the live ranked output the founder consumes; `selection-agent report --compare-judges` surfaces text vs. vision divergence across persisted judge runs.

### Added

- **`src/orchestrator/pipeline.ts`** — `runScan({ cache, scrapers, textClient, visionClient, fetchImage, ... })`. Composes scrape → snapshot → judge → score → rank in one call. The chart-scraper layer's `mapWithConcurrency` keeps one blocked `(store × market)` slice from killing the run; failed slices land in `result.failedSlices`. The M5 `writeSnapshot` side-effect runs before judges, so Track B keeps accumulating during an LLM outage. Each judge call is double-written: cached via the M4 content-addressed `withJudgeCache` (cache hit/miss path) and persisted to the new `judge_result` table (queryable per run).
- **`src/orchestrator/types.ts`** — `ScanInput`, `ScanResult`, `ScoredCandidate`, `RankedCandidate`, `FailedSlice`. Pipeline boundary types kept separate from the orchestrator implementation so reporting modules can import without pulling in the whole pipeline graph.
- **`src/reporting/ranker.ts`** — `rank(candidates, topN)`. Deterministic 4-level sort: composite desc → mean(judge confidence) desc → ratingsCount desc → `(store|appId|market)` ascending. Same input always produces the same order; missing judges count as confidence 0 so fully-judged candidates beat partially-judged ones at the same composite.
- **`src/reporting/briefs.ts`** — `generateBrief(scanResult)`. Markdown founder brief with per-app sections (loc gap, cultural fit, revenue, paywall, velocity, confidence, store link) plus a "failed slices" footer. Pinned via golden snapshot.
- **`src/reporting/compare-judges.ts`** — `compareJudges(judgeResults)` and `renderJudgeDivergenceMarkdown(report)`. Pairs text + vision results for the same `(store, appId, market)`, sorts by `|locGapScore − culturalFitScore|` desc, and renders a side-by-side reasoning table.
- **`src/storage/judge-result-store.ts`** — `JudgeResultStore` (insert + `selectByRunId` + `latestRunId`). Mirrors the M5 `SnapshotStore` pattern (single SQLite connection via `Cache`, payload validated through `JudgeResultSchema` on read so a corrupt row never crashes a report).
- **`src/storage/schema.ts`** — `JUDGE_RESULT_SCHEMA` table with `UNIQUE(run_id, store, app_id, market, kind)` and indexes on `run_id` and `(store, app_id, market, kind)`.
- **CLI `selection-agent scan`** — replaces the M6-stub `NOT_IMPLEMENTED` error. Flags: `--top` (default 30), `--markets` (default 6 Phase 0 markets), `--stores` (default `apple,google`), `--format` (`markdown` | `json`), `--no-llm` (heuristics only), `--db`, `--budget`. Pre-flight checks `ANTHROPIC_API_KEY` unless `--no-llm`; pre-flight validates `--top`, `--format`, `--budget`, `--stores` shape.
- **CLI `selection-agent report --compare-judges`** — replaces the stub. Flags: `--run-id` (default: most recent), `--db`. Loads judge rows from `judge_result`, renders the divergence markdown.

### Tests

- **`tests/orchestrator/`** — 7 pipeline tests across 6 files: happy path, Apple-blocked + all-blocked, no-llm, budget-breach (cap forces fail-fast on third judge call), snapshot-on-judge-fail (Track B keeps accumulating), velocity-with-baseline (`seedSnapshotHistory` from M5 → composite uses `WEIGHTS_WITH_VELOCITY`).
- **`tests/reporting/ranker.test.ts`** — every tie-break level pinned; idempotent on shuffled input.
- **`tests/reporting/briefs.golden.test.ts`** — golden snapshot of the canonical fixture; structural assertions for required headers + per-app fields; empty-candidates fallback.
- **`tests/reporting/compare-judges.test.ts`** — pairing logic, divergence ordering, unpaired-result accounting, empty-input handling, markdown shape.
- **`tests/storage/judge-result.test.ts`** — insert, UNIQUE conflict, `selectByRunId`, `latestRunId`, corrupt-payload-skip.

### Changed

- `src/storage/cache.ts` — `Cache` exposes `judgeResultStore()` (mirrors `snapshotStore()`) and a `rawDb()` test escape hatch. `JUDGE_RESULT_SCHEMA` is appended to `ALL_SCHEMAS` so the table auto-creates on `Cache.open`.
- `knip.json` — removed `src/reporting/**` and `src/orchestrator/**` from the selection-agent ignore list now that they have real implementations + tests.

### Notes

- Judge cache (content-addressed) and `judge_result` table (run-scoped) coexist intentionally. The cache answers "have we computed this exact prompt before"; the table answers "what did judges produce in run X". Two writes per judge call is cheap and avoids forcing every report query through a join on content digest. Cross-store dedup is a feature: scraping the same app on apple+google produces one judge call (same content), which is correct — a candidate's `judge_result` row count = unique `(appId, market) × kinds` per run, not `candidates × kinds`.
- Pipeline does not run a separate `scrapeApps` enrichment pass — chart entries already produce `RawAppData` via `mapToRawAppData()`. M7+ will add a per-app detail enrichment hop when richer descriptions are needed.

## [0.4.0] - 2026-04-29

M5 — velocity scaffolding. Track B (first-mover detection) starts accumulating snapshots immediately and produces a usable score from J14 onward. Until then, `getVelocityScore` returns `null` and the composite scorer flips to `WEIGHTS_NO_VELOCITY` (already wired since M3).

### Added

- **`src/velocity/snapshot.ts`** — `writeSnapshot({ apps, cache, snapshotDay?, rankByKey?, now? })` real implementation. Validates each payload via `SnapshotPayloadSchema` before insert (a malformed `RawAppData` raises before SQLite ever sees it). Uses `INSERT … ON CONFLICT DO NOTHING` against the `app_snapshot` UNIQUE `(store, app_id, market, snapshot_day)` constraint and reports `{ written, skipped, day }`. UTC `YYYY-MM-DD` snapshot day so cron rollover is timezone-stable.
- **`src/velocity/delta.ts`** — `getVelocityScore({ store, appId, market, cache, asOf?, baselineDays? })` real implementation. Delta-based, computed on the fly — no materialised table. Reads `[asOf - baselineDays + 1, asOf]` rows for the app, runs each through `SnapshotPayloadSchema.safeParse`, and pino-`debug`s any corrupt row before discarding it (the critical observability gap — without this, a single bad row would silently mask the velocity signal). Returns `null` when valid rows < `baselineDays`, otherwise `0.6 * rankScore + 0.4 * ratingsScore` clamped 0-10. `baselineDays` defaults to 14 (J14 activation).
- **`src/velocity/run-snapshot.ts`** — orchestrator behind the new CLI subcommand. Scrapes `top-grossing` for the 6 Phase 0 markets (US, JP, DE, FR, BR, ES) on both stores in one pass, builds `rankByKey` from chart-scraper rank, calls `writeSnapshot`, and reports failed market jobs without aborting the rest. Cron-friendly: scrape-only, no LLM judges.
- **`src/storage/queries.ts`** — `SnapshotStore` class wrapping the same SQLite connection as `Cache`. Exposed via `cache.snapshotStore()` so the velocity layer never opens a second connection (would defeat WAL coordination and double the schema-apply cost). Just two methods: `insertSnapshot` (returns `true` if inserted, `false` if conflict-ignored) and `selectSnapshotRange` (single-app range read, ordered ASC).
- **CLI `selection-agent snapshot`** — replaces the M5-stub `NOT_IMPLEMENTED` error. New flags: `--limit` (apps per market+store, default 100) and `--db` (SQLite path, defaults to `$SELECTION_AGENT_DB` or `./.cache/selection-agent.sqlite`). Prints `Snapshot written for {day}: {written} new, {skipped} already present.` and exits 0 on success. Failed chart jobs are reported on stderr but don't fail the run (other markets still write).
- **`tests/velocity/fixtures.ts`** — `seedSnapshotHistory` test helper. Linearly interpolates `rankOfDay` from `startRank` (oldest) to `endRank` (most recent) across `days` consecutive UTC days; ratings climb by `ratingsPerDay`. Used by both M5 tests and (forward) M6 pipeline tests so the snapshot history fixture is one source of truth across the freeze line.

### Changed

- `src/storage/cache.ts` — `Cache` now exposes `snapshotStore()` returning a `SnapshotStore` bound to its underlying connection. Internal change; existing `Cache` API is unchanged.

### Tests

- **`tests/velocity/snapshot.test.ts`** — empty-cache writes, idempotency on re-write, `snapshotDay` override, default-day shape (`YYYY-MM-DD` UTC), Zod-rejection of malformed `RawAppData`, missing/present `rankByKey` mapping into `rankOfDay`, partial-conflict accounting.
- **`tests/velocity/delta.test.ts`** — history < baseline → null; monotonic climb → > 5; flat history → 0 (defined, not null); rank-drop clamps to 0; corrupt JSON drops below baseline → null; corrupt row at unrelated `appId` doesn't bleed; custom `baselineDays`; `asOf` time-pinning; gap (delisted) → null; rank-only signal (ratings null) still computes; `baselineDays <= 0` throws.
- **`tests/velocity/fixtures.test.ts`** — sanity check that `seedSnapshotHistory` produces the rows it claims (consecutive UTC days, linear rank interpolation, ratings climb, null-preservation, multi-app independence).
- **`tests/velocity/run-snapshot.test.ts`** — CLI smoke. Mocked clients across `markets × stores` produce the expected row count, idempotent re-runs, `rankOfDay` populated from chart-scraper rank, failing client surfaces as a `failedMarkets` entry without aborting.

### Notes

- No schema migration. `app_snapshot` table already exists from M2 era; M5 standardises the `payload` JSON shape via `SnapshotPayloadSchema` and writes the first real rows.
- `src/velocity/**` and `src/storage/queries.ts` removed from the `knip.json` ignore list now that they have real implementations + tests.
- Contract details (M5/M6 ownership matrix, conflict points, edge-case handling) live at `.context/m5-m6-contract.md`.

## [0.3.0] - 2026-04-29

M4 — LLM judges + lang quality eval. Selection Agent can now grade the localization gap and cultural fit of a candidate app via Claude, and self-eval its own translation quality before recommending a market.

### Added

- **`src/judges/schemas.ts`** — Zod schemas for `TextJudgeResult`, `VisionJudgeResult` (discriminated union via `kind`), and `LangQualityResult`. `passes` flag is refined to require `semanticEquivalenceScore >= 8.0`. Shared `Reasoning` type capped at 600 chars to bound prompt-injection blast radius from app descriptions.
- **`src/judges/text-judge.ts`** — `judgeAppText({ app, client })` scores localization gap (0-10) via Anthropic SDK tool-use forced to `score_localization_gap`. Default model `claude-sonnet-4-6`. Returns `Result<TextJudgeResult, Error>` so the orchestrator can score candidates partially when one judge fails.
- **`src/judges/vision-judge.ts`** — `judgeAppVision({ app, client, fetchImage })` scores cultural fit on screenshots via the same Sonnet 4.6 multi-modal endpoint. Caps at 5 screenshots, 5 MB per image, 10 s per fetch (AbortSignal). Tolerates partial-fetch failure: continues with whatever was retrieved and records the actual count in `screenshotsAnalyzed`.
- **`src/judges/lang-quality-eval.ts`** — `evaluateLanguageQuality({ language, market, phrases, client })` runs a 3-call self-eval per language: forward translation EN → target, literal back-translation target → EN, and Claude-as-judge semantic equivalence scoring per phrase. Mean score gates `passes` at the 8.0 threshold.
- **`src/judges/cache.ts`** — 30-day SQLite cache (reuses the M2 `scrape_cache` table) for judge calls. SHA256-hashed key over `(JUDGE_SCHEMA_VERSION, kind, model, appId, market, contentDigest)`. `withJudgeCache(...)` wrapper for orchestrator-level integration; judges stay pure so eval suites bypass the cache cleanly. Bumping `JUDGE_SCHEMA_VERSION` invalidates all old entries.
- **`src/judges/budget.ts`** — `CostBudget` cost tracker with founder-set $20/scan default cap. Pricing table for Sonnet 4.6 ($3 / $15 per MTok), Opus 4.7 ($15 / $75), Haiku 4.5 ($0.80 / $4). `recordAndAssert(usage)` plumbs as the `onTokenUsage` callback for fail-fast on cap breach.
- **`evals/text-judge.eval.ts`** — 10 eval cases drawn from real apps (Cal AI BR, PictureThis JP, Remini DE) and synthetic patterns (English-only on FR top chart, machine-translated PT paywall, no-PIX BR finance app, etc.). Asserts `locGapScore` within case-defined ranges; baseline drift gate at 10%.
- **`evals/vision-judge.eval.ts`** — structurally wired; activation pending screenshot binaries dropped under `fixtures/screenshots/{case-id}/`.
- **`evals/lang-quality.eval.ts`** — runs the 50-phrase back-translation eval against the 6 founder-confirmed Phase 0 markets (US/JP/DE/FR/BR/ES). The `en/us` baseline must score >= 9.0.
- **`evals/fixtures/lang-corpus.json`** — 50 EN phrases drawn from real mobile-app paywall, onboarding, ASO, and notification copy patterns (founder-confirmed corpus type B over Tatoeba). Covers paywall CTAs, sign-in flows, demographic onboarding, social proof, notification copy, ASO keywords, pricing/billing, restore + share flows.
- **`evals/fixtures/lang-targets.json`** — Phase 0 markets pinned: US (en baseline), JP (ja), DE (de), FR (fr), BR (pt-BR), ES (es). pt-BR over generic pt; es-ES over es-MX (LATAM enters Phase 1).

### Changed

- All eval suites are gated by `EVALS=1 ANTHROPIC_API_KEY=...`; baselines live in `evals/baselines/` and are regenerated with `WRITE_BASELINE=1`. CI does not auto-run them.

### Security

- Adversarial review surfaced two P0 risks in vision-judge that are now closed before any release: missing fetch timeout (resource leak / hang) and missing base64 size cap (cost runaway from a single 10 MB+ App Store screenshot). Four P1 hardenings landed alongside: inline budget enforcement via `recordAndAssert`, schema version in cache key (prevents stale-blob deserialization mismatch on future schema bumps), `reasoning` length cap in both JSON Schema (`minLength: 1`, `maxLength: 600`) and Zod (closes the drift where an empty-string reasoning would pass the API but throw post-call), and prompt-injection blast-radius cap on the same field.

## [0.2.1] - 2026-04-29

### Changed
- **Recalibrated per-market revenue weights** based on adversarial review by an
  independent model (Codex GPT-5) with sourced 2025 data. The previous table was
  blended across categories (games + utility + sub apps) which over-promoted
  Brazil and India and under-valued Japan and the US for the subscription-clone
  niche. New ratios:
  - US/BR: 7.8x → **22x** (Brazil over-promoted by ~3x previously)
  - US/IN: 11.7x → **69x** (India over-promoted by ~6x previously)
  - JP: 3.2 → 3.5 (was undervalued; could be higher for games but kept conservative for sub apps)
  - US: 3.5 → 5.5 (was undervalued vs Appfigures 2025 ~$5.55/install)
- **Renamed** `ARPU_BY_MARKET` to `MARKET_REVENUE_WEIGHT`, `arpuForMarket()` to
  `marketRevenueWeight()`, and the file `arpu-by-market.ts` to
  `market-revenue-weight.ts`. The values are not strictly ARPU — they are
  category-weighted multipliers for a subscription/utility-clone preset.
- Documented sources inline (Sensor Tower 2023-2024, Business of Apps 2023-2025,
  Appfigures 2025, RevenueCat 2025 State of Subscription Apps, Apple MSCA Japan
  changes Dec 2025) and flagged Phase 1 TODO to split into category presets
  (subscription / games / ads).

## [0.2.0] - 2026-04-29

### Added
- **Heuristic scoring suite (M3)** — Track A scorers that map raw app data
  to opportunity signals on a 0-10 scale.
  - `scoreRevenue` — log-scaled signal from rating x ratingsCount x ARPU.
    Per-market ARPU lives in a swappable `arpu-by-market.ts` config so the
    founder can validate or drop regional weighting without touching the scorer.
  - `scorePaywallComplexity` — text-mining the description for subscription /
    trial / lifetime / multi-tier signals. Higher complexity = stronger
    opportunity signal (incumbent invested in monetization, harder to clone).
  - `scoreLocalizationGap` — detects description language via script regex
    plus Latin-script stop-word counting (covers Polish, Czech, Romanian,
    Hungarian, Turkish via Unicode property tokenization), compares to expected
    market language. Multi-language markets (CH, BE, LU, IN, SG, HK) return
    neutral instead of false-positive gap signals.
  - `scoreComposite` — weighted combine. Weights are 0.4 / 0.4 / 0.2
    (loc-gap / revenue / paywall) when velocity is null. When M5 lands
    velocity, weights shift to 0.3 / 0.3 / 0.15 / 0.25.
- **Token-bucket rate limiter** (`util/rate-limit.ts`) — per-host bucket
  shared across chart + app + review scrapers. Closes the M2 gap where
  charts(c=6) + apps(c=8) = 14 concurrent calls to the same host risked
  Akamai/Google rate-limit trips. Default off; pipeline (M6) will instantiate
  one limiter and pass it to all scrapers.
- **Playwright Apple fallback** (`scrapers/playwright-fallback.ts`) —
  drives headless Chromium against `apps.apple.com` when the primary
  `app-store-scraper` lib trips Akamai bot detection. Lazy-loaded
  (`playwright` is only imported when invoked) so installs that never use
  it skip the chromium download. Iterates every JSON-LD block on the page
  to find `MobileApplication` (Apple emits multiple). Slug regex `[^/]+`
  handles accented and non-Latin app slugs. Clear install hint when chromium
  binary is missing.

### Fixed
- Revenue scorer now guards against `NaN` and `Infinity` rating /
  ratingsCount inputs so a single corrupt scrape cannot poison the entire
  ranking pipeline.
- Localization-gap detection requires a strict best-vs-runner-up margin to
  claim a language; tied counts return null instead of biasing toward
  whichever language enumerated first.

## [0.1.0] - 2026-04-29

### Added
- **Dual-store scrapers** (Apple App Store + Google Play) via dependency-injectable
  client wrappers. Apple maps `top-grossing` → `TOP_GROSSING_IOS`, Google maps to
  `GROSSING`. Both lowercase ISO market codes and normalize raw entries to
  `RawAppData` shape via shared `mapToRawAppData()`.
- **3-tier resilience wrapper** (`resilient<T>`): cache fresh → primary lib →
  optional fallback → cache stale. Keeps the pipeline alive when Apple's CDN
  blocks (Akamai 429) by serving last-known-good data with `staleAgeMs`
  reported to callers. Optional `maxStaleMs` cap rejects ancient entries.
- **SQLite WAL cache** (`Cache` class): `put` / `get` / `getEntry` / `getStale` /
  `prune` / `delete` / `size` / `close`. Optional Zod schema validation on read
  with auto-delete of stale-format payloads. Auto-creates parent directories.
  Pre-flight `assertDiskSpace` (default 500 MB minimum).
- **Cache key encoder** (`buildCacheKey`): percent-encodes user-provided segments
  so a malicious or weird `appId` cannot collide with other cache namespaces.
- **High-level orchestrators** with bounded concurrency:
  - `scrapeCharts(jobs, opts)` — fans charts across markets/stores/collections
    (default 6 parallel jobs).
  - `scrapeApps(jobs, opts)` — enriches chart entries with full details
    (default 8 parallel jobs).
  - `scrapeReviewPage(...)` — paginated review fetch with normalization.
- **Retry primitives**: `retryWithBackoff` (exponential, full jitter),
  `isTransientHttpError` (429 / 503 / 5xx + ECONNRESET / ETIMEDOUT /
  ENOTFOUND / ECONNREFUSED / socket-hang-up / undici UND_ERR_*),
  `isFatalHttpError` (401 / 403 / 404 / 410 / 451) — short-circuits retries
  on permanent failures.
- **Concurrency utility**: `mapWithConcurrency<I,O>` — bounded-parallel async
  map that captures per-input successes and failures separately.
- **Tests**: 96 unit tests across 13 files (foundations, storage, util,
  scrapers). Realistic JSON fixtures from Apple + Google scraper output.

### Changed
- TypeScript strict + `noUncheckedIndexedAccess` enforced across all new modules.
- `@anthropic-ai/sdk` pinned to `~0.30.0` (was `^0.30.0`) — 0.x SDKs break across
  minors.

### Deferred
- Playwright fallback tier (M3) — `resilient()` already accepts a fallback
  `ScraperLib`; M3 plugs in the Playwright implementation when Apple Akamai
  detects the lib client.
- Live integration tests (M6 demo dataset refresh).
- Global rate limiter across all scrapers (M3 orchestrator).
- npm publish strategy — Bun-only consumption today; M7 ships `dist/` for
  Node consumers.

## [0.0.1] - 2026-04-28

### Added
- Initial scaffolding (M1): citty CLI with working `demo` subcommand reading
  a frozen snapshot dataset (`~30s magical moment, zero config`), Stripe-tier
  error formatter (emoji + cause + fix + docs), `src/` module tree per
  `ARCHITECTURE.md` with placeholders for M2-M7, bun:test scaffolding,
  `.githooks/pre-commit` (gitleaks via direct binary install in CI),
  GitHub Actions workflow with `concurrency` group + least-privilege
  `permissions` + pinned `bun-version: 1.3.x`, `.env.example` documenting
  `ANTHROPIC_API_KEY` and model overrides.

[0.5.1]: https://github.com/apps-machine/selection-agent/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/apps-machine/selection-agent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/apps-machine/selection-agent/compare/v0.3.0...v0.4.0
[0.1.0]: https://github.com/apps-machine/selection-agent/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/apps-machine/selection-agent/releases/tag/v0.0.1
