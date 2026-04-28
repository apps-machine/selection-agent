import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Cache } from "../../src/storage/cache.ts";

describe("Cache", () => {
  let now = 1_000_000;
  let cache: Cache;

  beforeEach(() => {
    now = 1_000_000;
    cache = Cache.open(":memory:", () => now);
  });

  afterEach(() => {
    cache.close();
  });

  test("put/get roundtrips a value", () => {
    cache.put("k1", { hello: "world" }, 60);
    expect(cache.get<{ hello: string }>("k1")).toEqual({ hello: "world" });
  });

  test("get returns null for missing key", () => {
    expect(cache.get("missing")).toBeNull();
  });

  test("get returns null after expiry", () => {
    cache.put("k1", "v", 60);
    expect(cache.get<string>("k1")).toBe("v");
    now += 60_000 + 1;
    expect(cache.get("k1")).toBeNull();
  });

  test("getStale returns expired entry", () => {
    cache.put("k1", "v", 60);
    now += 120_000;
    expect(cache.get("k1")).toBeNull();
    const stale = cache.getStale<string>("k1");
    expect(stale?.value).toBe("v");
  });

  test("getStale returns null for never-cached key", () => {
    expect(cache.getStale("never")).toBeNull();
  });

  test("put overwrites prior entry", () => {
    cache.put("k1", "v1", 60);
    cache.put("k1", "v2", 120);
    expect(cache.get<string>("k1")).toBe("v2");
  });

  test("prune deletes only expired entries", () => {
    cache.put("fresh", "f", 60);
    cache.put("stale", "s", 5);
    now += 10_000;
    expect(cache.prune()).toBe(1);
    expect(cache.get<string>("fresh")).toBe("f");
    expect(cache.getStale("stale")).toBeNull();
  });

  test("size counts rows including expired (until pruned)", () => {
    cache.put("a", 1, 60);
    cache.put("b", 2, 5);
    expect(cache.size()).toBe(2);
    now += 10_000;
    expect(cache.size()).toBe(2);
    cache.prune();
    expect(cache.size()).toBe(1);
  });

  test("rejects ttlSeconds <= 0", () => {
    expect(() => cache.put("k", "v", 0)).toThrow();
    expect(() => cache.put("k", "v", -1)).toThrow();
  });

  test("getEntry returns expiresAt and createdAt", () => {
    cache.put("k", "v", 60);
    const entry = cache.getEntry<string>("k");
    expect(entry?.value).toBe("v");
    expect(entry?.expiresAt).toBe(now + 60_000);
    expect(entry?.createdAt).toBe(now);
  });

  test("complex JSON values roundtrip", () => {
    const value = {
      arr: [1, 2, { nested: true }],
      str: "hi",
      n: null,
      bool: false,
    };
    cache.put("complex", value, 60);
    expect(cache.get<typeof value>("complex")).toEqual(value);
  });
});
