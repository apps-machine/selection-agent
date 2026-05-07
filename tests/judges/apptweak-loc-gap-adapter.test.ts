import { describe, expect, test } from "bun:test";
import type { AppTweakMetadataRecord } from "../../src/ground-truth/apptweak-jsonl.ts";
import { adaptApptweakToRawAppData } from "../../src/judges/apptweak-loc-gap-adapter.ts";

describe("adaptApptweakToRawAppData", () => {
  test("apple metadata maps to store='apple' RawAppData", () => {
    const record: AppTweakMetadataRecord = {
      app_id: "284882215",
      market: "id",
      store: "apple",
      device: "iphone",
      language: "id",
      t0: 1746316800000,
      metadata: {
        title: "Aplikasi Saya",
        subtitle: "Subtitle Indonesia",
        promotional_text: null,
        description: "Deskripsi panjang dalam bahasa Indonesia.",
        icon: "https://example.com/icon.png",
      },
    };
    const ra = adaptApptweakToRawAppData(record);
    expect(ra).not.toBeNull();
    expect(ra?.store).toBe("apple");
    expect(ra?.appId).toBe("284882215");
    expect(ra?.market).toBe("id");
    expect(ra?.name).toBe("Aplikasi Saya");
    expect(ra?.description).toContain("Deskripsi panjang");
  });

  test("googleplay metadata maps to store='google'", () => {
    const record: AppTweakMetadataRecord = {
      app_id: "com.example.app",
      market: "vn",
      store: "googleplay",
      device: "android",
      language: "vi",
      t0: 1746316800000,
      metadata: { title: "ten ung dung", description: "mo ta" },
    };
    const ra = adaptApptweakToRawAppData(record);
    expect(ra?.store).toBe("google");
  });

  test("metadata=null returns null (caller short-circuits to locGap=10)", () => {
    const record: AppTweakMetadataRecord = {
      app_id: "x",
      market: "id",
      store: "apple",
      device: "iphone",
      language: "id",
      t0: 1746316800000,
      metadata: null,
    };
    expect(adaptApptweakToRawAppData(record)).toBeNull();
  });

  test("missing optional metadata fields are stubbed to safe defaults", () => {
    const record: AppTweakMetadataRecord = {
      app_id: "x",
      market: "th",
      store: "apple",
      device: "iphone",
      language: "th",
      t0: 1746316800000,
      metadata: { title: "x" },
    };
    const ra = adaptApptweakToRawAppData(record);
    expect(ra?.developer).toBe("unknown");
    expect(ra?.category).toBe("unknown");
    expect(ra?.description).toBe("");
    expect(ra?.priceUsd).toBe(0);
    expect(ra?.iapPresent).toBe(false);
    expect(ra?.rating).toBeNull();
    expect(ra?.ratingsCount).toBeNull();
    expect(ra?.rank).toBeNull();
    expect(ra?.screenshotUrls).toEqual([]);
    expect(ra?.iconUrl).toBeNull();
  });
});
