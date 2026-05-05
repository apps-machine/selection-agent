#!/usr/bin/env bun
/**
 * AppTweak metadata + metrics enrichment pull (one-shot).
 *
 * For each of N decision dates (t0s), reads the chart contents at that day
 * from the existing TSV (produced by pull-charts.ts), then pulls per-app:
 *   - localized metadata (title/subtitle/description) — for locGap LLM judge
 *   - ratings + app-power metrics — for incumbent_vulnerability + sanity check
 *
 * Outputs JSONL files keyed by (app, market, store, t0). Idempotent via the
 * same SQLite state DB used by pull-charts.ts.
 *
 * AppTweak constraints discovered by probing:
 *   - max 5 apps per batch on both metadata and metrics endpoints
 *   - metadata path is /api/public/store/apps/metadata.json (not /metadata/history)
 *     with start_date=end_date for a single-day historical pull
 *
 * Usage:
 *   cd <monorepo-root>
 *   bun run packages/selection-agent/scripts/apptweak/pull-enrichment.ts
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ENV_PATH = join(ROOT, ".env");
const STATE_DIR = join(ROOT, "node_modules", ".cache", "apptweak");
const STATE_DB = join(STATE_DIR, "state.db");
const DATA_DIR = join(ROOT, "data", "apptweak-2026-05-04");
const TSV_IN = join(DATA_DIR, "chart-snapshots.tsv");
const META_OUT = join(DATA_DIR, "metadata.jsonl");
const METRICS_OUT = join(DATA_DIR, "metrics.jsonl");

function loadKey(): string {
  if (process.env.APPTWEAK_KEY) return process.env.APPTWEAK_KEY;
  if (existsSync(ENV_PATH)) {
    const raw = readFileSync(ENV_PATH, "utf8");
    const m = raw.match(/^\s*APPTWEAK_KEY\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^['"]|['"]$/g, "");
  }
  throw new Error("APPTWEAK_KEY not found");
}

const KEY = loadKey();
const BASE = "https://public-api.apptweak.com";
const META_PATH = "/api/public/store/apps/metadata.json";
const METRICS_PATH = "/api/public/store/apps/metrics/history.json";
const BATCH_SIZE = 5;
const PACING_MS = 250;

const T0S = ["2025-05-04", "2025-08-04", "2025-11-04"] as const;
type T0 = (typeof T0S)[number];

const MARKETS = [
  { market: "id", device: "iphone" as const, store: "apple" as const, language: "id" },
  { market: "vn", device: "iphone" as const, store: "apple" as const, language: "vi" },
  { market: "th", device: "iphone" as const, store: "apple" as const, language: "th" },
  { market: "my", device: "iphone" as const, store: "apple" as const, language: "ms" },
  { market: "id", device: "android" as const, store: "googleplay" as const, language: "id" },
  { market: "vn", device: "android" as const, store: "googleplay" as const, language: "vi" },
  { market: "th", device: "android" as const, store: "googleplay" as const, language: "th" },
  { market: "my", device: "android" as const, store: "googleplay" as const, language: "ms" },
  { market: "bd", device: "android" as const, store: "googleplay" as const, language: "bn" },
];

function dateMs(yyyymmdd: string): number {
  return Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(5, 7)) - 1,
    Number(yyyymmdd.slice(8, 10)),
  );
}

function loadChartApps(market: string, store: string, t0: T0): string[] {
  const tsv = readFileSync(TSV_IN, "utf8");
  const targetMs = dateMs(t0);
  const apps: string[] = [];
  let isHeader = true;
  for (const line of tsv.split("\n")) {
    if (!line) continue;
    if (isHeader) {
      isHeader = false;
      continue;
    }
    const cols = line.split("\t");
    if (cols[1] === market && cols[6] === store && Number(cols[3]) === targetMs) {
      apps.push(cols[0]);
    }
  }
  return apps;
}

type EnvelopeOK = {
  result: Record<string, unknown>;
  metadata: { request: { cost: number; status: number } };
};
type EnvelopeErr = {
  error: { code: string; reason: string; parameter?: string };
  metadata: { request: { cost: number; status: number } };
};

async function callApi(path: string, params: Record<string, string>): Promise<EnvelopeOK | null> {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(u.toString(), {
        headers: { "x-apptweak-key": KEY, Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      const body = (await res.json()) as EnvelopeOK | EnvelopeErr;
      if (res.status === 200) return body as EnvelopeOK;
      if (res.status >= 500 || res.status === 429) {
        await Bun.sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      const err = body as EnvelopeErr;
      console.error(
        `  ${res.status} ${err.error?.code} ${err.error?.reason} (${err.error?.parameter})`,
      );
      return null;
    } catch (e) {
      console.error(`  fetch err attempt ${attempt}: ${e instanceof Error ? e.message : e}`);
      if (attempt === 3) return null;
      await Bun.sleep(1000 * 2 ** (attempt - 1));
    }
  }
  return null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });

const state = new Database(STATE_DB);
state.exec(`
  CREATE TABLE IF NOT EXISTS enrichment_completed (
    market   TEXT NOT NULL,
    store    TEXT NOT NULL,
    t0       TEXT NOT NULL,
    endpoint TEXT NOT NULL CHECK(endpoint IN ('metadata','metrics')),
    completed_at INTEGER NOT NULL,
    apps_attempted INTEGER NOT NULL,
    apps_succeeded INTEGER NOT NULL,
    cost_credits INTEGER NOT NULL,
    PRIMARY KEY (market, store, t0, endpoint)
  );
`);

const isCompleted = state.prepare(
  "SELECT 1 FROM enrichment_completed WHERE market = ? AND store = ? AND t0 = ? AND endpoint = ?",
);
const markCompleted = state.prepare(
  "INSERT INTO enrichment_completed VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);

if (!existsSync(META_OUT)) writeFileSync(META_OUT, "");
if (!existsSync(METRICS_OUT)) writeFileSync(METRICS_OUT, "");

let totalCost = 0;
let totalCalls = 0;
const startedMs = Date.now();

console.log(`t0s: ${T0S.join(", ")}`);
console.log(`(market, store) combos: ${MARKETS.length}`);
console.log(`endpoints: metadata + metrics(ratings,app-power)`);
console.log(`output: ${META_OUT}`);
console.log(`output: ${METRICS_OUT}`);
console.log("---");

for (const t0 of T0S) {
  for (const m of MARKETS) {
    const apps = loadChartApps(m.market, m.store, t0);
    if (apps.length === 0) {
      console.log(`skip ${m.market}/${m.store}/${t0}: no chart apps in TSV`);
      continue;
    }
    const batches = chunk(apps, BATCH_SIZE);
    const tag = `${m.market}/${m.store}/${t0}`;

    if (!isCompleted.get(m.market, m.store, t0, "metadata")) {
      process.stdout.write(`metadata ${tag} (${apps.length} apps in ${batches.length} batches): `);
      let cost = 0;
      let succeeded = 0;
      for (const batch of batches) {
        const body = await callApi(META_PATH, {
          apps: batch.join(","),
          country: m.market,
          device: m.device,
          language: m.language,
          start_date: t0,
          end_date: t0,
        });
        totalCalls += 1;
        if (body) {
          cost += body.metadata?.request?.cost ?? 0;
          for (const [appId, payload] of Object.entries(body.result ?? {})) {
            const rec = {
              app_id: appId,
              market: m.market,
              store: m.store,
              device: m.device,
              language: m.language,
              t0,
              raw: payload,
            };
            appendFileSync(META_OUT, JSON.stringify(rec) + "\n");
            succeeded += 1;
          }
        }
        await Bun.sleep(PACING_MS);
      }
      totalCost += cost;
      markCompleted.run(
        m.market,
        m.store,
        t0,
        "metadata",
        Date.now(),
        apps.length,
        succeeded,
        cost,
      );
      console.log(`ok ${succeeded}/${apps.length} cost=${cost}`);
    } else {
      console.log(`skip metadata ${tag} (already completed)`);
    }

    if (!isCompleted.get(m.market, m.store, t0, "metrics")) {
      process.stdout.write(`metrics  ${tag} (${apps.length} apps in ${batches.length} batches): `);
      let cost = 0;
      let succeeded = 0;
      for (const batch of batches) {
        const body = await callApi(METRICS_PATH, {
          apps: batch.join(","),
          country: m.market,
          device: m.device,
          metrics: "ratings,app-power",
          start_date: t0,
          end_date: t0,
        });
        totalCalls += 1;
        if (body) {
          cost += body.metadata?.request?.cost ?? 0;
          for (const [appId, payload] of Object.entries(body.result ?? {})) {
            const rec = {
              app_id: appId,
              market: m.market,
              store: m.store,
              device: m.device,
              t0,
              raw: payload,
            };
            appendFileSync(METRICS_OUT, JSON.stringify(rec) + "\n");
            succeeded += 1;
          }
        }
        await Bun.sleep(PACING_MS);
      }
      totalCost += cost;
      markCompleted.run(m.market, m.store, t0, "metrics", Date.now(), apps.length, succeeded, cost);
      console.log(`ok ${succeeded}/${apps.length} cost=${cost}`);
    } else {
      console.log(`skip metrics  ${tag} (already completed)`);
    }
  }
}

const elapsedSec = ((Date.now() - startedMs) / 1000).toFixed(1);
console.log("---");
console.log(`done in ${elapsedSec}s, ${totalCalls} API calls`);
console.log(`credits used:    ${totalCost}`);
console.log(`metadata JSONL:  ${META_OUT}`);
console.log(`metrics JSONL:   ${METRICS_OUT}`);
