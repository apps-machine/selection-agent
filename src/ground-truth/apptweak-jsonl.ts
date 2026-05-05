/**
 * AppTweak enrichment JSONL reader — metadata + metrics.
 *
 * `data/apptweak-2026-05-04/metadata.jsonl` and `metrics.jsonl` carry
 * per-(app_id, market, store, t0) localized metadata + ratings/app-power
 * snapshots. The locGap LLM judge reads metadata; incumbent_vulnerability
 * (chart-stability fallback path) does not need either, but for completeness
 * we also expose metrics.
 *
 * Why streaming-and-indexing instead of importing into SQLite:
 *   - Judge iterates the records once and persists each result to
 *     signal_snapshots (the durable signal cache). Putting metadata + metrics
 *     in their own tables adds two migrations + queries with no downstream
 *     query payoff — every consumer is a one-shot scan.
 *   - The full enrichment is small (~85 MB metadata, ~2 MB metrics, ~6k
 *     records) and fits in memory comfortably.
 *   - The JSONL files are append-only artefacts of the pull scripts; the
 *     filesystem IS our source of truth here, not SQLite.
 *
 * Shapes (mirror what `pull-enrichment.ts` writes):
 *
 *   metadata: {
 *     app_id, market, store, device, language, t0,
 *     raw: { metadata: { title, subtitle, description, ... }, ... }
 *   }
 *
 *   metrics: {
 *     app_id, market, store, device, t0,
 *     raw: { ratings: [{value, breakdown, date}], "app-power": [{value, date}] }
 *   }
 *
 * t0 is the `YYYY-MM-DD` string AppTweak was queried at; the reader
 * normalizes to unix-ms UTC midnight so downstream code works in epoch ms.
 *
 * 422 ValidationError rows: AppTweak returns 422 when an app doesn't have a
 * localized listing in the requested language. The pull script writes those
 * rows with `raw: { error: "ValidationError", ... }`. The reader exposes
 * them as records with `metadata = null` so the locGap judge can treat
 * "no localized listing" as locGap=10 (max opportunity).
 */

import { existsSync, readFileSync } from "node:fs";
import pino from "pino";

const logger = pino({
  name: "apptweak-jsonl",
  level: process.env.LOG_LEVEL ?? "info",
});

export type AppTweakStore = "apple" | "googleplay";
export type AppTweakDevice = "iphone" | "android";

/**
 * One metadata record per (app_id, market, store, t0). `metadata` is null
 * when the underlying API response was a 422 (no localized listing).
 */
export interface AppTweakMetadataRecord {
  app_id: string;
  market: string;
  store: AppTweakStore;
  device: AppTweakDevice;
  /** Target language requested (e.g., "id", "vi", "th", "ms", "bn", "ja", "ko"). May be empty for tier-1 markets that omit the param. */
  language: string;
  /** unix-ms UTC midnight derived from the YYYY-MM-DD t0 string. */
  t0: number;
  metadata: {
    title?: string;
    subtitle?: string | null;
    promotional_text?: string | null;
    description?: string;
    icon?: string;
  } | null;
}

/**
 * One metrics record per (app_id, market, store, t0). `ratings` and
 * `app_power` are null when the API didn't return that field.
 */
export interface AppTweakMetricsRecord {
  app_id: string;
  market: string;
  store: AppTweakStore;
  device: AppTweakDevice;
  t0: number;
  ratings: { total: number; average: number } | null;
  app_power: number | null;
}

/**
 * Composite key string for indexing records: `${app_id}|${market}|${store}|${t0}`.
 * Stable across consumers; using JSON.stringify on the tuple would also work but
 * the simple delimited string is faster and easier to grep in logs.
 */
export function enrichmentKey(rec: {
  app_id: string;
  market: string;
  store: AppTweakStore;
  t0: number;
}): string {
  return `${rec.app_id}|${rec.market}|${rec.store}|${rec.t0}`;
}

/**
 * Parse a YYYY-MM-DD string into unix-ms UTC midnight. Returns null on
 * malformed input.
 */
