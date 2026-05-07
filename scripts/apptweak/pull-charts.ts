#!/usr/bin/env bun
/**
 * AppTweak Top Charts History → TSV pull (one-shot).
 *
 * Reads APPTWEAK_KEY from monorepo-root .env or env. Pulls 12 months of
 * top-grossing chart history for tier-2 SEA markets on both iOS and Android,
 * appends to a TSV in chart_snapshots schema shape, and records progress in a
 * SQLite db (in node_modules/.cache/) so reruns skip already-completed pulls.
 *
 * Usage:
 *   cd <monorepo-root>
 *   bun run packages/selection-agent/scripts/apptweak/pull-charts.ts
 *
 * Output:
 *   data/apptweak-2026-05-04/chart-snapshots.tsv     — appended rows
 *   node_modules/.cache/apptweak/state.db            — progress tracker
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ENV_PATH = join(ROOT, ".env");
const STATE_DIR = join(ROOT, "node_modules", ".cache", "apptweak");
const STATE_DB = join(STATE_DIR, "state.db");
const OUT_DIR = join(ROOT, "data", "apptweak-2026-05-04");
const OUT_TSV = join(OUT_DIR, "chart-snapshots.tsv");

function loadKey(varName: string): string {
  if (process.env[varName]) return process.env[varName] as string;
  if (existsSync(ENV_PATH)) {
    const raw = readFileSync(ENV_PATH, "utf8");
    const re = new RegExp(`^\\s*${varName}\\s*=\\s*(.+?)\\s*$`, "m");
    const m = raw.match(re);
    if (m) return m[1].replace(/^['"]|['"]$/g, "");
  }
  throw new Error(`${varName} not found in env or .env`);
}

const KEY_VAR = process.env.APPTWEAK_KEY_VAR ?? "APPTWEAK_KEY";
const KEY = loadKey(KEY_VAR);
const BASE = "https://public-api.apptweak.com";
const ENDPOINT = "/api/public/store/charts/top-results/history.json";

function windowDates(): { start: string; end: string } {
  const today = new Date();
  today.setUTCDate(today.getUTCDate() - 1);
  const end = today.toISOString().slice(0, 10);
  today.setUTCDate(today.getUTCDate() - 364);
  const start = today.toISOString().slice(0, 10);
  return { start, end };
}

type ChartType = "grossing" | "free" | "paid";
type Pull = {
  device: "iphone" | "android";
  market: string;
  category: string;
  type: ChartType;
  category_label: string;
};

const DEFAULT_IPHONE_MARKETS = ["id", "vn", "th", "my"];
const DEFAULT_ANDROID_MARKETS = ["id", "vn", "th", "my", "bd"];

function parseMarkets(envName: string, fallback: string[]): string[] {
  const raw = process.env[envName];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function parseTypes(): ChartType[] {
  const raw = process.env.APPTWEAK_CHART_TYPES;
  if (!raw) return ["grossing"];
  const out: ChartType[] = [];
  for (const t of raw.split(",").map((s) => s.trim().toLowerCase())) {
    if (t === "grossing" || t === "free" || t === "paid") out.push(t);
    else throw new Error(`unknown chart type: ${t}`);
  }
  return out;
}

const IPHONE_MARKETS = parseMarkets("APPTWEAK_MARKETS_IPHONE", DEFAULT_IPHONE_MARKETS);
const ANDROID_MARKETS = parseMarkets("APPTWEAK_MARKETS_ANDROID", DEFAULT_ANDROID_MARKETS);
const CHART_TYPES = parseTypes();

const TYPE_LABEL: Record<ChartType, string> = {
  grossing: "top_grossing_overall",
  free: "top_free_overall",
  paid: "top_paid_overall",
};

const PULLS: Pull[] = [];
for (const t of CHART_TYPES) {
  for (const m of IPHONE_MARKETS) {
    PULLS.push({
      device: "iphone",
      market: m,
      category: "0",
      type: t,
      category_label: TYPE_LABEL[t],
    });
  }
  for (const m of ANDROID_MARKETS) {
    PULLS.push({
      device: "android",
      market: m,
      category: "ALL",
      type: t,
      category_label: TYPE_LABEL[t],
    });
  }
}

type ChartHistoryResponse = {
  result: Record<string, Record<string, Array<{ date: string; value: number[] | string[] }>>>;
  metadata: { request: { cost: number; max_credit_cost: number; status: number } };
};

type ErrorResponse = {
  error: { code: string; reason: string; parameter?: string };
  metadata: { request: { cost: number; status: number } };
};

async function fetchChart(p: Pull, start: string, end: string): Promise<ChartHistoryResponse> {
  const u = new URL(BASE + ENDPOINT);
  u.searchParams.set("country", p.market);
  u.searchParams.set("device", p.device);
  u.searchParams.set("categories", p.category);
  u.searchParams.set("types", p.type);
  u.searchParams.set("start_date", start);
  u.searchParams.set("end_date", end);

  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(u.toString(), {
        headers: { "x-apptweak-key": KEY, Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.json();
      if (res.status === 200) return body as ChartHistoryResponse;
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      } else {
        const e = body as ErrorResponse;
        throw new Error(`HTTP ${res.status} (no retry): ${e?.error?.code} ${e?.error?.reason}`);
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < maxAttempts) {
      const backoffMs = 1000 * 2 ** (attempt - 1);
      console.error(`  retry ${attempt}/${maxAttempts} after ${backoffMs}ms (${lastErr})`);
      await Bun.sleep(backoffMs);
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

function dayMs(yyyymmdd: string): number {
  return Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(5, 7)) - 1,
    Number(yyyymmdd.slice(8, 10)),
  );
}

function emitRows(p: Pull, body: ChartHistoryResponse): string[] {
  const rows: string[] = [];
  const days = body.result?.[p.category]?.[p.type] ?? [];
  for (const day of days) {
    const captured_at = dayMs(day.date);
    const apps = day.value;
    for (let rank = 1; rank <= apps.length; rank++) {
      const app_id = String(apps[rank - 1]);
      const store = p.device === "iphone" ? "apple" : "googleplay";
      rows.push(
        `${app_id}\t${p.market}\t${p.category_label}\t${captured_at}\t${rank}\tapptweak\t${store}`,
      );
    }
  }
  return rows;
}

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const state = new Database(STATE_DB);
state.exec(`
  CREATE TABLE IF NOT EXISTS completed (
    device TEXT NOT NULL,
    market TEXT NOT NULL,
    type TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    rows_emitted INTEGER NOT NULL,
    cost_credits INTEGER NOT NULL,
    PRIMARY KEY (device, market, type)
  );
`);

const isCompleted = state.prepare(
  "SELECT 1 FROM completed WHERE device = ? AND market = ? AND type = ?",
);
const markCompleted = state.prepare(
  "INSERT INTO completed (device, market, type, completed_at, rows_emitted, cost_credits) VALUES (?, ?, ?, ?, ?, ?)",
);

if (!existsSync(OUT_TSV)) {
  writeFileSync(OUT_TSV, "app_id\tmarket\tcategory\tcaptured_at\trank\tsource\tstore\n");
}

const { start, end } = windowDates();
console.log(`key var: ${KEY_VAR} (...${KEY.slice(-6)})`);
console.log(`window:  ${start} → ${end}`);
console.log(`types:   ${CHART_TYPES.join(",")}`);
console.log(`iphone:  ${IPHONE_MARKETS.join(",")} (${IPHONE_MARKETS.length})`);
console.log(`android: ${ANDROID_MARKETS.join(",")} (${ANDROID_MARKETS.length})`);
console.log(`pulls:   ${PULLS.length}`);
console.log(`output:  ${OUT_TSV}`);
console.log("---");

let totalRows = 0;
let totalCost = 0;
let totalSkipped = 0;
const startedMs = Date.now();

for (const p of PULLS) {
  const tag = `${p.device}/${p.market}/${p.type}`;
  const done = isCompleted.get(p.device, p.market, p.type);
  if (done) {
    totalSkipped += 1;
    console.log(`skip ${tag} (already completed)`);
    continue;
  }
  process.stdout.write(`pull ${tag} ... `);
  try {
    const body = await fetchChart(p, start, end);
    const rows = emitRows(p, body);
    if (rows.length > 0) appendFileSync(OUT_TSV, `${rows.join("\n")}\n`);
    const cost = body.metadata?.request?.cost ?? 0;
    totalCost += cost;
    totalRows += rows.length;
    markCompleted.run(p.device, p.market, p.type, Date.now(), rows.length, cost);
    console.log(`ok rows=${rows.length} cost=${cost}`);
  } catch (e) {
    console.log(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
  }
  await Bun.sleep(500);
}

const elapsedSec = ((Date.now() - startedMs) / 1000).toFixed(1);
console.log("---");
console.log(`done in ${elapsedSec}s`);
console.log(`pulls completed: ${PULLS.length - totalSkipped} (${totalSkipped} skipped)`);
console.log(`rows emitted:    ${totalRows}`);
console.log(`credits used:    ${totalCost}`);
console.log(`output TSV:      ${OUT_TSV}`);
