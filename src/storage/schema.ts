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
