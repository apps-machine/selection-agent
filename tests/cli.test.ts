import { describe, expect, test } from "bun:test";
import { formatError } from "../src/cli/errors.ts";
import { runDemo } from "../src/demo/run-demo.ts";

describe("formatError", () => {
  test("includes code, message, cause, fix", () => {
    const out = formatError({
      code: "TEST_ERROR",
      message: "something broke",
      cause: "because",
      fix: "do this",
      docs: "https://example.com",
    });
    expect(out).toContain("TEST_ERROR");
    expect(out).toContain("something broke");
    expect(out).toContain("because");
    expect(out).toContain("do this");
    expect(out).toContain("https://example.com");
  });
});

describe("runDemo", () => {
  test("markdown format prints a brief without throwing", async () => {
    const original = process.stdout.write;
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await runDemo({ format: "markdown" });
    } finally {
      process.stdout.write = original;
    }
    expect(captured).toContain("Selection Agent");
    expect(captured).toContain("Top");
  });

  test("json format emits valid JSON with topCandidates", async () => {
    const original = process.stdout.write;
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await runDemo({ format: "json" });
    } finally {
      process.stdout.write = original;
    }
    const parsed = JSON.parse(captured);
    expect(Array.isArray(parsed.topCandidates)).toBe(true);
    expect(parsed.topCandidates.length).toBeGreaterThan(0);
  });
});
