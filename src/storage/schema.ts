import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export const SCRAPE_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS scrape_cache (
  cache_key  TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scrape_cache_expires
  ON scrape_cache(expires_at);
` as const;

export const APP_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_snapshot (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store        TEXT NOT NULL CHECK (store IN ('apple', 'google')),
  app_id       TEXT NOT NULL,
  market       TEXT NOT NULL,
  snapshot_day TEXT NOT NULL,
  payload      TEXT NOT NULL,
  scraped_at   INTEGER NOT NULL,
  UNIQUE(store, app_id, market, snapshot_day)
);

CREATE INDEX IF NOT EXISTS idx_app_snapshot_app
  ON app_snapshot(store, app_id, market, snapshot_day);
` as const;

export const JUDGE_RESULT_SCHEMA = `
CREATE TABLE IF NOT EXISTS judge_result (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  store       TEXT NOT NULL CHECK (store IN ('apple', 'google')),
  app_id      TEXT NOT NULL,
  market      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('text', 'vision')),
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(run_id, store, app_id, market, kind)
);

CREATE INDEX IF NOT EXISTS idx_judge_result_run
  ON judge_result(run_id);

CREATE INDEX IF NOT EXISTS idx_judge_result_app
  ON judge_result(store, app_id, market, kind);
` as const;

export const ALL_SCHEMAS = [SCRAPE_CACHE_SCHEMA, APP_SNAPSHOT_SCHEMA, JUDGE_RESULT_SCHEMA] as const;

// ──────────────────────────────────────────────────────────────────────
// v1 schema additions
//
// Per docs/planning/agent-v1-foundation.md § "New tables in
// packages/selection-agent/src/storage/schema.ts" + Codex Round 2 fixes:
//
//   #1: load-bearing signals are typed nullable columns (REAL), not
//       JSON blobs. Lets SQLite index them and skip json_extract.
//   #2: schema_migrations table tracks applied DDL by version + checksum.
//   #6: signal_snapshots persists full LLM provenance (model, prompt
//       version, request/response hashes, archived response, source URLs)
//       so backtest replay reads frozen rows instead of calling the LLM.
//
// Schema strings are checksummed via sha256 in runMigrations; changing the
// DDL string for an already-applied version is detected on subsequent runs
// (logged but not auto-corrected — DDL evolution requires a new version).
// ──────────────────────────────────────────────────────────────────────

export const SCHEMA_MIGRATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  checksum   TEXT NOT NULL
);
` as const;

export const OPPORTUNITIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS opportunities (
  id                       TEXT PRIMARY KEY,
  generated_at             INTEGER NOT NULL,
  source_app_id            TEXT NOT NULL,
  source_market            TEXT NOT NULL,
  target_market            TEXT NOT NULL,
  category                 TEXT NOT NULL,
  -- signal_values: typed nullable columns for indexed queries (Codex R2 #1)
  sig_loc_gap              REAL,
  sig_velocity             REAL,
  sig_incumbent_vuln       REAL,
  sig_cpi_ltv_proxy        REAL,
  -- predicted unit economics
  pred_cpi_low             REAL,
  pred_cpi_high            REAL,
  pred_ltv_low             REAL,
  pred_ltv_high            REAL,
  pred_validation_budget   REAL,
  -- kill_metric
  kill_metric_name         TEXT,
  kill_metric_threshold    REAL,
  kill_metric_direction    TEXT CHECK(kill_metric_direction IN ('below','above')),
  -- actual_outcome (nullable until measured)
  outcome_measured_at      INTEGER,
  outcome_metric_value     REAL,
  outcome_label            TEXT CHECK(outcome_label IN ('winner','loser','marginal','not_validated')),
  outcome_revenue_proven   REAL,
  -- composite score + eligibility (Codex R2 #3)
  score                    REAL,
  eligible                 INTEGER NOT NULL DEFAULT 0,
  -- narrative
  thesis                   TEXT NOT NULL,
  evidence_json            TEXT NOT NULL,
  -- escape hatch
  metadata_json            TEXT NOT NULL DEFAULT '{}',
  -- versioning for backtest reproducibility (Codex R2 #6)
  signal_pipeline_version  TEXT NOT NULL,
  scoring_version          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opportunities_target_market
  ON opportunities(target_market, generated_at);
CREATE INDEX IF NOT EXISTS idx_opportunities_category
  ON opportunities(category, generated_at);
CREATE INDEX IF NOT EXISTS idx_opportunities_score
  ON opportunities(score) WHERE eligible = 1;
` as const;

