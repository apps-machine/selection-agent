/**
 * `selection-agent risk-check` CLI integration tests.
 *
 * Spawns the CLI as a subprocess (mirroring the audit + shortlist patterns)
 * and asserts on exit code + output. Pipeline correctness is covered by the
 * unit tests in tests/path-e/risk-check.test.ts; these tests focus on the
 * shell glue: arg parsing, file IO, format selection, exit codes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_PATH = resolve(join(import.meta.dir, "..", "..", "src", "cli", "index.ts"));

interface SeedShortlistOpts {
  passing?: number;
  failing?: number;
  warning?: number;
}

let workDir: string;
let shortlistPath: string;
let thresholdsPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "risk-check-cli-test-"));
  shortlistPath = join(workDir, "shortlist.json");
  thresholdsPath = join(workDir, "thresholds.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function passingCandidate(appId: string): Record<string, unknown> {
  return {
    app_id: appId,
    store: "apple",
    title: `App ${appId}`,
    score: 0.85,
    markets_active: ["id", "vn", "th"],
    tenure_days_max: 250,
    tenure_days_total: 700,
    best_rank: 12,
    recent_30d_days: 28,
    publisher_id: `pub_${appId}`,
    publisher_name: `Pub ${appId}`,
    publisher_app_count: 1,
    dna_class: "Productivity & Tools",
    dna_subclass: null,
    clonability_tier: "AUTO",
    categories: [],
    has_subscription_iap: true,
    iap_count: 3,
    subtitle: "Useful tool",
    description_short: "A productivity app",
    icon_url: null,
    score_components: { tenure: 0.7, spread: 0.6, recency: 0.9, rank: 0.88, indie: 1 },
  };
}

function failingCandidate(appId: string): Record<string, unknown> {
  // tenure too short, dna not clonable
  return {
    ...passingCandidate(appId),
    app_id: appId,
    tenure_days_max: 30,
    dna_class: "MMORPG",
  };
}

function seedShortlist(opts: SeedShortlistOpts = { passing: 1 }): void {
  const shortlist: unknown[] = [];
  for (let i = 0; i < (opts.passing ?? 0); i++) {
    shortlist.push(passingCandidate(`pass${i}`));
  }
  for (let i = 0; i < (opts.failing ?? 0); i++) {
    shortlist.push(failingCandidate(`fail${i}`));
  }
  writeFileSync(
    shortlistPath,
    JSON.stringify({
      generated_at_utc: "2026-05-08T00:00:00Z",
      shortlist,
    }),
    "utf8",
  );
}

function writeThresholds(obj: Record<string, unknown>): void {
  writeFileSync(thresholdsPath, JSON.stringify(obj), "utf8");
}

const ENV = { ...process.env, NO_COLOR: "1", LOG_LEVEL: "silent" };

describe("selection-agent risk-check CLI", () => {
  test("happy path: valid shortlist + thresholds → exit 0, JSON to stdout", () => {
    seedShortlist({ passing: 2 });
    writeThresholds({});
    const r = spawnSync(
      "bun",
      [CLI_PATH, "risk-check", "--shortlist", shortlistPath, "--thresholds", thresholdsPath],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(0);
    // Strip the banner — find the first '{'
    const jsonStart = r.stdout.indexOf("{");
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const payload = JSON.parse(r.stdout.slice(jsonStart));
    expect(payload.summary.total).toBe(2);
    expect(payload.summary.pass).toBe(2);
    expect(payload.thresholds_used.maxConcurrentMarkets).toBe(3);
    expect(payload.candidates[0].risk_check.overall).toBe("PASS");
  });

  test("--output writes the JSON to a file and prints a summary line", () => {
    seedShortlist({ passing: 1, failing: 1 });
    writeThresholds({});
    const outPath = join(workDir, "annotated.json");
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "risk-check",
        "--shortlist",
        shortlistPath,
        "--thresholds",
        thresholdsPath,
        "--output",
        outPath,
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const payload = JSON.parse(readFileSync(outPath, "utf8"));
    expect(payload.summary.total).toBe(2);
    expect(payload.summary.pass).toBe(1);
    expect(payload.summary.fail).toBe(1);
    expect(r.stdout).toContain("PASS");
    expect(r.stdout).toContain(outPath);
  });

  test("--format csv emits an augmented CSV with risk_* columns", () => {
    seedShortlist({ passing: 1 });
    writeThresholds({});
    const outPath = join(workDir, "annotated.csv");
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "risk-check",
        "--shortlist",
        shortlistPath,
        "--thresholds",
        thresholdsPath,
        "--output",
        outPath,
        "--format",
        "csv",
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(0);
    const csv = readFileSync(outPath, "utf8");
    const headerLine = csv.split("\n")[0] ?? "";
    expect(headerLine).toContain("risk_overall");
    expect(headerLine).toContain("risk_markets_spread");
    expect(headerLine).toContain("risk_tenure");
    expect(headerLine).toContain("risk_subscription_iap");
    expect(headerLine).toContain("risk_supported_markets");
    expect(headerLine).toContain("risk_clonable_dna");
    // First data row should have PASS overall + PASS / INFO statuses
    const firstRow = csv.split("\n")[1] ?? "";
    expect(firstRow).toContain("PASS");
  });

  test("missing shortlist file exits 2 with MISSING_FILE", () => {
    writeThresholds({});
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "risk-check",
        "--shortlist",
        join(workDir, "nope.json"),
        "--thresholds",
        thresholdsPath,
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("MISSING_FILE");
  });

  test("missing thresholds file exits 2 with MISSING_FILE", () => {
    seedShortlist({ passing: 1 });
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "risk-check",
        "--shortlist",
        shortlistPath,
        "--thresholds",
        join(workDir, "no-thresholds.json"),
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("MISSING_FILE");
  });

  test("invalid thresholds JSON exits 2 with PARSE_ERROR", () => {
    seedShortlist({ passing: 1 });
    writeFileSync(thresholdsPath, "{not valid json", "utf8");
    const r = spawnSync(
      "bun",
      [CLI_PATH, "risk-check", "--shortlist", shortlistPath, "--thresholds", thresholdsPath],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("PARSE_ERROR");
  });

  test("thresholds JSON failing schema exits 2 with INVALID_THRESHOLDS", () => {
    seedShortlist({ passing: 1 });
    writeThresholds({ maxConcurrentMarkets: 99 });
    const r = spawnSync(
      "bun",
      [CLI_PATH, "risk-check", "--shortlist", shortlistPath, "--thresholds", thresholdsPath],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("INVALID_THRESHOLDS");
  });

  test("all candidates FAIL → exit 1", () => {
    seedShortlist({ failing: 3 });
    writeThresholds({});
    const r = spawnSync(
      "bun",
      [CLI_PATH, "risk-check", "--shortlist", shortlistPath, "--thresholds", thresholdsPath],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(1);
    const jsonStart = r.stdout.indexOf("{");
    const payload = JSON.parse(r.stdout.slice(jsonStart));
    expect(payload.summary.fail).toBe(3);
    expect(payload.summary.pass).toBe(0);
  });

  test("--format with bad value exits 2 with INVALID_FORMAT", () => {
    seedShortlist({ passing: 1 });
    writeThresholds({});
    const r = spawnSync(
      "bun",
      [
        CLI_PATH,
        "risk-check",
        "--shortlist",
        shortlistPath,
        "--thresholds",
        thresholdsPath,
        "--format",
        "yaml",
      ],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("INVALID_FORMAT");
  });

  test("shortlist with a top-level array (raw candidates) is accepted", () => {
    writeFileSync(shortlistPath, JSON.stringify([passingCandidate("only")]), "utf8");
    writeThresholds({});
    const r = spawnSync(
      "bun",
      [CLI_PATH, "risk-check", "--shortlist", shortlistPath, "--thresholds", thresholdsPath],
      { encoding: "utf8", env: ENV },
    );
    expect(r.status).toBe(0);
    const jsonStart = r.stdout.indexOf("{");
    const payload = JSON.parse(r.stdout.slice(jsonStart));
    expect(payload.summary.total).toBe(1);
  });
});
