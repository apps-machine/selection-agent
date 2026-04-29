# Changelog

All notable changes to `@apps-machine/selection-agent` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/apps-machine/selection-agent/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/apps-machine/selection-agent/releases/tag/v0.0.1
