import { describe, expect, test } from "bun:test";
import { err, isErr, isOk, map, ok, type Result, tryAsync, unwrap } from "../../src/util/result.ts";

describe("Result", () => {
  test("ok and isOk", () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (r.ok) expect(r.value).toBe(42);
  });

  test("err and isErr", () => {
    const r = err("nope");
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (!r.ok) expect(r.error).toBe("nope");
  });

  test("unwrap returns value when ok", () => {
    expect(unwrap(ok("hi"))).toBe("hi");
  });

  test("unwrap throws when err", () => {
    expect(() => unwrap(err(new Error("boom")))).toThrow("boom");
  });

  test("unwrap wraps non-Error errors", () => {
    expect(() => unwrap(err("string error"))).toThrow("string error");
  });

  test("map transforms ok values", () => {
    const r: Result<number> = ok(2);
    const doubled = map(r, (n) => n * 2);
    expect(isOk(doubled) && doubled.value).toBe(4);
  });

  test("map passes through err unchanged", () => {
    const r: Result<number, string> = err("nope");
    const mapped = map(r, (n) => n * 2);
    expect(isErr(mapped) && mapped.error).toBe("nope");
  });

  test("tryAsync wraps thrown errors", async () => {
    const r = await tryAsync(async () => {
      throw new Error("async boom");
    });
    expect(isErr(r)).toBe(true);
    if (!r.ok) expect(r.error.message).toBe("async boom");
  });

  test("tryAsync returns value on success", async () => {
    const r = await tryAsync(async () => 7);
    expect(isOk(r) && r.value).toBe(7);
  });

  test("tryAsync coerces non-Error throws", async () => {
    const r = await tryAsync(async () => {
      throw "string thrown";
    });
    expect(isErr(r)).toBe(true);
    if (!r.ok) expect(r.error.message).toBe("string thrown");
  });
});
