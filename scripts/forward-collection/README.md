# Forward Collection — Apple RSS Daily Snapshot

Companion to the v0.8.0 agent v1 build. Sets up a daily macOS cron that
snapshots top-grossing apps across the 6 Phase 0 markets and persists them
to a local SQLite db.

## Why this exists

Per `docs/planning/agent-v1-foundation.md` and the Day-1 audit
(`agent-v1-day1-audit.md`), historical app metadata for tier-2 SEA in
2022-2024 is unavailable from OSS sources. After discovering 42matters'
"trial" is demo-only (no API), the team chose path A+B:

- **A** — validate v1 via real ROAS on shipped apps (apps-first stays primary)
- **B** — start collecting our own forward time-series TODAY so a backtest
  becomes possible at +6 months on accumulated data

This script is the B piece.

## Usage

```bash
./setup-rss-cron.sh
```

Idempotent. Safe to re-run. Installs `~/Library/LaunchAgents/com.appsmachine.rss-snapshot.plist`,
loads it, verifies. Schedule: daily at 02:00 local time.

## What gets collected

Each run scrapes top-200 grossing per (market × store) for: BD, TH, VN, MY, ID
(default markets per v0.7.0 pivot). Data persists to `~/.appsmachine/charts.db`
in the `chart_snapshots` table. No LLM calls (cron-friendly, scrape-only).

## Logs

- Stdout: `~/Library/Logs/com.appsmachine.rss-snapshot.out.log`
- Stderr: `~/Library/Logs/com.appsmachine.rss-snapshot.err.log`

## Manual trigger (test without waiting for 02:00)

```bash
launchctl start com.appsmachine.rss-snapshot
tail -f ~/Library/Logs/com.appsmachine.rss-snapshot.out.log
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.appsmachine.rss-snapshot.plist
rm ~/Library/LaunchAgents/com.appsmachine.rss-snapshot.plist
```

The data directory `~/.appsmachine/` and accumulated SQLite db are NOT
removed — that's intentional, your time-series is precious. Delete manually
if you really want to.

## Why launchd not GitHub Actions

Local launchd keeps data on your machine (no shared infra setup), respects
the v1-as-prototype philosophy (single operator), and is reversible in one
command. When we move to multi-user SaaS, we'll graduate to a hosted cron
+ shared Postgres.
