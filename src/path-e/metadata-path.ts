/**
 * Shared metadata.jsonl path resolver — used by both `selection-agent audit`
 * (Stage 1 pre-flight checks) and `selection-agent shortlist` (Stage 2 Path E
 * pipeline). Both consume the same `metadata.jsonl[.gz]` dossier produced by
 * the AppTweak ingest, so they share one resolution strategy:
 *
 *   1. If `metadataPath` is provided, use it verbatim (gzip auto-detected by
 *      `.gz` suffix).
 *   2. Otherwise, scan `<dataRoot>/data/apptweak-*` directories, sort
 *      lexicographically (so the latest YYYY-MM-DD wins), and pick the first
 *      that contains `metadata.jsonl` or `metadata.jsonl.gz`.
 *   3. If no file is found, return null. Callers decide whether that is a
 *      hard error or a soft fallback.
 *
 * Exported for tests; not part of the package's public CLI API surface.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ResolveMetadataPathOpts {
  /** Explicit path to a metadata.jsonl[.gz] file. Wins over glob. */
  metadataPath?: string;
  /** Root directory for the default glob. Defaults to process.cwd(). */
  dataRoot?: string;
}

export function resolveMetadataPath(opts: ResolveMetadataPathOpts = {}): string | null {
  if (opts.metadataPath) {
    return existsSync(opts.metadataPath) ? opts.metadataPath : null;
  }
  const root = opts.dataRoot ?? process.cwd();
  const dataDir = join(root, "data");
  if (!existsSync(dataDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return null;
  }
  // Sort descending so the latest dated directory wins.
  const candidates = entries
    .filter((name) => name.startsWith("apptweak-"))
    .filter((name) => {
      try {
        return statSync(join(dataDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
  for (const name of candidates) {
    const dir = join(dataDir, name);
    const jsonl = join(dir, "metadata.jsonl");
    if (existsSync(jsonl)) return jsonl;
    const gz = join(dir, "metadata.jsonl.gz");
    if (existsSync(gz)) return gz;
  }
  return null;
}