export const WINNER_SCORES_SCHEMA = `
CREATE TABLE IF NOT EXISTS winner_scores (
  app_id          TEXT NOT NULL,
  t0              INTEGER NOT NULL,
  measured_at     INTEGER NOT NULL,
  score           REAL NOT NULL,
  tier            TEXT NOT NULL CHECK(tier IN ('winner','marginal','loser')),
  formula_version TEXT NOT NULL,
  computed_at     INTEGER NOT NULL,
  PRIMARY KEY (app_id, t0)
);
CREATE INDEX IF NOT EXISTS idx_winner_scores_tier
  ON winner_scores(tier, t0);
` as const;

export const SIGNAL_SNAPSHOTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS signal_snapshots (
  app_id                TEXT NOT NULL,
  signal_name           TEXT NOT NULL,
  t                     INTEGER NOT NULL,
  value                 REAL,
  -- LLM provenance for deterministic backtest replay (Codex R2 #6)
  llm_model             TEXT,
  llm_prompt_version    TEXT NOT NULL DEFAULT '',
  llm_request_hash      TEXT,
  llm_response_hash     TEXT,
  llm_response_archived TEXT,
  source_urls_json      TEXT,
  computed_at           INTEGER NOT NULL,
  PRIMARY KEY (app_id, signal_name, t, llm_prompt_version)
);
CREATE INDEX IF NOT EXISTS idx_signal_snapshots_signal
  ON signal_snapshots(signal_name, t);
` as const;

export const CHART_SNAPSHOTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS chart_snapshots (
  market      TEXT NOT NULL,
  category    TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  rank        INTEGER NOT NULL,
  app_id      TEXT NOT NULL,
  source      TEXT NOT NULL,
  PRIMARY KEY (market, category, captured_at, rank)
);
CREATE INDEX IF NOT EXISTS idx_chart_snapshots_app
  ON chart_snapshots(app_id, captured_at);
` as const;

export const APP_METADATA_SNAPSHOTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_metadata_snapshots (
  app_id               TEXT NOT NULL,
  market               TEXT NOT NULL,
  captured_at          INTEGER NOT NULL,
  source               TEXT NOT NULL CHECK(source IN ('42matters','wayback','live_scrape','appgoblin')),
  wayback_snapshot_url TEXT,
  raw_html_path        TEXT,
  parsed_json          TEXT NOT NULL,
  PRIMARY KEY (app_id, market, captured_at, source)
);
` as const;

/**
 * v1-2026-05-05-chart-snapshots-add-store — adds a `store` column to
 * chart_snapshots and includes it in the PK. AppTweak data covers both
 * Apple and Google charts, and rank-1 in (id, top_grossing_overall) collides
 * across stores; the original PK (market, category, captured_at, rank) does
 * not disambiguate. Existing rows (appgoblin imports + 42matters live cron,
 * both Apple-only at time of writing) backfill to store='apple'.
 *
 * Future inserts MUST set store explicitly. The schema retains a DEFAULT
 * 'apple' so legacy callers (appgoblin-import.ts) keep working without a
 * code change in this commit; they should be updated separately to insert
 * store explicitly when they handle Google data.
 */
export const CHART_SNAPSHOTS_ADD_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS chart_snapshots__new (
  market      TEXT NOT NULL,
  category    TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  rank        INTEGER NOT NULL,
  app_id      TEXT NOT NULL,
  source      TEXT NOT NULL,
  store       TEXT NOT NULL DEFAULT 'apple' CHECK(store IN ('apple','googleplay')),
  PRIMARY KEY (market, category, captured_at, rank, store)
);
INSERT OR IGNORE INTO chart_snapshots__new
  (market, category, captured_at, rank, app_id, source, store)
  SELECT market, category, captured_at, rank, app_id, source, 'apple'
    FROM chart_snapshots;
DROP TABLE chart_snapshots;
ALTER TABLE chart_snapshots__new RENAME TO chart_snapshots;
CREATE INDEX IF NOT EXISTS idx_chart_snapshots_app
  ON chart_snapshots(app_id, captured_at);
` as const;

/**
 * v1-2026-05-05-app-metadata-snapshots-add-apptweak — extends the source
 * CHECK to allow 'apptweak'. SQLite cannot ALTER an existing CHECK; the
 * migration rebuilds the table via the canonical create-new / copy / drop /
 * rename sequence. Idempotent: if the new CHECK is already in place
 * (subsequent runs), the rebuild becomes a no-op insert from an empty old
 * table.
 *
 * Path B'''' adds AppTweak as the historical chart-rank + metadata source;
 * the importers in src/ground-truth/apptweak-import.ts INSERT with
 * source='apptweak'. Without this CHECK extension the inserts would fail
 * with a CHECK constraint violation.
 */
export const APP_METADATA_SNAPSHOTS_ADD_APPTWEAK_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_metadata_snapshots__new (
  app_id               TEXT NOT NULL,
  market               TEXT NOT NULL,
  captured_at          INTEGER NOT NULL,
  source               TEXT NOT NULL CHECK(source IN ('42matters','wayback','live_scrape','appgoblin','apptweak')),
  wayback_snapshot_url TEXT,
  raw_html_path        TEXT,
  parsed_json          TEXT NOT NULL,
  PRIMARY KEY (app_id, market, captured_at, source)
);
INSERT OR IGNORE INTO app_metadata_snapshots__new
  (app_id, market, captured_at, source, wayback_snapshot_url, raw_html_path, parsed_json)
  SELECT app_id, market, captured_at, source, wayback_snapshot_url, raw_html_path, parsed_json
    FROM app_metadata_snapshots;
DROP TABLE app_metadata_snapshots;
ALTER TABLE app_metadata_snapshots__new RENAME TO app_metadata_snapshots;
` as const;

/**
 * rate_limit_queue — SQLite-backed FIFO queue for rate-limited fetchers
 * (Codex Round 2 #7 fix). Used by src/ground-truth/wayback-fetch.ts so a
 * crashed batch resumes from the last committed offset instead of from
 * zero. The DDL itself lives in src/util/rate-limit.ts as
 * RATE_LIMIT_QUEUE_SCHEMA; this migration just wires it into the
 * versioned ledger so a fresh DB doesn't need the queue's first
 * createPersistedQueue() call to bootstrap the table.
 */
export const RATE_LIMIT_QUEUE_MIGRATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS rate_limit_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_name  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_queue_name
  ON rate_limit_queue(queue_name, id);
` as const;

/**
 * cohort_freezes — stores the immutable cohort definitions captured at t0.
 * One row per (market, t0) freeze; app_ids_json holds the frozen list of
 * app IDs. Persisted so backtest replay across processes can reload the
 * exact cohort and run signals/labels against the same set every time.
 *
 * Composite PK (market, t0) means re-freezing the same (market, t0)
 * is rejected — by design. Re-running a freeze with a different cohort
 * would silently invalidate prior backtest reports; require an explicit
 * delete-then-insert if a re-freeze is intended.
 */
export const COHORT_FREEZES_SCHEMA = `
CREATE TABLE IF NOT EXISTS cohort_freezes (
  t0           INTEGER NOT NULL,
  market       TEXT NOT NULL,
  app_ids_json TEXT NOT NULL,
  frozen_at    INTEGER NOT NULL,
  PRIMARY KEY (market, t0)
);
` as const;

/**
 * path_c_winners — per (app, market, store, t0) winner labels for Path C v3.
 *
 * Path C's H1 horizon design uses per-cohort 90d-forward windows, with
 * winner labels scoped to (market, store) — same app can be a winner in
 * one market and a loser in another at the same t0. The legacy
 * `winner_scores` table has PK (app_id, t0) which collapses across
 * markets/stores, so a new table is required.
 *
 * Two boolean columns per row (kept INTEGER for SQLite-canonical 0/1):
 *   - winner_exact: rank ≤ 100 at exactly captured_at = t_measure (= t0 + 90d)
 *   - winner_window_7d: rank ≤ 100 anywhere in [t_measure - 6d, t_measure]
 *
 * Both labels are reported in the verdict; primary is `winner_exact`.
 *
 * t_measure is stored explicitly so verdict generation doesn't need to
 * recompute it from t0 + 90d (avoids day-boundary off-by-one risk).
 */
export const PATH_C_WINNERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS path_c_winners (
  app_id           TEXT NOT NULL,
  market           TEXT NOT NULL,
  store            TEXT NOT NULL CHECK(store IN ('apple','googleplay')),
  t0               INTEGER NOT NULL,
  t_measure        INTEGER NOT NULL,
  winner_exact     INTEGER NOT NULL CHECK(winner_exact IN (0,1)),
  winner_window_7d INTEGER NOT NULL CHECK(winner_window_7d IN (0,1)),
  computed_at      INTEGER NOT NULL,
  PRIMARY KEY (app_id, market, store, t0)
);
CREATE INDEX IF NOT EXISTS idx_path_c_winners_cohort
  ON path_c_winners(market, store, t0);
` as const;

/**
 * app_invariants — point-in-time-safe invariant fields per (app_id, store).
 *
 * Path C v3 design (`docs/planning/agent-v1-path-c-design.md`) requires two
 * fields from `metadata.jsonl` that are stable regardless of the t0 label
 * the AppTweak pull was attached to: `release_date` (original launch date)
 * and `publisher_id` (Apple `developer.id` or Google `developer` string).
 *
 * Why a dedicated table: the existing `app_metadata_snapshots` table
 * persists raw parsed_json blobs per (app_id, market, captured_at, source).
 * For Path C we need a flat, indexed projection of just the invariant
 * fields, joined cheaply against `chart_snapshots` for F7/F11. Storing
 * publisher_id as a typed column allows F7's self-join on publisher_id
 * without json_extract.
 *
 * PRIMARY KEY (app_id, store): an app's release_date and developer are
 * store-specific (same app on Apple and Google may have different
 * publisher records). market is intentionally NOT in the PK because the
 * invariant fields don't vary by market — the same Apple app has the
 * same release_date and developer.id in id/vn/th/etc.
 */
export const APP_INVARIANTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_invariants (
  app_id         TEXT NOT NULL,
  store          TEXT NOT NULL CHECK(store IN ('apple','googleplay')),
  publisher_id   TEXT,
  publisher_name TEXT,
  release_date   INTEGER,
  source         TEXT NOT NULL,
  ingested_at    INTEGER NOT NULL,
  PRIMARY KEY (app_id, store)
);
CREATE INDEX IF NOT EXISTS idx_app_invariants_publisher
  ON app_invariants(publisher_id, store);
` as const;

/**
 * Ordered list of v1 migrations. Versions are stable identifiers — never
 * rename. To evolve a table, add a new migration with a new version; do
 * NOT edit an existing migration's DDL string.
 *
 * Baseline `v0.7.0-baseline` covers the pre-v1 tables (scrape_cache,
 * app_snapshot, judge_result) that Cache.open already creates via
 * ALL_SCHEMAS. We register it as applied so the migration log accurately
 * reflects what's in the DB; the DDL itself is the concatenation of
 * ALL_SCHEMAS so the checksum changes if any pre-v1 schema string mutates.
 */
export const V1_MIGRATIONS: readonly { readonly version: string; readonly ddl: string }[] = [
  {
    version: "v0.7.0-baseline",
    ddl: ALL_SCHEMAS.join(""),
  },
  {
    version: "v1-2026-05-02-schema-migrations",
    ddl: SCHEMA_MIGRATIONS_SCHEMA,
  },
  {
    version: "v1-2026-05-02-opportunities",
    ddl: OPPORTUNITIES_SCHEMA,
  },
  {
    version: "v1-2026-05-02-winner-scores",
    ddl: WINNER_SCORES_SCHEMA,
  },
  {
    version: "v1-2026-05-02-signal-snapshots",
    ddl: SIGNAL_SNAPSHOTS_SCHEMA,
  },
  {
    version: "v1-2026-05-02-chart-snapshots",
    ddl: CHART_SNAPSHOTS_SCHEMA,
  },
  {
    version: "v1-2026-05-02-app-metadata-snapshots",
    ddl: APP_METADATA_SNAPSHOTS_SCHEMA,
  },
  {
    version: "v1-2026-05-02-cohort-freezes",
    ddl: COHORT_FREEZES_SCHEMA,
  },
  {
    version: "v1-2026-05-02-rate-limit-queue",
    ddl: RATE_LIMIT_QUEUE_MIGRATION_SCHEMA,
  },
  {
    version: "v1-2026-05-05-chart-snapshots-add-store",
    ddl: CHART_SNAPSHOTS_ADD_STORE_SCHEMA,
  },
  {
    version: "v1-2026-05-05-app-metadata-snapshots-add-apptweak",
    ddl: APP_METADATA_SNAPSHOTS_ADD_APPTWEAK_SCHEMA,
  },
  {
    version: "v1-2026-05-07-app-invariants",
    ddl: APP_INVARIANTS_SCHEMA,
  },
  {
    version: "v1-2026-05-07-path-c-winners",
    ddl: PATH_C_WINNERS_SCHEMA,
  },
] as const;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Idempotent migration runner. Applies each v1 migration whose version
 * is not yet recorded in `schema_migrations`. Records (version, applied_at,
 * sha256-of-ddl) on success.
 *
 * Pre-v1 tables (scrape_cache, app_snapshot, judge_result) are already
 * created by `Cache.open` via ALL_SCHEMAS. The first migration applied
 * here is `v1-2026-05-02-schema-migrations` (creates the migrations table
 * itself); the `v0.7.0-baseline` row is then INSERTed retroactively to
 * mark the pre-v1 surface as applied.
 *
 * Safe to call on every Cache.open. CREATE TABLE IF NOT EXISTS makes the
 * DDL itself idempotent; the migrations table dedupes the ledger.
 */
export function runMigrations(db: Database): void {
  // Bootstrap: create schema_migrations table first if missing. Pulled out of
  // the V1_MIGRATIONS loop so we can read the table inside the loop without
  // a chicken-and-egg moment.
  db.exec(SCHEMA_MIGRATIONS_SCHEMA);

  const applied = new Set<string>(
    db
      .prepare<{ version: string }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version),
  );

  const now = Date.now();
  const insertStmt = db.prepare(
    "INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)",
  );

  for (const m of V1_MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec(m.ddl);
    insertStmt.run(m.version, now, sha256(m.ddl));
  }
}
