#!/bin/bash
# Sets up a daily Apple RSS snapshot cron via macOS launchd.
# Idempotent: safe to re-run.
#
# What it does:
#   - Creates ~/.appsmachine data dir + log files
#   - Installs ~/Library/LaunchAgents/com.appsmachine.rss-snapshot.plist
#   - Loads the launchd agent (runs daily at 02:00 local time)
#   - Verifies it's loaded
#
# Output: chart_snapshots accumulate at ~/.appsmachine/charts.db
# Logs: ~/Library/Logs/com.appsmachine.rss-snapshot.{out,err}.log
#
# Uninstall:
#   launchctl unload ~/Library/LaunchAgents/com.appsmachine.rss-snapshot.plist
#   rm ~/Library/LaunchAgents/com.appsmachine.rss-snapshot.plist

set -euo pipefail

LABEL="com.appsmachine.rss-snapshot"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
TEMPLATE_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${LABEL}.plist.template"
DATA_DIR="$HOME/.appsmachine"
LOG_DIR="$HOME/Library/Logs"

echo "[setup-rss-cron] data dir: $DATA_DIR"
mkdir -p "$DATA_DIR"
mkdir -p "$LOG_DIR"
mkdir -p "$HOME/Library/LaunchAgents"

if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "[setup-rss-cron] ERROR: template not found at $TEMPLATE_PATH" >&2
  exit 1
fi

BUN_BIN="$(dirname "$(command -v bun 2>/dev/null || echo /usr/local/bin/bun)")"
NODE_BIN="$(dirname "$(command -v node 2>/dev/null || echo /usr/local/bin/node)")"
echo "[setup-rss-cron] bun bin: $BUN_BIN"
echo "[setup-rss-cron] node bin: $NODE_BIN"

echo "[setup-rss-cron] writing plist to $PLIST_PATH"
sed -e "s|__HOME__|$HOME|g" \
    -e "s|__BUN_BIN__|$BUN_BIN|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$TEMPLATE_PATH" > "$PLIST_PATH"

if launchctl list | grep -q "$LABEL"; then
  echo "[setup-rss-cron] agent already loaded; reloading"
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

echo "[setup-rss-cron] loading agent"
launchctl load "$PLIST_PATH"

if launchctl list | grep -q "$LABEL"; then
  echo "[setup-rss-cron] OK — agent loaded as $LABEL"
  echo "[setup-rss-cron] schedule: daily at 02:00 local time"
  echo "[setup-rss-cron] data: $DATA_DIR/charts.db"
  echo "[setup-rss-cron] logs: $LOG_DIR/${LABEL}.{out,err}.log"
  echo ""
  echo "Tail logs:"
  echo "  tail -f $LOG_DIR/${LABEL}.out.log"
  echo ""
  echo "Manual trigger (test it now without waiting for 02:00):"
  echo "  launchctl start $LABEL"
  echo "  tail -f $LOG_DIR/${LABEL}.out.log"
else
  echo "[setup-rss-cron] ERROR: agent failed to load" >&2
  exit 1
fi
