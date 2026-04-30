# Changelog

All notable changes to `@apps-machine/selection-agent` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
