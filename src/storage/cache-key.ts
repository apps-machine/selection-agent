/**
 * Build a cache key from kind + segments.
 *
 * Each segment is percent-encoded so user-provided values (appIds from
 * third-party scraper output, market codes, etc.) cannot collide with
 * other key namespaces or contain the `:` separator.
 *
 * Example:
 *   buildCacheKey("chart", "apple", "us", "top-grossing", "200")
 *   -> "chart:apple:us:top-grossing:200"
 *
 *   buildCacheKey("app", "google", "br", "com.evil:chart:apple:us")
 *   -> "app:google:br:com.evil%3Achart%3Aapple%3Aus"
 */
export function buildCacheKey(kind: string, ...segments: ReadonlyArray<string | number>): string {
  const encoded = segments.map((s) => encodeURIComponent(String(s)));
  return [kind, ...encoded].join(":");
}
