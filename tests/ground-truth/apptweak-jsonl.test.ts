import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrichmentKey,
  indexMetadata,
  indexMetrics,
  readMetadataJsonl,
  readMetricsJsonl,
} from "../../src/ground-truth/apptweak-jsonl.ts";

function tmpFile(suffix: string, content: string): string {
  const path = join(
    tmpdir(),
    `apptweak-jsonl-${Date.now()}-${Math.random().toString(36).slice(2)}.${suffix}`,
  );
  writeFileSync(path, content);
  return path;
}

describe("readMetadataJsonl", () => {
  test("parses well-formed metadata records and a 422 error row", () => {
    const lines = [
      JSON.stringify({
        app_id: "com.x",
        market: "id",
        store: "apple",
        device: "iphone",
        language: "id",
        t0: "2025-05-04",
        raw: { metadata: { title: "Aplikasi X", description: "Aplikasi yang bagus" } },
      }),
      JSON.stringify({
        app_id: "com.y",
        market: "id",
        store: "googleplay",
        device: "android",
        language: "id",
        t0: "2025-05-04",
        raw: { metadata: { error: "ValidationError" } },
      }),
      "",
    ].join("\n");

    const path = tmpFile("jsonl", lines);
    const records = readMetadataJsonl(path);
    expect(records).toHaveLength(2);

    const first = records[0];
    expect(first?.app_id).toBe("com.x");
    expect(first?.t0).toBe(Date.UTC(2025, 4, 4));
    expect(first?.metadata?.title).toBe("Aplikasi X");
    expect(first?.metadata?.description).toBe("Aplikasi yang bagus");

    const second = records[1];
    expect(second?.app_id).toBe("com.y");
    // 422 ValidationError → metadata=null so judge can score locGap=10.
    expect(second?.metadata).toBeNull();
  });

  test("malformed JSON line is skipped, valid lines preserved", () => {
    const lines = [
      "this-is-not-json",
      JSON.stringify({
        app_id: "com.x",
        market: "id",
        store: "apple",
        device: "iphone",
        language: "id",
        t0: "2025-05-04",
        raw: { metadata: { title: "ok" } },
      }),
    ].join("\n");
    const path = tmpFile("jsonl", lines);
    const records = readMetadataJsonl(path);
    expect(records).toHaveLength(1);
  });
});

describe("readMetricsJsonl", () => {
  test("extracts ratings + app-power", () => {
    const line = JSON.stringify({
      app_id: "com.x",
      market: "id",
      store: "apple",
      device: "iphone",
      t0: "2025-05-04",
      raw: {
        ratings: [{ value: 4.5, breakdown: { total: 1000, avg: 4.5 }, date: "2025-05-04" }],
        "app-power": [{ value: 88.2, date: "2025-05-04" }],
      },
    });
    const path = tmpFile("jsonl", line);
    const records = readMetricsJsonl(path);
    expect(records).toHaveLength(1);
    expect(records[0]?.ratings).toEqual({ total: 1000, average: 4.5 });
    expect(records[0]?.app_power).toBe(88.2);
  });

  test("missing ratings/app-power → null fields, not throw", () => {
    const line = JSON.stringify({
      app_id: "com.x",
      market: "id",
      store: "apple",
      device: "iphone",
      t0: "2025-05-04",
      raw: {},
    });
    const path = tmpFile("jsonl", line);
    const records = readMetricsJsonl(path);
    expect(records[0]?.ratings).toBeNull();
    expect(records[0]?.app_power).toBeNull();
  });
});

describe("enrichmentKey + index helpers", () => {
  test("indexMetadata round-trips by enrichmentKey", () => {
    const rec = {
      app_id: "com.x",
      market: "id" as const,
      store: "apple" as const,
      device: "iphone" as const,
      language: "id",
      t0: 1746316800000,
      metadata: null,
    };
    const idx = indexMetadata([rec]);
    expect(idx.get(enrichmentKey(rec))).toBe(rec);
  });

  test("indexMetrics round-trips by enrichmentKey", () => {
    const rec = {
      app_id: "com.x",
      market: "id",
      store: "apple" as const,
      device: "iphone" as const,
      t0: 1746316800000,
      ratings: null,
      app_power: null,
    };
    const idx = indexMetrics([rec]);
    expect(idx.get(enrichmentKey(rec))).toBe(rec);
  });
});
