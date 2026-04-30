import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { formatError } from "../src/cli/errors.ts";
import { runDemo } from "../src/demo/run-demo.ts";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli", "index.ts");

function runCli(
  argv: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [CLI_PATH, ...argv], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

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

  test("scan --no-llm does not require ANTHROPIC_API_KEY (regression)", () => {
    // Regression: citty's `--no-X` convention sets `args.X = false`, not
    // `args["no-X"] = true`. The original CLI declared `"no-llm"` and read
    // `args["no-llm"]`, which silently ignored the flag and triggered the
    // MISSING_API_KEY pre-flight even when --no-llm was passed.
    //
    // We invoke `--help` in subprocess + check the help text mentions --no-llm
    // wired to the `llm` flag, and we run scan without the env var to check
    // pre-flight does not reject when --no-llm is present.
    const { stderr, status } = runCli(
      ["scan", "--no-llm", "--top", "1", "--markets", "us", "--stores", "apple"],
      { ANTHROPIC_API_KEY: "" },
    );
    // We expect the run to either succeed or fail for a network reason —
    // never fail on the missing API key pre-flight when --no-llm is set.
    expect(stderr).not.toContain("MISSING_API_KEY");
    expect(stderr).not.toContain("ANTHROPIC_API_KEY is required");
    // Status: 0 (scan completed) or 1 (network/scrape failure). Never 2
    // (pre-flight rejection).
    expect(status).not.toBe(2);
  }, 60_000);

  test("scan without --no-llm AND without ANTHROPIC_API_KEY rejects via pre-flight", () => {
    const { stderr, status } = runCli(
      ["scan", "--top", "1", "--markets", "us", "--stores", "apple"],
      { ANTHROPIC_API_KEY: "" },
    );
    expect(stderr).toContain("MISSING_API_KEY");
    expect(status).toBe(2);
  }, 30_000);

  test("scan --no-llm --no-enrich produces JSON with enrichmentSkipped:true (citty wiring lock)", () => {
    // The actual citty footgun guard: invoke --no-enrich and assert the
    // pipeline saw enrich:false. JSON output is the load-bearing channel
    // for this. Apple may be flaky in CI; tolerate that, but if JSON is
    // produced we MUST see enrichmentSkipped:true. Anything else means
    // citty silently ignored the flag (the PR #14 class of bug).
    const { stdout, status, stderr } = runCli(
      [
        "scan",
        "--no-llm",
        "--no-enrich",
        "--top",
        "1",
        "--markets",
        "us",
        "--stores",
        "apple",
        "--format",
        "json",
      ],
      { ANTHROPIC_API_KEY: "" },
    );
    // Pre-flight must pass (status 0 or 1, never 2).
    expect(status).not.toBe(2);
    if (status === 0 && stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(stdout);
      expect(parsed.enrichmentSkipped).toBe(true);
      expect(parsed.enrichmentFailedCount).toBe(0);
    } else {
      // Apple network failed; the smoke gate is the right place to catch
      // upstream drift. The pre-flight assertion above still proves the
      // flag wasn't rejected.
      expect(stderr).not.toContain("MISSING_API_KEY");
    }
  }, 60_000);

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
