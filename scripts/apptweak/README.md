# AppTweak data pull scripts

Two one-shot scripts that pull historical chart-rank + metadata + metrics from the AppTweak API for backtest validation. Both are idempotent (resume on re-run via SQLite state in `node_modules/.cache/apptweak/`).

## Setup

```sh
# 1. Activate an AppTweak API plan trial (https://www.apptweak.com — Manage subscriptions → API)
# 2. Copy the API token from the AppTweak dashboard
# 3. Save it at the monorepo root
echo 'APPTWEAK_KEY=<your-token>' > .env
chmod 600 .env
```

## Run

```sh
# 1. Pull 12 months of daily chart-rank for tier-2 SEA markets (iOS + Google Play, top-grossing overall)
bun run packages/selection-agent/scripts/apptweak/pull-charts.ts

# 2. Pull localized metadata + ratings + app-power at 3 historical t0s
#    Reads chart contents from the TSV produced by step 1
bun run packages/selection-agent/scripts/apptweak/pull-enrichment.ts
```

## Cost (approximate, on a fresh trial)

| Step | API calls | Credits |
|---|---|---|
| Step 1 (charts) | 9 | ~3,400 |
| Step 2 (enrichment) | 1,080 | ~62,000 |
| **Total** | **1,089** | **~65,000 / 100,000 trial budget** |

Wall time: ~45 minutes for the full pull (mostly enrichment, paced at 250ms between calls).

## Constraints

- AppTweak API enforces **max 5 apps per batch** on metadata + metrics endpoints (verified by 422 ValidationError on larger batches).
- The 7-day trial gives **100,000 credits** and **full API access**, identical across all paid tiers (Small / Medium / Large). Tier difference is `Tracked Apps` cap, which only matters if you pull metadata or metrics for many distinct apps. For our scope (~2,150 unique apps across 3 t0s), Small (250 tracked apps) is insufficient — pick at least Medium.
- "One trial per product" — once activated, you cannot redo it on the same account.
- Refund guarantee: if you forget to cancel and get auto-billed, AppTweak's support refunds the first payment within 48 hours.

## Output

| Path | Format | Schema |
|---|---|---|
| `data/apptweak-{date}/chart-snapshots.tsv` | TSV | `app_id\tmarket\tcategory\tcaptured_at\trank\tsource\tstore` |
| `data/apptweak-{date}/metadata.jsonl` | JSONL | `{app_id, market, store, device, language, t0, raw}` |
| `data/apptweak-{date}/metrics.jsonl` | JSONL | `{app_id, market, store, device, t0, raw}` |
| `node_modules/.cache/apptweak/state.db` | SQLite | per-(market, store, t0, endpoint) progress, ignored by git |

The `data/apptweak-{date}/` directory is at the monorepo root, NOT inside `packages/*` — so it stays private (subtree-split only mirrors `packages/*` to the public OSS repos).

## Re-running on a new date window

Both scripts have hardcoded constants near the top:

- `pull-charts.ts`: `windowDates()` returns a 365-day window ending yesterday.
- `pull-enrichment.ts`: `T0S` is a 3-element array of decision dates.

Edit those + change the output dir name (`data/apptweak-{new-date}/`) and re-run. The state DB is shared across runs, so if you want a clean slate, delete `node_modules/.cache/apptweak/state.db` first.
