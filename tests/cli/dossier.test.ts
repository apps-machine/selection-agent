/**
 * `selection-agent dossier` CLI integration tests.
 *
 * Spawns the CLI as a subprocess (mirroring the audit + shortlist + risk-check
 * patterns) and asserts on exit code + dossier file contents. Pure pipeline
 * correctness is covered by tests/path-e/dossier.test.ts; these tests focus
 * on the shell glue: arg parsing, file IO, exit codes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(join(import.meta.dir, "..", "..", "src", "cli", "index.ts"));

let workDir: string;
let shortlistPath: string;
let outputPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "dossier-cli-test-"));
  shortlistPath = join(workDir, "shortlist.json");
  outputPath = join(workDir, "dossier.md");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function passingCandidate(appId: string, store = "apple"): Record<string, unknown> {
  return {
    app_id: appId,
    store,
    title: `App ${appId}`,
    score: 0.7234,
    markets_active: ["id", "vn", "th"],
    tenure_days_max: 250,
    best_rank: 12,
    publisher_name: `Pub ${appId}`,
    publisher_app_count: 1,
    dna_class: "Productivity & Tools",
    dna_subclass: "Cleanup",
    has_subscription_iap: true,
    iap_count: 3,
    clonability_hypothesis: "CLONE: simple wedge concept.",
  };
}

function seedShortlist(...candidates: Record<string, unknown>[]): void {
  writeFileSync(
    shortlistPath,
    JSON.stringify({ generated_at_utc: "2026-05-08T00:00:00Z", shortlist: candidates }),
    "utf8",
  );
}

const ENV = { ...process.env, NO_COLOR: "1", LOG_LEVEL: "silent" };

describe("selection-agent dossier CLI", () => {
  test("happy path: writes dossier file, exits 0, populated sections present", () => {
    seedShortlist(passingCandidate("544007664"), passingCandidate("999", "googleplay"));
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "dossier",
        "--shortlist",
        shortlistPath,
        "--candidate",
        "544007664:apple",
        "--slug",
        "tidyphone",
        "--output",
        outputPath,
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
    const md = readFileSync(outputPath, "utf8");
    expect(md).toContain("slug: tidyphone");
    expect(md).toContain("verdict: PENDING");
    expect(md).toContain("# tidyphone — discovery dossier (DRAFT)");
    expect(md).toContain("**App ID**: 544007664");
    expect(md).toContain("**Store**: apple");
    expect(md).toContain("**Title**: App 544007664");
    expect(md).toContain("**Path E score**: 0.7234");
    expect(md).toContain("Solo-buildable in 4 weeks");
    expect(md).toContain("## 11. Founder signoff");
    expect(r.stdout).toContain(outputPath);
  });

  test("candidate not found in shortlist exits 1 with CANDIDATE_NOT_FOUND", () => {
    seedShortlist(passingCandidate("111"));
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "dossier",
        "--shortlist",
        shortlistPath,
        "--candidate",
        "999:apple",
        "--slug",
        "demo",
        "--output",
        outputPath,
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CANDIDATE_NOT_FOUND");
    expect(existsSync(outputPath)).toBe(false);
  });

  test("invalid candidate ref (no colon) exits 2 with INVALID_CANDIDATE", () => {
    seedShortlist(passingCandidate("111"));
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "dossier",
        "--shortlist",
        shortlistPath,
        "--candidate",
        "no-colon-here",
        "--slug",
        "demo",
        "--output",
        outputPath,
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("INVALID_CANDIDATE");
  });

  test("invalid candidate ref (unknown store) exits 2 with INVALID_CANDIDATE", () => {
    seedShortlist(passingCandidate("111"));
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "dossier",
        "--shortlist",
        shortlistPath,
        "--candidate",
        "111:windows",
        "--slug",
        "demo",
        "--output",
        outputPath,
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("INVALID_CANDIDATE");
  });

  test("missing shortlist file exits 2 with MISSING_FILE", () => {
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "dossier",
        "--shortlist",
        join(workDir, "no-such-file.json"),
        "--candidate",
        "111:apple",
        "--slug",
        "demo",
        "--output",
        outputPath,
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("MISSING_FILE");
  });

  test("invalid shortlist JSON exits 2 with PARSE_ERROR", () => {
    writeFileSync(shortlistPath, "{not valid", "utf8");
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "dossier",
        "--shortlist",
        shortlistPath,
        "--candidate",
        "111:apple",
        "--slug",
        "demo",
        "--output",
        outputPath,
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("PARSE_ERROR");
  });

  test("--template flag uses a custom template + substitutes tokens", () => {
    seedShortlist(passingCandidate("777"));
    const templatePath = join(workDir, "template.md");
    writeFileSync(
      templatePath,
      "# {{slug}} brief\nApp: {{candidate.app_id}}\nMarkets: {{candidate.markets_active}}\n",
      "utf8",
    );
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "dossier",
        "--shortlist",
        shortlistPath,
        "--candidate",
        "777:apple",
        "--slug",
        "myapp",
        "--template",
        templatePath,
        "--output",
        outputPath,
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(0);
    const md = readFileSync(outputPath, "utf8");
    expect(md).toBe("# myapp brief\nApp: 777\nMarkets: id, vn, th\n");
  });

  test("missing template file exits 2 with MISSING_FILE", () => {
    seedShortlist(passingCandidate("777"));
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "dossier",
        "--shortlist",
        shortlistPath,
        "--candidate",
        "777:apple",
        "--slug",
        "myapp",
        "--template",
        join(workDir, "no-template.md"),
        "--output",
        outputPath,
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("MISSING_FILE");
  });

  test("missing required arg --slug fails (non-zero) and reports the missing flag", () => {
    seedShortlist(passingCandidate("777"));
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "dossier",
        "--shortlist",
        shortlistPath,
        "--candidate",
        "777:apple",
        "--output",
        outputPath,
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).not.toBe(0);
    // citty surfaces the missing-required-arg via stdout/stderr — accept either.
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).toContain("--slug");
  });

  test("default output path is `<slug>-dossier-<date>.md` in cwd", () => {
    seedShortlist(passingCandidate("777"));
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "dossier",
        "--shortlist",
        shortlistPath,
        "--candidate",
        "777:apple",
        "--slug",
        "demoapp",
      ],
      { encoding: "utf8", env: ENV, cwd: workDir },
    );
    expect(r.status).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    const expected = join(workDir, `demoapp-dossier-${today}.md`);
    expect(existsSync(expected)).toBe(true);
  });
});
