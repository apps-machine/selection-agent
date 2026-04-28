// Ambient types for JS-only scraper libraries.
// We treat them as opaque unknowns; runtime shape validation lives in
// src/scrapers/{apple,google}-client.ts via normalize* functions.

declare module "app-store-scraper" {
  const lib: unknown;
  export default lib;
}

declare module "google-play-scraper" {
  const lib: unknown;
  export default lib;
}
