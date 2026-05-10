/**
 * Path E — winning-path shortlist pipeline (Stage 2 of Runbook-Discovery).
 *
 * Founder directive: stop predict-the-future, start identify-the-takeable.
 * The empirical Path C verdict (K3) confirmed F0 saturates at 99-100% precision
 * on top-decile retention. So the right operator move is NOT to build a ranker
 * but to build a SHORTLIST: 30-50 apps that are durable winners + clonable for
 * a solo founder at a small validation budget.
 *
 * Pipeline (5 sequential filters):
 *   F1 DURABILITY: ≥180 days at rank ≤ 100 in ≥1 tier-2 SEA market in trailing year
 *   F2 INDIE: publisher_app_count is recorded (no longer gates — see note below)
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
 * Top N → optional LLM Haiku one-line clonability hypothesis. Post-LLM filter
 * keeps CLONE-tagged candidates only; SKIP-tagged drop from the final
 * shortlist (still recorded in the funnel JSON for audit).
 *
 * The function returns a structured result the CLI can format/log. File I/O
 * (CSV + JSON) is OPTIONAL — set `outputDir` to write artifacts; otherwise
 * the result object is the only output.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import pino from "pino";
import { runMigrations } from "../storage/schema.ts";
import { resolveMetadataPath } from "./metadata-path.ts";

export const DEFAULT_TIER2_SEA = ["id", "vn", "th", "my", "bd"] as const;
export const DEFAULT_DURABILITY_DAYS = 180;
export const DEFAULT_DATA_END_ISO = "2026-05-04T00:00:00Z";
export const DEFAULT_TRAILING_YEAR_START_ISO = "2025-05-04T00:00:00Z";
export const DEFAULT_MAX_INDIE_PORTFOLIO = 5;
export const DEFAULT_FINAL_SHORTLIST_SIZE = 50;
export const DEFAULT_MARKET_SPREAD_MIN = 2;
export const DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_LLM_CONCURRENCY = 4;

export const CLONABLE_AUTO = new Set([
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
export const CLONABLE_REVIEW = new Set(["Simulation", "Casino"]);
// All other dna.class_label values are NOT_CLONABLE.

export type Store = "apple" | "googleplay";

/** Pluggable LLM client — accepts a prompt, returns the raw classification text. */
export interface LlmClient {
  classify(prompt: string): Promise<string>;
}

export interface ShortlistOpts {
  /** Path to the sqlite cache. Defaults to ./.cache/selection-agent.sqlite. */
  dbPath?: string;
  /** Markets to evaluate (ISO alpha-2). Defaults to tier-2 SEA cluster. */
  markets?: readonly string[];
  /** Path to metadata.jsonl[.gz]. If omitted, glob data/apptweak-*. */
  metadataPath?: string;
  /** Root directory for the metadata glob fallback. Defaults to process.cwd(). */
  dataRoot?: string;
  /** Min days at rank≤100 in trailing year for F1 durability. Default 180. */
  durabilityDays?: number;
  /** Min number of markets a candidate must appear in for F5. Default 2. */
  marketSpreadMin?: number;
  /** Final shortlist size (truncation cap). Default 50. */
  finalShortlistSize?: number;
  /** When true, skip the LLM clonability classifier entirely. */
  skipLLM?: boolean;
  /** Pluggable LLM client. Required when !skipLLM. */
  llmClient?: LlmClient;
  /** Concurrency for the LLM classifier pool. Default 4. */
  llmConcurrency?: number;
  /** When set, write shortlist.csv + shortlist.json under this directory. */
  outputDir?: string;
  /** Override "now" for output-path timestamps (test seam). */
  now?: number;
  /** Override the data-window end (test seam). Defaults to 2026-05-04. */
  dataEndMs?: number;
  /** Override the trailing-year start (test seam). Defaults to 2025-05-04. */
  trailingYearStartMs?: number;
  /** Suppress logger output (used by tests). */
  silent?: boolean;
}

export interface FunnelCounts {
  f1_post_durability: number;
  f1_post_rollup_app_store_pairs: number;
  f5_post_market_spread: number;
  dropped_no_meta: number;
  dropped_no_pub: number;
  dropped_not_indie: number;
  dropped_not_clonable: number;
  final_candidates: number;
  llm_kept: number;
  llm_dropped: number;
  llm_unparsed: number;
}

