// TODO(M7): Replace this file with `import { ... } from "@apps-machine/shared-types"`
// once shared-types is published to npm. Keeping inline copy here avoids a
// cross-repo dev-time dependency for M2-M6.
import { z } from "zod";

export const StoreSchema = z.enum(["apple", "google"]);
export type Store = z.infer<typeof StoreSchema>;

export const RawAppDataSchema = z.object({
  store: StoreSchema,
  appId: z.string().min(1),
  market: z.string().length(2).describe("ISO 3166-1 alpha-2 country code"),
  name: z.string(),
  developer: z.string(),
  category: z.string(),
  rank: z.number().int().nullable(),
  rating: z.number().min(0).max(5).nullable(),
  ratingsCount: z.number().int().nonnegative().nullable(),
  priceUsd: z.number().nonnegative(),
  iapPresent: z.boolean(),
  description: z.string(),
  screenshotUrls: z.array(z.string().url()).default([]),
  iconUrl: z.string().url().nullable(),
  // Apple chart list() returns timestamps with timezone offsets
  // ("2023-05-18T00:00:00-07:00"); the per-app endpoint returns Z-form
  // ("2023-05-18T07:00:00Z"). Both are valid ISO 8601 — accept either so a
  // real chart scrape doesn't silently kill snapshot writes downstream.
  releaseDate: z.string().datetime({ offset: true }).nullable(),
  lastUpdated: z.string().datetime({ offset: true }).nullable(),
  scrapedAt: z.string().datetime(),
});

export type RawAppData = z.infer<typeof RawAppDataSchema>;
