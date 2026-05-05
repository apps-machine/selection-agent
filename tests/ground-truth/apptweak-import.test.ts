import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { importApptweakCharts } from "../../src/ground-truth/apptweak-import.ts";
import { runMigrations } from "../../src/storage/schema.ts";

const HEADER = "app_id\tmarket\tcategory\tcaptured_at\trank\tsource\tstore";

describe("importApptweakCharts", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
  });

  test("rawTsv: 3 rows → 3 inserts, store column preserved", () => {
    const tsv = [
      HEADER,
      "com.x\tid\ttop_grossing_overall\t1746316800000\t1\tapptweak\tapple",
      "com.y\tid\ttop_grossing_overall\t1746316800000\t1\tapptweak\tgoogleplay",
      "com.z\tvn\ttop_grossing_overall\t1746316800000\t2\tapptweak\tapple",
    ].join("\n");

    const stats = importApptweakCharts("ignored.tsv.gz", db, { rawTsv: tsv });

    expect(stats.rowsRead).toBe(3);
    expect(stats.rowsInserted).toBe(3);
    expect(stats.rowsDuplicate).toBe(0);
    expect(stats.rowsInvalid).toBe(0);

    const count = db
      .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM chart_snapshots")
      .get();
    expect(count?.count).toBe(3);

    const apple = db
      .prepare<{ app_id: string }, []>(
        "SELECT app_id FROM chart_snapshots WHERE store='apple' AND market='id' AND rank=1",
      )
      .get();
    expect(apple?.app_id).toBe("com.x");

    const google = db
      .prepare<{ app_id: string }, []>(
        "SELECT app_id FROM chart_snapshots WHERE store='googleplay' AND market='id' AND rank=1",
      )
      .get();
    expect(google?.app_id).toBe("com.y");
  });

  test("idempotent re-run: duplicate PKs counted as duplicates", () => {
    const tsv = [HEADER, "com.x\tid\ttop_grossing_overall\t1746316800000\t1\tapptweak\tapple"].join(
      "\n",
    );

    const first = importApptweakCharts("x.gz", db, { rawTsv: tsv });
    expect(first.rowsInserted).toBe(1);
    expect(first.rowsDuplicate).toBe(0);

    const second = importApptweakCharts("x.gz", db, { rawTsv: tsv });
    expect(second.rowsInserted).toBe(0);
    expect(second.rowsDuplicate).toBe(1);
  });

  test("invalid store value → counted as invalid, skipped", () => {
    const tsv = [
      HEADER,
      "com.x\tid\ttop_grossing_overall\t1746316800000\t1\tapptweak\tnintendo",
      "com.y\tid\ttop_grossing_overall\t1746316800000\t2\tapptweak\tapple",
    ].join("\n");

    const stats = importApptweakCharts("x.gz", db, { rawTsv: tsv });
    expect(stats.rowsInvalid).toBe(1);
    expect(stats.rowsInserted).toBe(1);
  });

  test("missing required column → throws", () => {
    const tsv = [
      "app_id\tmarket\tcategory\tcaptured_at\trank\tsource",
      "com.x\tid\ttg\t1\t1\tat",
    ].join("\n");
    expect(() => importApptweakCharts("x.gz", db, { rawTsv: tsv })).toThrow(/missing required/);
  });

  test("reads gzipped file from disk", () => {
    const tsv = [HEADER, "com.x\tid\ttop_grossing_overall\t1746316800000\t1\tapptweak\tapple"].join(
      "\n",
    );
    const path = join(tmpdir(), `apptweak-import-test-${Date.now()}.tsv.gz`);
    writeFileSync(path, gzipSync(Buffer.from(tsv, "utf8")));

    const stats = importApptweakCharts(path, db);
    expect(stats.rowsInserted).toBe(1);
  });
});
