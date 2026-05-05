#!/usr/bin/env bun
/**
 * AppTweak market discovery probe.
 *
 * For each ISO 3166-1 alpha-2 country code × {iphone, android}, pull a
 * 1-day top-grossing chart slice and record (has_data, app_count, error).
 * Output: data/apptweak-2026-05-04/markets-coverage.tsv.
 *
 * Cost: ~500 credits (1 per probe × 249 codes × 2 stores). Idempotent: skips
 * already-probed (cc, device) pairs via the shared apptweak state DB.
 *
 * Usage:
 *   APPTWEAK_KEY_VAR=APPTWEAK_KEY bun run packages/selection-agent/scripts/apptweak/discover-markets.ts
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ENV_PATH = join(ROOT, ".env");
const STATE_DIR = join(ROOT, "node_modules", ".cache", "apptweak");
const STATE_DB = join(STATE_DIR, "state.db");
const OUT_DIR = join(ROOT, "data", "apptweak-2026-05-04");
const OUT_TSV = join(OUT_DIR, "markets-coverage.tsv");

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
const PACING_MS = 200;

// ISO 3166-1 alpha-2 country codes (249 total).
const ISO_CODES = `
ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz
ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo
fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je
jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo
mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw
py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm
tn to tr tt tv tw tz ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw
`
  .split(/\s+/)
  .filter((s) => s.length === 2);

const DEVICES = ["iphone", "android"] as const;
type Device = (typeof DEVICES)[number];

type ProbeResult =
  | { ok: true; app_count: number; cost: number }
  | { ok: false; error: string; cost: number };

async function probe(cc: string, device: Device): Promise<ProbeResult> {
  const yest = new Date();
  yest.setUTCDate(yest.getUTCDate() - 2);
  const day = yest.toISOString().slice(0, 10);

  const u = new URL(BASE + ENDPOINT);
  u.searchParams.set("country", cc);
  u.searchParams.set("device", device);
  u.searchParams.set("categories", device === "iphone" ? "0" : "ALL");
  u.searchParams.set("types", "grossing");
  u.searchParams.set("start_date", day);
  u.searchParams.set("end_date", day);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(u.toString(), {
        headers: { "x-apptweak-key": KEY, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json()) as {
        result?: Record<string, Record<string, Array<{ date: string; value: unknown[] }>>>;
        metadata?: { request: { cost: number } };
        error?: { code: string; reason: string };
      };
      const cost = body.metadata?.request?.cost ?? 0;
      if (res.status === 200) {
        const cat = device === "iphone" ? "0" : "ALL";
        const days = body.result?.[cat]?.grossing ?? [];
        const appCount = days[0]?.value?.length ?? 0;
        return { ok: true, app_count: appCount, cost };
      }
      if (res.status === 429 || res.status >= 500) {
        await Bun.sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      const code = body.error?.code ?? `http_${res.status}`;
      const reason = body.error?.reason ?? "unknown";
      return { ok: false, error: `${code}:${reason}`, cost };
    } catch (e) {
      if (attempt === 3) {
        return { ok: false, error: `fetch_err:${e instanceof Error ? e.message : e}`, cost: 0 };
      }
      await Bun.sleep(1000 * 2 ** (attempt - 1));
    }
  }
  return { ok: false, error: "max_retries", cost: 0 };
}

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const state = new Database(STATE_DB);
state.exec(`
  CREATE TABLE IF NOT EXISTS discover_completed (
    cc TEXT NOT NULL,
    device TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    has_data INTEGER NOT NULL,
    app_count INTEGER NOT NULL,
    error TEXT,
    cost_credits INTEGER NOT NULL,
    PRIMARY KEY (cc, device)
  );
`);

const isCompleted = state.prepare("SELECT 1 FROM discover_completed WHERE cc = ? AND device = ?");
const markCompleted = state.prepare("INSERT INTO discover_completed VALUES (?, ?, ?, ?, ?, ?, ?)");

if (!existsSync(OUT_TSV)) {
  writeFileSync(OUT_TSV, "cc\tdevice\thas_data\tapp_count\terror\tcost\n");
}

console.log(`key var: ${KEY_VAR} (...${KEY.slice(-6)})`);
console.log(
  `probes:  ${ISO_CODES.length} codes × ${DEVICES.length} devices = ${ISO_CODES.length * DEVICES.length}`,
);
console.log(`output:  ${OUT_TSV}`);
console.log("---");

let totalCost = 0;
let totalProbes = 0;
let totalSkipped = 0;
let totalWithData = 0;
const startedMs = Date.now();

for (const cc of ISO_CODES) {
  for (const device of DEVICES) {
    if (isCompleted.get(cc, device)) {
      totalSkipped += 1;
      continue;
    }
    const result = await probe(cc, device);
    totalCost += result.cost;
    totalProbes += 1;
    if (result.ok) {
      const hasData = result.app_count > 0 ? 1 : 0;
      if (hasData) totalWithData += 1;
      markCompleted.run(cc, device, Date.now(), hasData, result.app_count, null, result.cost);
      appendFileSync(
        OUT_TSV,
        `${cc}\t${device}\t${hasData}\t${result.app_count}\t\t${result.cost}\n`,
      );
      if (hasData) console.log(`  ${cc}/${device}: ${result.app_count} apps`);
    } else {
      markCompleted.run(cc, device, Date.now(), 0, 0, result.error, result.cost);
      appendFileSync(OUT_TSV, `${cc}\t${device}\t0\t0\t${result.error}\t${result.cost}\n`);
    }
    await Bun.sleep(PACING_MS);
  }
}

const elapsedSec = ((Date.now() - startedMs) / 1000).toFixed(1);
console.log("---");
console.log(`done in ${elapsedSec}s`);
console.log(`probes: ${totalProbes} (${totalSkipped} skipped from prior run)`);
console.log(`with data: ${totalWithData}`);
console.log(`credits used: ${totalCost}`);
console.log(`output TSV: ${OUT_TSV}`);