export interface Candidate {
  app_id: string;
  store: Store;
  markets_active: string[];
  tenure_days_max: number;
  tenure_days_total: number;
  best_rank: number;
  recent_30d_days: number;
  publisher_id: string | null;
  publisher_name: string | null;
  publisher_app_count: number;
  dna_class: string | null;
  dna_subclass: string | null;
  clonability_tier: "AUTO" | "REVIEW" | "NOT";
  categories: string[];
  has_subscription_iap: boolean;
  iap_count: number;
  title: string | null;
  subtitle: string | null;
  description_short: string | null;
  icon_url: string | null;
  score: number;
  score_components: {
    tenure: number;
    spread: number;
    recency: number;
    rank: number;
    indie: number;
  };
  clonability_hypothesis?: string;
}

export interface ShortlistResult {
  shortlist: Candidate[];
  /** Pre-truncation candidate pool — useful for diagnostics. */
  candidates: Candidate[];
  funnel: FunnelCounts;
  config: {
    markets: readonly string[];
    durability_days_threshold: number;
    market_spread_min: number;
    final_shortlist_size: number;
    skipped_llm: boolean;
  };
  /** When `outputDir` was provided, the resolved csv path. */
  csvPath?: string;
  /** When `outputDir` was provided, the resolved json path. */
  jsonPath?: string;
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

interface DurabilityRow {
  app_id: string;
  store: Store;
  market: string;
  days_in_top100: number;
  best_rank: number;
  recent_30d_days: number;
}

/**
 * Read metadata.jsonl[.gz] and return a Map keyed by `${app_id}|${store}`.
 *
 * The file is duplicated across t0 dossiers; we keep the first-seen entry
 * per (app_id, store). Returns an empty Map when no file is present so the
 * caller can record `dropped_no_meta` cleanly.
 */
function readMetadata(path: string | null): Map<string, RawMetaEntry> {
  const out = new Map<string, RawMetaEntry>();
  if (!path || !existsSync(path)) return out;
  const raw = path.endsWith(".gz")
    ? gunzipSync(readFileSync(path)).toString("utf8")
    : readFileSync(path, "utf8");
  const lines = raw.split("\n");
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
    if (out.has(key)) continue;
    const md = (obj.raw as Record<string, unknown> | undefined)?.metadata as
      | Record<string, unknown>
      | undefined;
    if (!md || "error" in md) continue;
    out.set(key, parseMetadataFields(md));
  }
  return out;
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

function filter1Durability(
  db: Database,
  markets: readonly string[],
  durabilityDays: number,
  trailingYearStartMs: number,
  dataEndMs: number,
  recent30dStartMs: number,
): DurabilityRow[] {
  if (markets.length === 0) return [];
  const placeholders = markets.map(() => "?").join(",");
  return db
    .prepare<DurabilityRow, [number, number, number, ...string[]]>(
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
       HAVING COUNT(DISTINCT date(captured_at/1000, 'unixepoch')) >= ${durabilityDays}`,
    )
    .all(recent30dStartMs, trailingYearStartMs, dataEndMs, ...markets);
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
    >(`SELECT app_id, store, publisher_id, publisher_name FROM app_invariants`)
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

function computeScore(
  c: Omit<Candidate, "score" | "score_components">,
  totalMarkets: number,
): { score: number; components: Candidate["score_components"] } {
  const tenure = Math.min(1, c.tenure_days_max / 365);
  const spread = Math.min(1, c.markets_active.length / Math.max(totalMarkets, 1));
  const recency = Math.min(1, c.recent_30d_days / 30);
  const rank = Math.max(0, 1 - c.best_rank / 100);
  const indie = Math.max(
    0,
    1 - Math.max(0, c.publisher_app_count - 1) / DEFAULT_MAX_INDIE_PORTFOLIO,
  );
  const score = 0.3 * tenure + 0.2 * spread + 0.2 * recency + 0.15 * rank + 0.15 * indie;
  return { score, components: { tenure, spread, recency, rank, indie } };
}

function buildClonabilityPrompt(c: Candidate): string {
  const desc = c.description_short ?? c.subtitle ?? "(no description)";
  return `Classify if this mobile app is CLONABLE by a SOLO indie founder with a small budget in 4 weeks.

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
}

async function runLlmClassifier(
  candidates: Candidate[],
  client: LlmClient,
  concurrency: number,
): Promise<void> {
  const tasks = candidates.map((c) => async () => {
    try {
      const text = await client.classify(buildClonabilityPrompt(c));
      c.clonability_hypothesis = text.trim().split("\n")[0]?.slice(0, 200) ?? "";
    } catch (err) {
      c.clonability_hypothesis = `(LLM error: ${err instanceof Error ? err.message : String(err)})`;
    }
  });
  let i = 0;
  const inflight: Promise<void>[] = [];
  while (i < tasks.length || inflight.length > 0) {
    while (inflight.length < concurrency && i < tasks.length) {
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

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function renderCsv(candidates: Candidate[]): string {
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
        .map(csvEscape)
        .join(","),
    );
  });
  return lines.join("\n");
}

/**
 * Run the Path E shortlist pipeline.
 *
 * Pure-ish: side effects are limited to logging, an optional CSV/JSON write
 * (only when `outputDir` is set), and the LLM call (when !skipLLM and a
 * client is provided). Returns a structured result the CLI can format.
 */
export async function buildShortlist(opts: ShortlistOpts = {}): Promise<ShortlistResult> {
  const dbPath = opts.dbPath ?? "./.cache/selection-agent.sqlite";
  const markets = opts.markets ?? DEFAULT_TIER2_SEA;
  const durabilityDays = opts.durabilityDays ?? DEFAULT_DURABILITY_DAYS;
  const marketSpreadMin = opts.marketSpreadMin ?? DEFAULT_MARKET_SPREAD_MIN;
  const finalShortlistSize = opts.finalShortlistSize ?? DEFAULT_FINAL_SHORTLIST_SIZE;
  const skipLLM = opts.skipLLM === true;
  const llmConcurrency = opts.llmConcurrency ?? DEFAULT_LLM_CONCURRENCY;
  const dataEndMs = opts.dataEndMs ?? Date.parse(DEFAULT_DATA_END_ISO);
  const trailingYearStartMs =
    opts.trailingYearStartMs ?? Date.parse(DEFAULT_TRAILING_YEAR_START_ISO);
  const recent30dStartMs = dataEndMs - 30 * 86_400_000;
  const now = opts.now ?? Date.now();
  const logger = pino({
    name: "build-shortlist",
    level: opts.silent ? "silent" : (process.env.LOG_LEVEL ?? "info"),
  });

  if (!skipLLM && !opts.llmClient) {
    throw new Error("buildShortlist: llmClient is required when skipLLM is false");
  }

  if (!existsSync(dbPath)) {
    throw new Error(`buildShortlist: database not found at ${dbPath}`);
  }

  logger.info({ dbPath, markets, skipLLM }, "starting Path E shortlist");
  const t0 = Date.now();

  const db = new Database(dbPath);
  try {
    runMigrations(db);

    // F1 — durability
    const f1Rows = filter1Durability(
      db,
      markets,
      durabilityDays,
      trailingYearStartMs,
      dataEndMs,
      recent30dStartMs,
    );
    logger.info({ rows: f1Rows.length }, "F1: durability rows");

    // Aggregate to (app, store) rollup
    const rollup = new Map<
      string,
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
    const f1RollupSize = rollup.size;
    logger.info({ uniqueAppStore: f1RollupSize }, "F1: post-rollup app-store keys");

    // F5 — market spread filter
    for (const [k, e] of rollup) {
      if (e.markets.length < marketSpreadMin) rollup.delete(k);
    }
    const f5Size = rollup.size;
    logger.info({ remaining: f5Size }, "F5: post-market-spread filter");

    // F2 + F3 + F4 join — metadata + publishers
    const metaPath = resolveMetadataPath({
      metadataPath: opts.metadataPath,
      dataRoot: opts.dataRoot,
    });
    const metaByAppStore = readMetadata(metaPath);
    if (metaPath) {
      logger.info(
        { uniqueAppStore: metaByAppStore.size, source: metaPath },
        "loaded metadata.jsonl",
      );
    } else {
      logger.warn("metadata.jsonl not found — every survivor will be dropped as no-meta");
    }
    const { byApp: pubByAppStore, appCountByPub } = loadPublishers(db);

    const candidates: Candidate[] = [];
    let droppedNoMeta = 0;
    let droppedNoPub = 0;
    const droppedNotIndie = 0; // retained for funnel-shape compatibility
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
      const pubAppCount = appCountByPub.get(`${pub.publisher_id}|${e.store}`) ?? 1;
      const tier = clonabilityTier(meta.dna_class);
      if (tier === "NOT") {
        droppedNotClonable += 1;
        continue;
      }

      const desc = meta.description ?? meta.long_description ?? meta.short_description;
      const partial = {
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
      const { score, components } = computeScore(partial, markets.length);
      candidates.push({ ...partial, score, score_components: components });
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

    candidates.sort((a, b) => b.score - a.score);

    // LLM classifier (optional)
    let llmKept = 0;
    let llmDropped = 0;
    let llmUnparsed = 0;
    if (!skipLLM && candidates.length > 0 && opts.llmClient) {
      logger.info({ targets: candidates.length }, "running LLM clonability classifier");
      await runLlmClassifier(candidates, opts.llmClient, llmConcurrency);
    }

    const filtered: Candidate[] = [];
    for (const c of candidates) {
      const h = c.clonability_hypothesis ?? "";
      if (skipLLM) {
        filtered.push(c);
        continue;
      }
      if (h.startsWith("CLONE:")) {
        filtered.push(c);
        llmKept += 1;
      } else if (h.startsWith("SKIP:")) {
        llmDropped += 1;
      } else {
        llmUnparsed += 1;
        filtered.push(c);
      }
    }
    if (!skipLLM) {
      logger.info({ llmKept, llmDropped, llmUnparsed }, "LLM filter result");
    }

    const shortlist = filtered.slice(0, finalShortlistSize);
    logger.info({ shortlistSize: shortlist.length }, "final shortlist");

    const funnel: FunnelCounts = {
      f1_post_durability: f1Rows.length,
      f1_post_rollup_app_store_pairs: f1RollupSize,
      f5_post_market_spread: f5Size,
      dropped_no_meta: droppedNoMeta,
      dropped_no_pub: droppedNoPub,
      dropped_not_indie: droppedNotIndie,
      dropped_not_clonable: droppedNotClonable,
      final_candidates: candidates.length,
      llm_kept: llmKept,
      llm_dropped: llmDropped,
      llm_unparsed: llmUnparsed,
    };

    const result: ShortlistResult = {
      shortlist,
      candidates,
      funnel,
      config: {
        markets,
        durability_days_threshold: durabilityDays,
        market_spread_min: marketSpreadMin,
        final_shortlist_size: finalShortlistSize,
        skipped_llm: skipLLM,
      },
    };

    if (opts.outputDir) {
      const ts = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const outDir = join(opts.outputDir, ts);
      mkdirSync(outDir, { recursive: true });
      const csvPath = join(outDir, "shortlist.csv");
      const jsonPath = join(outDir, "shortlist.json");
      writeFileSync(csvPath, renderCsv(shortlist), "utf8");
      writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            generated_at_utc: new Date(now).toISOString(),
            config: {
              tier2_sea_markets: markets,
              durability_days_threshold: durabilityDays,
              max_indie_portfolio: DEFAULT_MAX_INDIE_PORTFOLIO,
              market_spread_min: marketSpreadMin,
              final_shortlist_size: finalShortlistSize,
              clonable_auto_classes: Array.from(CLONABLE_AUTO),
              clonable_review_classes: Array.from(CLONABLE_REVIEW),
              skipped_llm: skipLLM,
            },
            funnel,
            shortlist,
          },
          null,
          2,
        ),
        "utf8",
      );
      result.csvPath = csvPath;
      result.jsonPath = jsonPath;
    }

    const durationMs = Date.now() - t0;
    logger.info({ shortlistSize: shortlist.length, durationMs }, "Path E shortlist complete");
    return result;
  } finally {
    db.close();
  }
}

/**
 * Build a default LLM client backed by the Anthropic SDK.
 *
 * Lazy-imports `@anthropic-ai/sdk` so consumers running with `--no-llm` don't
 * pay the startup cost. Throws if `ANTHROPIC_API_KEY` is unset.
 */
export async function defaultAnthropicLlmClient(opts: {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}): Promise<LlmClient> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the LLM clonability classifier");
  }
  const model = opts.model ?? DEFAULT_HAIKU_MODEL;
  const maxTokens = opts.maxTokens ?? 200;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  return {
    async classify(prompt: string): Promise<string> {
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      return resp.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
    },
  };
}
