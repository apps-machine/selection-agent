import { describe, expect, test } from "bun:test";
import { assertDiskSpace, checkDiskSpace } from "../../src/storage/disk.ts";

describe("disk", () => {
  test("checkDiskSpace returns positive numbers for current dir", () => {
    const d = checkDiskSpace(".");
    expect(d.freeBytes).toBeGreaterThan(0);
    expect(d.totalBytes).toBeGreaterThan(0);
    expect(d.totalBytes).toBeGreaterThanOrEqual(d.freeBytes);
  });

  test("assertDiskSpace passes when threshold is small", () => {
    expect(() => assertDiskSpace(".", 1)).not.toThrow();
  });

  test("assertDiskSpace throws when threshold exceeds free space", () => {
    const d = checkDiskSpace(".");
    expect(() => assertDiskSpace(".", d.freeBytes + 1_000_000_000)).toThrow(/disk space too low/);
  });
});
