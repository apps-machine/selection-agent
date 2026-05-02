import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { importDump } from "../../src/ground-truth/appgoblin-import.ts";
import { runMigrations } from "../../src/storage/schema.ts";

/** Build an in-memory ReadableStream<Uint8Array> from a TSV string. */
function tsvStream(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Build a chunked stream that splits the bytes into multiple `enqueue`s. */
function chunkedStream(s: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      while (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      }
      controller.close();
    },
  });
}

const HEADER = "app_id\tmarket\tcategory\tcaptured_at\trank";

describe("importDump", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
  });

  test("happy: small TSV → upserts to chart_snapshots", async () => {
    const tsv = [
      HEADER,
      `com.x\tid\tproductivity\t1704067200\t5`,
      `com.y\tvn\tgames\t1704067200\t10`,
      `com.z\tth\tlifestyle\t1704067200\t15`,
    ].join("\n");

    const stats = await importDump("/tmp/x.tsv.xz", db, { source: tsvStream(tsv) });

    expect(stats.rowsRead).toBe(3);
    expect(stats.rowsInserted).toBe(3);
    expect(stats.rowsDuplicate).toBe(0);
    expect(stats.rowsInvalid).toBe(0);

    const rows = db
      .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM chart_snapshots")
      .get();
    expect(rows?.count).toBe(3);

    // Verify timestamp parsing (1704067200 unix seconds → ms).
    const sample = db
      .prepare<{ captured_at: number }, []>(
        "SELECT captured_at FROM chart_snapshots WHERE app_id='com.x'",
      )
      .get();
    expect(sample?.captured_at).toBe(1704067200_000);
  });

  test("idempotent re-run: duplicate PKs counted, no constraint error", async () => {
    const tsv = [
      HEADER,
      `com.x\tid\tproductivity\t1704067200\t5`,
      `com.y\tvn\tgames\t1704067200\t10`,
    ].join("\n");

    const first = await importDump("/tmp/x.tsv.xz", db, { source: tsvStream(tsv) });
    const second = await importDump("/tmp/x.tsv.xz", db, { source: tsvStream(tsv) });

    expect(first.rowsInserted).toBe(2);
    expect(second.rowsInserted).toBe(0);
    expect(second.rowsDuplicate).toBe(2);

    const rows = db
      .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM chart_snapshots")
      .get();
    expect(rows?.count).toBe(2); // no doubles
  });

  test("missing required column → throws clear error", async () => {
    const badHeader = "app_id\tmarket\tcaptured_at\trank"; // no `category`
    const tsv = [badHeader, `com.x\tid\t1704067200\t5`].join("\n");
    await expect(importDump("/tmp/x.tsv.xz", db, { source: tsvStream(tsv) })).rejects.toThrow(
      /missing required columns/,
    );
  });

  test("garbage row → counted as invalid, NOT thrown", async () => {
    const tsv = [
      HEADER,
      `com.x\tid\tproductivity\t1704067200\t5`,
      `garbage row with no tabs`,
      `com.y\tvn\tgames\t1704067200\t10`,
      `com.z\tth\tlifestyle\tnot-a-number\t15`,
      `com.w\tmy\tfinance\t1704067200\t-1`, // invalid rank
    ].join("\n");

    const stats = await importDump("/tmp/x.tsv.xz", db, { source: tsvStream(tsv) });

    expect(stats.rowsRead).toBe(5);
    expect(stats.rowsInserted).toBe(2); // x + y
    expect(stats.rowsInvalid).toBe(3); // garbage, bad timestamp, bad rank
  });

  test("file does not exist → throws", async () => {
    await expect(importDump("/nonexistent/path/dump.tsv.xz", db)).rejects.toThrow(/file not found/);
  });

  test("partial dump (truncated mid-stream) → still imports what was readable", async () => {
    // Truncated TSV — the last row is cut off mid-line. Our line reader
    // emits the partial line as the final yield (no trailing \n); the row
    // parser counts it as invalid (parseRow returns null on missing cols).
    const tsv =
      `${HEADER}\n` +
      `com.x\tid\tproductivity\t1704067200\t5\n` +
      `com.y\tvn\tgames\t1704067200\t10\n` +
      `com.z\tth\tlif`; // truncated

    const stats = await importDump("/tmp/x.tsv.xz", db, { source: tsvStream(tsv) });
    expect(stats.rowsInserted).toBe(2);
    expect(stats.rowsInvalid).toBe(1); // truncated last row
  });

  test("chunked stream (simulates network arrival)", async () => {
    // Force the line reader to handle line breaks split across chunks.
    const tsv = [
      HEADER,
      `com.x\tid\tproductivity\t1704067200\t5`,
      `com.y\tvn\tgames\t1704067200\t10`,
      `com.z\tth\tlifestyle\t1704067200\t15`,
    ].join("\n");
    const stats = await importDump("/tmp/x.tsv.xz", db, {
      source: chunkedStream(tsv, 7), // tiny chunks
    });
    expect(stats.rowsInserted).toBe(3);
  });

  test("batch flush at 1000 rows (sanity: 1500 rows in two flushes)", async () => {
    const lines: string[] = [HEADER];
    for (let i = 0; i < 1500; i++) {
      // Vary the rank so PKs are unique.
      lines.push(`com.app${i}\tid\tproductivity\t1704067200\t${i + 1}`);
    }
    const stats = await importDump("/tmp/x.tsv.xz", db, { source: tsvStream(lines.join("\n")) });
    expect(stats.rowsRead).toBe(1500);
    expect(stats.rowsInserted).toBe(1500);
    const rows = db
      .prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM chart_snapshots")
      .get();
    expect(rows?.count).toBe(1500);
  });

  test("ISO timestamp in captured_at also parses", async () => {
    const tsv = [HEADER, `com.x\tid\tproductivity\t2024-01-15T00:00:00Z\t5`].join("\n");
    const stats = await importDump("/tmp/x.tsv.xz", db, { source: tsvStream(tsv) });
    expect(stats.rowsInserted).toBe(1);
    const sample = db
      .prepare<{ captured_at: number }, []>("SELECT captured_at FROM chart_snapshots")
      .get();
    expect(sample?.captured_at).toBe(Date.parse("2024-01-15T00:00:00Z"));
  });

  test("re-creates idx_chart_snapshots_app after bulk import", async () => {
    const tsv = [HEADER, `com.x\tid\tproductivity\t1704067200\t5`].join("\n");
    await importDump("/tmp/x.tsv.xz", db, { source: tsvStream(tsv) });
    // Verify the index exists by name.
    const idx = db
      .prepare<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chart_snapshots_app'",
      )
      .get();
    expect(idx?.name).toBe("idx_chart_snapshots_app");
  });
});
