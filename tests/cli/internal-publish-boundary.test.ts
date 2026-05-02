/**
 * Publish-boundary test — guards Codex Round 2 #10 mechanically.
 *
 * The selection-agent npm tarball MUST NOT include any of the v1 internal
 * modules: src/backtest/, src/ground-truth/, src/opportunities/, src/signals/.
 * The package.json `files:` whitelist enforces this; this test confirms the
 * whitelist is correctly tuned by running `npm pack --dry-run` and asserting
 * none of those paths appear in the tarball listing.
 *
 * The test runs `npm pack --dry-run` as a subprocess (npm prints the file
 * list to stderr in `npm notice` lines, then to stdout). We assert on the
 * combined output. If a future PR adds, e.g., `src/backtest/cli.ts` to the
 * tarball, this test fails loudly — preventing accidental leak of backtest
 * internals to the public npm consumer.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const PKG_DIR = resolve(join(import.meta.dir, "..", ".."));

function npmPackDryRun(): { out: string; err: string; status: number } {
  const r = spawnSync("npm", ["pack", "--dry-run"], {
    cwd: PKG_DIR,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    out: r.stdout ?? "",
    err: r.stderr ?? "",
    status: r.status ?? -1,
  };
}

describe("npm publish boundary — internal modules MUST stay out of tarball", () => {
  test("npm pack --dry-run excludes src/backtest/, src/ground-truth/, src/opportunities/, src/signals/", () => {
    const result = npmPackDryRun();
    expect(result.status).toBe(0);
    const combined = `${result.out}\n${result.err}`;
    // None of these path prefixes should appear in the npm pack listing.
    const forbidden = ["src/backtest/", "src/ground-truth/", "src/opportunities/", "src/signals/"];
    for (const path of forbidden) {
      expect(
        combined.includes(path),
        `npm pack --dry-run unexpectedly includes ${path} — update package.json files: whitelist`,
      ).toBe(false);
    }
  }, 60_000);

  test("npm pack --dry-run still includes the public surface (regression net)", () => {
    const result = npmPackDryRun();
    expect(result.status).toBe(0);
    const combined = `${result.out}\n${result.err}`;
    // Sanity: confirm the published surface is still intact. If this fails
    // someone broke the whitelist by being too restrictive.
    const required = [
      "src/cli/index.ts",
      "src/scrapers/",
      "src/judges/",
      "src/scoring/",
      "src/storage/",
      "src/orchestrator/",
      "src/reporting/",
      "src/util/",
      "src/velocity/",
      "src/demo/",
      "package.json",
      "LICENSE",
      "README.md",
    ];
    for (const path of required) {
      expect(
        combined.includes(path),
        `npm pack --dry-run is missing required public path ${path}`,
      ).toBe(true);
    }
  }, 60_000);
});