function parseT0(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  // Accept YYYY-MM-DD; AppTweak's pull scripts always emit this shape.
  const ms = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Read all metadata records from a JSONL file. Each record is parsed
 * independently; malformed lines are logged + skipped, never thrown.
 */
export function readMetadataJsonl(path: string): AppTweakMetadataRecord[] {
  if (!existsSync(path)) {
    throw new Error(`apptweak-jsonl: metadata file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const out: AppTweakMetadataRecord[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const t0 = parseT0(obj.t0);
      const app_id = typeof obj.app_id === "string" ? obj.app_id : null;
      const market = typeof obj.market === "string" ? obj.market : null;
      const store = obj.store === "apple" || obj.store === "googleplay" ? obj.store : null;
      const device = obj.device === "iphone" || obj.device === "android" ? obj.device : null;
      const language = typeof obj.language === "string" ? obj.language : "";
      if (!app_id || !market || !store || !device || t0 === null) {
        logger.warn({ line: i + 1 }, "metadata: missing required field, skipped");
        continue;
      }

      const rawField = obj.raw as Record<string, unknown> | undefined;
      const md = rawField?.metadata as Record<string, unknown> | undefined;
      let metadata: AppTweakMetadataRecord["metadata"] = null;
      if (md && typeof md === "object" && !("error" in md)) {
        metadata = {
          title: typeof md.title === "string" ? md.title : undefined,
          subtitle:
            typeof md.subtitle === "string" ? md.subtitle : md.subtitle === null ? null : undefined,
          promotional_text:
            typeof md.promotional_text === "string"
              ? md.promotional_text
              : md.promotional_text === null
                ? null
                : undefined,
          description: typeof md.description === "string" ? md.description : undefined,
          icon: typeof md.icon === "string" ? md.icon : undefined,
        };
      }

      out.push({ app_id, market, store, device, language, t0, metadata });
    } catch (err) {
      logger.warn(
        { line: i + 1, err: err instanceof Error ? err.message : String(err) },
        "metadata: JSON parse error, skipped",
      );
    }
  }
  return out;
}

/**
 * Read all metrics records from a JSONL file. Same error policy as
 * readMetadataJsonl: malformed lines are skipped + logged.
 */
export function readMetricsJsonl(path: string): AppTweakMetricsRecord[] {
  if (!existsSync(path)) {
    throw new Error(`apptweak-jsonl: metrics file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const out: AppTweakMetricsRecord[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const t0 = parseT0(obj.t0);
      const app_id = typeof obj.app_id === "string" ? obj.app_id : null;
      const market = typeof obj.market === "string" ? obj.market : null;
      const store = obj.store === "apple" || obj.store === "googleplay" ? obj.store : null;
      const device = obj.device === "iphone" || obj.device === "android" ? obj.device : null;
      if (!app_id || !market || !store || !device || t0 === null) {
        logger.warn({ line: i + 1 }, "metrics: missing required field, skipped");
        continue;
      }

      const rawField = obj.raw as Record<string, unknown> | undefined;
      const ratingsArr = rawField?.ratings as unknown[] | undefined;
      const appPowerArr = rawField?.["app-power"] as unknown[] | undefined;

      let ratings: AppTweakMetricsRecord["ratings"] = null;
      if (Array.isArray(ratingsArr) && ratingsArr.length > 0) {
        const head = ratingsArr[0] as Record<string, unknown> | undefined;
        const breakdown = head?.breakdown as Record<string, unknown> | undefined;
        const total = typeof breakdown?.total === "number" ? breakdown.total : null;
        const avg =
          typeof breakdown?.avg === "number"
            ? breakdown.avg
            : typeof head?.value === "number"
              ? head.value
              : null;
        if (total !== null && avg !== null) ratings = { total, average: avg };
      }

      let app_power: number | null = null;
      if (Array.isArray(appPowerArr) && appPowerArr.length > 0) {
        const head = appPowerArr[0] as Record<string, unknown> | undefined;
        if (typeof head?.value === "number") app_power = head.value;
      }

      out.push({ app_id, market, store, device, t0, ratings, app_power });
    } catch (err) {
      logger.warn(
        { line: i + 1, err: err instanceof Error ? err.message : String(err) },
        "metrics: JSON parse error, skipped",
      );
    }
  }
  return out;
}

/**
 * Index metadata records by enrichmentKey. Convenient for joining metrics
 * to metadata in the locGap judge / incumbent-vuln fallback.
 */
export function indexMetadata(
  records: readonly AppTweakMetadataRecord[],
): Map<string, AppTweakMetadataRecord> {
  const out = new Map<string, AppTweakMetadataRecord>();
  for (const r of records) out.set(enrichmentKey(r), r);
  return out;
}

export function indexMetrics(
  records: readonly AppTweakMetricsRecord[],
): Map<string, AppTweakMetricsRecord> {
  const out = new Map<string, AppTweakMetricsRecord>();
  for (const r of records) out.set(enrichmentKey(r), r);
  return out;
}
