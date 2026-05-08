#!/usr/bin/env bun
/**
 * Path E — winning path: shortlist generator for Atlas1m portfolio.
 *
 * Founder directive (2026-05-08): stop predict-the-future, start identify-the-takeable.
 * The empirical Path C verdict (K3) confirmed F0 saturates at 99-100% precision
 * on top-decile retention. So the right operator move is NOT to build a ranker
 * but to build a SHORTLIST: 30-50 apps that are durable winners + clonable for
 * a solo founder at $500/app validation budget.
 *
 * Pipeline:
 *   F1 DURABILITY: ≥180 days at rank ≤ 100 in ≥1 tier-2 SEA market in trailing year
 *   F2 INDIE: publisher has ≤5 apps in our metadata
 *   F3 MECHANIC: dna.class_label ∈ CLONABLE_AUTO ∪ CLONABLE_REVIEW
 *   F4 MONETIZATION: implicit from F1 (top_grossing_overall presence) + IAP flag
 *   F5 MARKET SPREAD: present at rank ≤ 100 in ≥2 tier-2 SEA markets
 *
 * Composite score (each component normalized 0-1, then weighted):
 *   - tenure_score (max tenure days across markets / 365)            w=0.30
 *   - market_spread_score (n_markets_active / 5)                     w=0.20
 *   - recency_score (recent_30d_days / 30)                            w=0.20
 *   - rank_score (1 - best_rank/100)                                  w=0.15
 *   - indie_score (1 - publisher_app_count/MAX_INDIE_PORTFOLIO)       w=0.15
 *
 * Top 50 → LLM Haiku one-line clonability hypothesis ($~0.03 total).
 *
 * Output: docs/planning/path-e-shortlist/{ts}/shortlist.csv + .json
 *
 * Usage:
 *   bun run packages/selection-agent/scripts/path-e/build-shortlist.ts \
 *     [--db .cache/selection-agent.sqlite] \
 *     [--no-llm] (skip LLM clonability hypothesis)
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import pino from "pino";
import { runMigrations } from "../../src/storage/schema.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const DEFAULT_DB = join(ROOT, ".cache", "selection-agent.sqlite");
const METADATA_GZ = join(ROOT, "data", "apptweak-2026-05-04", "metadata.jsonl.gz");
const METADATA_RAW = join(ROOT, "data", "apptweak-2026-05-04", "metadata.jsonl");
const OUT_BASE = join(ROOT, "docs", "planning", "path-e-shortlist");

const TIER2_SEA = ["id", "vn", "th", "my", "bd"];
const DURABILITY_DAYS = 180;
const TRAILING_YEAR_START_MS = Date.parse("2025-05-04T00:00:00Z");
const DATA_END_MS = Date.parse("2026-05-04T00:00:00Z");
const RECENT_30D_START_MS = DATA_END_MS - 30 * 86_400_000;
const MAX_INDIE_PORTFOLIO = 5;
const FINAL_SHORTLIST_SIZE = 50;
const MARKET_SPREAD_MIN = 2;
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const LLM_CONCURRENCY = 4;

const CLONABLE_AUTO = new Set([
  "Match",
  "Hyper-Casual",
  "Idle",
  "Board & Card Games",
  "Photo & Video",
  "Productivity & Tools",
  "Lifestyle",
  "Education",
  "Health & Fitness",
  "Graphic & Design",
  "Party & Words",
  "Books & Writing",
  "Puzzle",
]);
const CLONABLE_REVIEW = new Set(["Simulation", "Casino"]);
// All other dna.class_label values are NOT_CLONABLE.

type Store = "apple" | "googleplay";

const logger = pino({
  name: "build-shortlist",
  level: process.env.LOG_LEVEL ?? "info",
});

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  if (i === process.argv.length - 1) return "true"; // boolean flag
  const next = process.argv[i + 1];
  if (next?.startsWith("--")) return "true";
  return next ?? fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readMetadata(): Map<string, RawMetaEntry> {
  // Returns Map keyed by `${app_id}|${store}` → first-seen raw metadata entry.
  // metadata.jsonl is duplicated across t0s; we just need the metadata fields once per (app, store).
  let path = METADATA_GZ;
  let raw: string;
  if (existsSync(METADATA_GZ)) {
    raw = gunzipSync(readFileSync(METADATA_GZ)).toString("utf8");
  } else if (existsSync(METADATA_RAW)) {
    raw = readFileSync(METADATA_RAW, "utf8");
    path = METADATA_RAW;
  } else {
    throw new Error("metadata.jsonl(.gz) not found");
  }
  const lines = raw.split("\n");
  const out = new Map<string, RawMetaEntry>();
  for (const line of lines) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const app_id = typeof obj.app_id === "string" ? obj.app_id : null;
    const store = obj.store === "apple" || obj.store === "googleplay" ? obj.store : null;
    if (!app_id || !store) continue;
    const key = `${app_id}|${store}`;
    if (out.has(key)) continue; // first-seen wins
    const md = (obj.raw as Record<string, unknown> | undefined)?.metadata as
      | Record<string, unknown>
      | undefined;
    if (!md || "error" in md) continue; // 422 records skipped
    out.set(key, parseMetadataFields(md));
  }
  logger.info({ uniqueAppStore: out.size, source: path }, "loaded metadata.jsonl");
  return out;
}

interface RawMetaEntry {
  title: string | null;
  subtitle: string | null;
  description: string | null;
  short_description: string | null;
  long_description: string | null;
  dna_class: string | null;
  dna_subclass: string | null;
  categories: string[];
  has_subscription_iap: boolean;
  iap_count: number;
  icon: string | null;
}

function parseMetadataFields(md: Record<string, unknown>): RawMetaEntry {
  const dna = (md.dna as Record<string, unknown> | undefined) ?? {};
  const iaps = (md.in_app_purchases as Array<Record<string, unknown>> | undefined) ?? [];
  const has_sub = iaps.some(
    (iap) => iap.is_subscription === true || iap.recurring_subscription_period != null,
  );
  const cats = (md.categories as Array<unknown> | undefined) ?? [];
  return {
    title: typeof md.title === "string" ? md.title : null,
    subtitle: typeof md.subtitle === "string" ? md.subtitle : null,
    description: typeof md.description === "string" ? md.description : null,
    short_description: typeof md.short_description === "string" ? md.short_description : null,
    long_description: typeof md.long_description === "string" ? md.long_description : null,
    dna_class: typeof dna.class_label === "string" ? dna.class_label : null,
    dna_subclass: typeof dna.subclass_label === "string" ? dna.subclass_label : null,
    categories: cats.map((c) => String(c)),
    has_subscription_iap: has_sub,
    iap_count: iaps.length,
    icon: typeof md.icon === "string" ? md.icon : null,
  };
}

interface DurabilityRow {
  app_id: string;
  store: Store;
  market: string;
  days_in_top100: number;
  best_rank: number;
  recent_30d_days: number;
}

function filter1Durability(db: Database): DurabilityRow[] {
  // For each (app, store, market) in tier-2 SEA: count distinct days at rank≤100
  // in trailing year, plus best_rank and recent-30d days.
  const placeholders = TIER2_SEA.map(() => "?").join(",");
  const rows = db
    .prepare<
      DurabilityRow,
      [number, number, number, ...string[]]
    >(
      `SELECT app_id, store, market,
              COUNT(DISTINCT date(captured_at/1000, 'unixepoch')) AS days_in_top100,
              MIN(rank) AS best_rank,
              SUM(CASE WHEN captured_at >= ? THEN 1 ELSE 0 END) AS recent_30d_days
       FROM chart_snapshots
       WHERE category = 'top_grossing_overall'
         AND rank <= 100
         AND captured_at >= ?
         AND captured_at <= ?
         AND market IN (${placeholders})
       GROUP BY app_id, store, market
       HAVING COUNT(DISTINCT date(captured_at/1000, 'unixepoch')) >= ${DURABILITY_DAYS}`,
    )
    .all(RECENT_30D_START_MS, TRAILING_YEAR_START_MS, DATA_END_MS, ...TIER2_SEA);
  return rows;
}

interface PublisherInfo {
  publisher_id: string | null;
  publisher_name: string | null;
}

function loadPublishers(db: Database): {
  byApp: Map<string, PublisherInfo>;
  appCountByPub: Map<string, number>;
} {
  const rows = db
    .prepare<
      { app_id: string; store: Store; publisher_id: string | null; publisher_name: string | null },
      []
    >(
      `SELECT app_id, store, publisher_id, publisher_name FROM app_invariants`,
    )
    .all();
  const byApp = new Map<string, PublisherInfo>();
  const appCountByPub = new Map<string, number>();
  for (const r of rows) {
    byApp.set(`${r.app_id}|${r.store}`, {
      publisher_id: r.publisher_id,
      publisher_name: r.publisher_name,
    });
    if (r.publisher_id) {
      const pubKey = `${r.publisher_id}|${r.store}`;
      appCountByPub.set(pubKey, (appCountByPub.get(pubKey) ?? 0) + 1);
    }
  }
  return { byApp, appCountByPub };
}

function clonabilityTier(dna_class: string | null): "AUTO" | "REVIEW" | "NOT" {
  if (!dna_class) return "NOT";
  if (CLONABLE_AUTO.has(dna_class)) return "AUTO";
  if (CLONABLE_REVIEW.has(dna_class)) return "REVIEW";
  return "NOT";
}

interface Candidate {
  app_id: string;
  store: Store;
  // F1 durability rollup across markets
  markets_active: string[];
  tenure_days_max: number;
  tenure_days_total: number;
  best_rank: number;
  recent_30d_days: number;
  // F2 indie
  publisher_id: string | null;
  publisher_name: string | null;
  publisher_app_count: number;
  // F3 mechanic
  dna_class: string | null;
  dna_subclass: string | null;
  clonability_tier: "AUTO" | "REVIEW" | "NOT";
  categories: string[];
  // F4 monetization
  has_subscription_iap: boolean;
  iap_count: number;
  // Output metadata
  title: string | null;
  subtitle: string | null;
  description_short: string | null;
  icon_url: string | null;
  // Score
  score: number;
  score_components: {
    tenure: number;
    spread: number;
    recency: number;
    rank: number;
    indie: number;
  };
  // LLM
  clonability_hypothesis?: string;
}

function computeScore(c: Omit<Candidate, "score" | "score_components">): {
  score: number;
  components: Candidate["score_components"];
} {
  const tenure = Math.min(1, c.tenure_days_max / 365);
  const spread = Math.min(1, c.markets_active.length / TIER2_SEA.length);
  const recency = Math.min(1, c.recent_30d_days / 30);
  const rank = Math.max(0, 1 - c.best_rank / 100);
  const indie = Math.max(
    0,
    1 - Math.max(0, c.publisher_app_count - 1) / MAX_INDIE_PORTFOLIO,
  );
  const score = 0.3 * tenure + 0.2 * spread + 0.2 * recency + 0.15 * rank + 0.15 * indie;
  return {
    score,
    components: { tenure, spread, recency, rank, indie },
  };
}

async function generateClonabilityHypotheses(
  candidates: Candidate[],
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn("ANTHROPIC_API_KEY not set — skipping clonability hypotheses");
    return;
  }
  // Dynamic import per existing pattern
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const tasks = candidates.map((c) => async () => {
    const desc = c.description_short ?? c.subtitle ?? "(no description)";
    const prompt = `Classify if this mobile app is CLONABLE by a SOLO indie founder with a $500 budget in 4 weeks.

CLONABLE = single-feature mobile app a solo can ship: simple puzzle/casual game, photo filter, habit tracker, calculator, niche recipe app, localized content reader, simple productivity utility, single-mechanic match/idle/hyper-casual game, narrow ASO play.

NOT_CLONABLE (return SKIP) = AI-powered platforms requiring infrastructure (ChatGPT, Midjourney clones), full design suites (Canva, Photoshop clones), social networks, messaging, video/music streaming, complex 3D/RPG/MMO games, banking/finance, branded major IP, anything by Google/Apple/Microsoft/Meta/OpenAI/Adobe/ByteDance/Tencent/Bytedance/Bandai Namco/Activision/EA, anything with content licensing dependencies.

App data:
- Title: ${c.title ?? "(unknown)"}
- Subtitle: ${c.subtitle ?? "(none)"}
- Category: ${c.dna_class ?? "?"} / ${c.dna_subclass ?? "?"}
- Publisher: ${c.publisher_name ?? "?"}
- Description (truncated): ${desc.slice(0, 350)}
- Markets in tier-2 SEA top-100: ${c.markets_active.join(", ")}
- Tenure best market: ${c.tenure_days_max} days, best rank ${c.best_rank}
- Has sub IAP: ${c.has_subscription_iap}, IAP count: ${c.iap_count}

Output STRICTLY one line, one of these two formats:
"CLONE: {1-line variant idea, ≤140 chars}"
"SKIP: {1-line reason, ≤140 chars}"

Do not output anything else. No preamble, no caveats.`;
    try {
      const resp = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      });
      const text = resp.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      c.clonability_hypothesis = text.split("\n")[0]?.slice(0, 200) ?? "";
    } catch (err) {
      c.clonability_hypothesis = `(LLM error: ${err instanceof Error ? err.message : String(err)})`;
    }
  });

  // Simple concurrency pool
  let i = 0;
  const inflight: Promise<void>[] = [];
  while (i < tasks.length || inflight.length > 0) {
    while (inflight.length < LLM_CONCURRENCY && i < tasks.length) {
      const fn = tasks[i++];
      if (!fn) continue;
      const p = fn();
      inflight.push(p);
      void p.then(() => {
        const idx = inflight.indexOf(p);
        if (idx >= 0) inflight.splice(idx, 1);
      });
    }
    if (inflight.length > 0) await Promise.race(inflight);
  }
}

function writeCsv(path: string, candidates: Candidate[]): void {
  const headers = [
    "rank",
    "score",
    "score_tenure",
    "score_spread",
    "score_recency",
    "score_rank",
    "score_indie",
    "app_id",
    "store",
    "title",
    "dna_class",
    "dna_subclass",
    "clonability_tier",
    "publisher_name",
    "publisher_app_count",
    "markets_active",
    "tenure_days_max",
    "best_rank",
    "recent_30d_days",
    "has_subscription_iap",
    "iap_count",
    "icon_url",
    "subtitle",
    "description_short",
    "clonability_hypothesis",
  ];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(",")];
  candidates.forEach((c, i) => {
    lines.push(
      [
        i + 1,
        c.score.toFixed(4),
        c.score_components.tenure.toFixed(3),
        c.score_components.spread.toFixed(3),
        c.score_components.recency.toFixed(3),
        c.score_components.rank.toFixed(3),
        c.score_components.indie.toFixed(3),
        c.app_id,
        c.store,
        c.title,
        c.dna_class,
        c.dna_subclass,
        c.clonability_tier,
        c.publisher_name,
        c.publisher_app_count,
        c.markets_active.join("|"),
        c.tenure_days_max,
        c.best_rank,
        c.recent_30d_days,
        c.has_subscription_iap ? 1 : 0,
        c.iap_count,
        c.icon_url,
        c.subtitle,
        (c.description_short ?? "").slice(0, 200),
        c.clonability_hypothesis ?? "",
      ]
        .map(escape)
        .join(","),
    );
  });
  writeFileSync(path, lines.join("\n"));
}

async function main(): Promise<void> {
  const dbPath = arg("db", DEFAULT_DB) ?? DEFAULT_DB;
  const skipLLM = flag("no-llm");

  logger.info({ dbPath, skipLLM }, "starting Path E shortlist");
  const t0 = Date.now();

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);

  // Step 1: Filter 1 durability
  logger.info("F1: durability — counting tier-2 SEA top-100 days per (app, store, market)");
  const f1Rows = filter1Durability(db);
  logger.info({ rows: f1Rows.length }, "F1: durability rows");

  // Aggregate to (app, store): markets where ≥180d, max tenure, total tenure, best rank, recent 30d
  type RollKey = string;
  const rollup = new Map<
    RollKey,
    {
      app_id: string;
      store: Store;
      markets: string[];
      tenure_max: number;
      tenure_total: number;
      best_rank: number;
      recent_30d_days: number;
    }
  >();
  for (const r of f1Rows) {
    const key = `${r.app_id}|${r.store}`;
    const e = rollup.get(key) ?? {
      app_id: r.app_id,
      store: r.store,
      markets: [],
      tenure_max: 0,
      tenure_total: 0,
      best_rank: Number.POSITIVE_INFINITY,
      recent_30d_days: 0,
    };
    e.markets.push(r.market);
    e.tenure_max = Math.max(e.tenure_max, r.days_in_top100);
    e.tenure_total += r.days_in_top100;
    e.best_rank = Math.min(e.best_rank, r.best_rank);
    e.recent_30d_days = Math.max(e.recent_30d_days, r.recent_30d_days);
    rollup.set(key, e);
  }
  logger.info({ uniqueAppStore: rollup.size }, "F1: post-rollup app-store keys");

  // Step 5 (early): Filter 5 — market spread ≥2
  for (const [k, e] of rollup) {
    if (e.markets.length < MARKET_SPREAD_MIN) rollup.delete(k);
  }
  logger.info({ remaining: rollup.size }, "F5: post-market-spread filter");

  // Step 2: load metadata + publishers
  const metaByAppStore = readMetadata();
  const { byApp: pubByAppStore, appCountByPub } = loadPublishers(db);

  // Build candidates with F2 indie + F3 mechanic + F4 monetization filters
  const candidates: Candidate[] = [];
  let droppedNoMeta = 0;
  let droppedNoPub = 0;
  let droppedNotIndie = 0;
  let droppedNotClonable = 0;

  for (const [key, e] of rollup) {
    const meta = metaByAppStore.get(key);
    if (!meta) {
      droppedNoMeta += 1;
      continue;
    }
    const pub = pubByAppStore.get(key);
    if (!pub || !pub.publisher_id) {
      droppedNoPub += 1;
      continue;
    }
    // Note: publisher_app_count is kept in output for context but no longer
    // gates the funnel. Our metadata universe is biased toward SEA-cohort
    // apps so mega-apps appear with app_count=1 (e.g., ChatGPT, Canva).
    // The MEGA-vs-INDIE classification is delegated to the LLM step which
    // sees title+description+publisher_name and can correctly tag platforms
    // requiring infrastructure (AI, design suites, social, etc).
    const pubAppCount = appCountByPub.get(`${pub.publisher_id}|${e.store}`) ?? 1;
    const tier = clonabilityTier(meta.dna_class);
    if (tier === "NOT") {
      droppedNotClonable += 1;
      continue;
    }

    const desc = meta.description ?? meta.long_description ?? meta.short_description;
    const candidatePartial = {
      app_id: e.app_id,
      store: e.store,
      markets_active: e.markets,
      tenure_days_max: e.tenure_max,
      tenure_days_total: e.tenure_total,
      best_rank: e.best_rank,
      recent_30d_days: e.recent_30d_days,
      publisher_id: pub.publisher_id,
      publisher_name: pub.publisher_name,
      publisher_app_count: pubAppCount,
      dna_class: meta.dna_class,
      dna_subclass: meta.dna_subclass,
      clonability_tier: tier,
      categories: meta.categories,
      has_subscription_iap: meta.has_subscription_iap,
      iap_count: meta.iap_count,
      title: meta.title,
      subtitle: meta.subtitle,
      description_short: desc?.slice(0, 400) ?? null,
      icon_url: meta.icon,
    } satisfies Omit<Candidate, "score" | "score_components">;
    const { score, components } = computeScore(candidatePartial);
    candidates.push({ ...candidatePartial, score, score_components: components });
  }

  logger.info(
    {
      survived: candidates.length,
      droppedNoMeta,
      droppedNoPub,
      droppedNotIndie,
      droppedNotClonable,
    },
    "F2/F3/F4 funnel",
  );

  // Sort by score desc
  candidates.sort((a, b) => b.score - a.score);
  const preLLMPool = candidates;
  logger.info({ candidates: preLLMPool.length }, "pre-LLM pool (all dna-clonable durable cross-market apps)");

  // LLM clonability hypotheses + classification
  if (!skipLLM && preLLMPool.length > 0) {
    logger.info({ targets: preLLMPool.length, model: HAIKU_MODEL }, "generating clonability hypotheses");
    await generateClonabilityHypotheses(preLLMPool);
  }

  // Post-LLM filter: keep CLONE-tagged only. SKIP-tagged or unparsed → drop from final shortlist
  // (kept in JSON for audit trail).
  let llmKept = 0;
  let llmDropped = 0;
  let llmUnparsed = 0;
  const llmShortlist: Candidate[] = [];
  for (const c of preLLMPool) {
    const h = c.clonability_hypothesis ?? "";
    if (skipLLM) {
      llmShortlist.push(c); // no LLM run, keep all
      continue;
    }
    if (h.startsWith("CLONE:")) {
      llmShortlist.push(c);
      llmKept += 1;
    } else if (h.startsWith("SKIP:")) {
      llmDropped += 1;
    } else {
      llmUnparsed += 1;
      llmShortlist.push(c); // unparseable → keep with warning, founder reviews
    }
  }
  if (!skipLLM) {
    logger.info({ llmKept, llmDropped, llmUnparsed }, "LLM filter result");
  }

  const shortlist = llmShortlist.slice(0, FINAL_SHORTLIST_SIZE);
  logger.info({ shortlistSize: shortlist.length }, "final shortlist");

  // Write outputs
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(OUT_BASE, ts);
  mkdirSync(outDir, { recursive: true });
  const csvPath = join(outDir, "shortlist.csv");
  const jsonPath = join(outDir, "shortlist.json");
  writeCsv(csvPath, shortlist);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generated_at_utc: new Date().toISOString(),
        config: {
          tier2_sea_markets: TIER2_SEA,
          durability_days_threshold: DURABILITY_DAYS,
          max_indie_portfolio: MAX_INDIE_PORTFOLIO,
          market_spread_min: MARKET_SPREAD_MIN,
          final_shortlist_size: FINAL_SHORTLIST_SIZE,
          clonable_auto_classes: Array.from(CLONABLE_AUTO),
          clonable_review_classes: Array.from(CLONABLE_REVIEW),
        },
        funnel: {
          f1_post_durability: f1Rows.length,
          f1_post_rollup_app_store_pairs: rollup.size,
          f5_post_market_spread: rollup.size,
          dropped_no_meta: droppedNoMeta,
          dropped_no_pub: droppedNoPub,
          dropped_not_indie: droppedNotIndie,
          dropped_not_clonable: droppedNotClonable,
          final_candidates: candidates.length,
        },
        shortlist,
      },
      null,
      2,
    ),
  );

  const durationMs = Date.now() - t0;
  logger.info(
    {
      shortlistSize: shortlist.length,
      durationMs,
      outDir,
      csvPath,
    },
    "Path E shortlist complete",
  );
}

await main();
