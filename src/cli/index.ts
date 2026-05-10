#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { runDemo } from "../demo/run-demo.ts";
import type { JudgeClient } from "../judges/text-judge.ts";
import type { ImageFetcher, VisionJudgeClient } from "../judges/vision-judge.ts";
import { buildShortlist, defaultAnthropicLlmClient } from "../path-e/build-shortlist.ts";
import { runSnapshot } from "../velocity/run-snapshot.ts";
import { runAudit } from "./audit.ts";
import { renderBanner, VERSION } from "./banner.ts";
import { formatError } from "./errors.ts";

function parseList(v: unknown): string[] | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a comma-separated list of ISO alpha-2 market codes.
 *
 * Validates each token against /^[a-z]{2}$/. Throws on invalid tokens so the
 * caller surface (e.g. the audit subcommand) can format a clean error and
 * exit 2. Returns undefined when the flag is unset/empty so the caller can
 * fall back to its default cluster.
 */
function parseMarkets(v: unknown): string[] | undefined {
  const parsed = parseList(v);
  if (!parsed) return undefined;
  for (const token of parsed) {
    if (!/^[a-z]{2}$/.test(token)) {
      throw new Error(`invalid market code: ${token} (expected ISO alpha-2 lowercase)`);
    }
  }
  return parsed;
}

function parseStores(v: unknown): ("apple" | "google")[] | undefined {
  const parsed = parseList(v);
  if (!parsed) return undefined;
  for (const s of parsed) {
    if (s !== "apple" && s !== "google") {
      throw new Error(`unknown store "${s}" — accepted: apple, google`);
    }
  }
  return parsed as ("apple" | "google")[];
}

interface JudgeClients {
  textClient: JudgeClient;
  visionClient: VisionJudgeClient;
  fetchImage: ImageFetcher;
}

async function buildJudgeClients(noLlm: boolean): Promise<JudgeClients> {
  if (noLlm) {
    const stub = {
      messages: {
        async create(): Promise<never> {
          throw new Error("judge invoked while --no-llm was set");
        },
      },
    };
    return {
      textClient: stub as JudgeClient,
      visionClient: stub as VisionJudgeClient,
      fetchImage: async () => {
        throw new Error("fetchImage invoked while --no-llm was set");
      },
    };
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const fetchImage: ImageFetcher = async (url, opts) => {
    const res = await fetch(url, { signal: opts?.signal });
    if (!res.ok) throw new Error(`fetchImage: ${res.status} ${res.statusText} for ${url}`);
    const ct = res.headers.get("content-type") ?? "image/png";
    const buf = Buffer.from(await res.arrayBuffer());
    return { mediaType: ct, base64: buf.toString("base64") };
  };
  return {
    textClient: client as unknown as JudgeClient,
    visionClient: client as unknown as VisionJudgeClient,
    fetchImage,
  };
}

const main = defineCommand({
  meta: {
    name: "selection-agent",
    version: VERSION,
    description:
      "Apps Machine Selection Agent — ranks app opportunities globally via dual-store scraping + Claude judges.",
  },
  subCommands: {
    audit: defineCommand({
      meta: {
        name: "audit",
        description:
          "Stage 1 pre-flight data audit (Runbook-Discovery). Runs 6 checks against the cache DB and emits a Markdown report. Exits 1 on FAIL.",
      },
      args: {
        db: {
          type: "string",
          description:
            "SQLite DB path (overrides $SELECTION_AGENT_DB; default ./.cache/selection-agent.sqlite)",
        },
        markets: {
          type: "string",
          description:
            "Comma-separated ISO alpha-2 market codes for chart-coverage checks (default: bd,th,vn,my,id — tier-2 SEA cluster)",
        },
        metadata: {
          type: "string",
          description:
            "Path to the metadata.jsonl[.gz] dossier file. If omitted, scans data/apptweak-*/metadata.jsonl{,.gz} (latest dated dir wins).",
        },
        output: {
          type: "string",
          description:
            "Write the markdown report to this path. If omitted, the report goes to stdout.",
        },
      },
      async run({ args }) {
        const dbPath =
          (typeof args.db === "string" && args.db) ||
          process.env.SELECTION_AGENT_DB ||
          "./.cache/selection-agent.sqlite";
        let markets: string[] | undefined;
        try {
          markets = parseMarkets(args.markets);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            formatError({
              code: "INVALID_MARKETS",
              message,
              cause: "--markets must be a comma-separated list of ISO alpha-2 codes.",
              fix: "rerun with --markets bd,th,vn,my,id (default) or another cluster",
              docs: "docs/runbooks/Runbook-Discovery.md § Stage 1",
            }),
          );
          process.exit(2);
        }
        const output = typeof args.output === "string" && args.output ? args.output : undefined;
        const metadataPath =
          typeof args.metadata === "string" && args.metadata ? args.metadata : undefined;
        try {
          const result = await runAudit({ dbPath, markets, output, metadataPath });
          if (!output) {
            process.stdout.write(result.report);
          } else {
            process.stdout.write(`Audit report written to ${output}\n`);
          }
          process.exit(result.exitCode);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            formatError({
              code: "AUDIT_FAILED",
              message,
              cause: "Audit threw before producing a report.",
              fix: "Check that the DB path is readable and that the schema matches the package version.",
              docs: "docs/runbooks/Runbook-Discovery.md § Stage 1",
            }),
          );
          process.exit(1);
        }
      },
    }),
    shortlist: defineCommand({
      meta: {
        name: "shortlist",
        description:
          "Stage 2 Path E shortlist generator (Runbook-Discovery). Runs 5 sequential filters (durability, indie, mechanic, monetization, market spread) + optional LLM clonability classifier → ranked CSV/JSON shortlist of 30-50 candidate apps to clone.",
      },
      args: {
        db: {
          type: "string",
          description:
            "SQLite DB path (overrides $SELECTION_AGENT_DB; default ./.cache/selection-agent.sqlite)",
        },
        markets: {
          type: "string",
          description:
            "Comma-separated ISO alpha-2 market codes (default: id,vn,th,my,bd — tier-2 SEA cluster)",
        },
        metadata: {
          type: "string",
          description:
            "Path to the metadata.jsonl[.gz] dossier file. If omitted, scans data/apptweak-*/metadata.jsonl{,.gz} (latest dated dir wins).",
        },
        output: {
          type: "string",
          description:
            "Directory for output artifacts. A timestamped subdirectory is created with shortlist.csv + shortlist.json. If omitted, no files are written.",
        },
        llm: {
          type: "boolean",
          description:
            "Run the LLM clonability classifier (default: true). Pass --no-llm to skip judges and keep all dna-clonable candidates.",
          default: true,
        },
        "shortlist-size": {
          type: "string",
          description: "Final shortlist size (default: 50)",
        },
      },
      async run({ args }) {
        const dbPath =
          (typeof args.db === "string" && args.db) ||
          process.env.SELECTION_AGENT_DB ||
          "./.cache/selection-agent.sqlite";
        let markets: string[] | undefined;
        try {
          markets = parseMarkets(args.markets);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            formatError({
              code: "INVALID_MARKETS",
              message,
              cause: "--markets must be a comma-separated list of ISO alpha-2 codes.",
              fix: "rerun with --markets id,vn,th,my,bd (default) or another cluster",
              docs: "docs/runbooks/Runbook-Discovery.md § Stage 2",
            }),
          );
          process.exit(2);
        }
        const metadataPath =
          typeof args.metadata === "string" && args.metadata ? args.metadata : undefined;
        const outputDir = typeof args.output === "string" && args.output ? args.output : undefined;
        const noLlm = args.llm === false;
        const rawSize =
          typeof args["shortlist-size"] === "string" ? args["shortlist-size"] : undefined;
        let finalShortlistSize: number | undefined;
        if (rawSize !== undefined) {
          finalShortlistSize = Number.parseInt(rawSize, 10);
          if (!Number.isFinite(finalShortlistSize) || finalShortlistSize <= 0) {
            console.error(
              formatError({
                code: "INVALID_SHORTLIST_SIZE",
                message: `--shortlist-size must be a positive integer, got "${rawSize}"`,
                cause: "The final shortlist is truncated to this many rows.",
                fix: "rerun with --shortlist-size 50 (default) or another positive integer",
                docs: "docs/runbooks/Runbook-Discovery.md § Stage 2",
              }),
            );
            process.exit(2);
          }
        }
        if (!noLlm && !process.env.ANTHROPIC_API_KEY) {
          console.error(
            formatError({
              code: "MISSING_API_KEY",
              message: "ANTHROPIC_API_KEY is required for the clonability classifier",
              cause: "The LLM step rates each candidate's solo-clonability.",
              fix: [
                "1. Get a key: https://console.anthropic.com/settings/keys",
                "2. Export it in your shell:",
                "     export ANTHROPIC_API_KEY=sk-ant-api03-...",
                "3. Re-run shortlist:",
                "     npx @apps-machine/selection-agent shortlist",
                "",
                "Or skip the LLM step entirely:",
                "     npx @apps-machine/selection-agent shortlist --no-llm",
              ],
              docs: "docs/runbooks/Runbook-Discovery.md § Stage 2",
            }),
          );
          process.exit(2);
        }
        try {
          const llmClient = noLlm ? undefined : await defaultAnthropicLlmClient({});
          const result = await buildShortlist({
            dbPath,
            markets,
            metadataPath,
            outputDir,
            skipLLM: noLlm,
            llmClient,
            finalShortlistSize,
          });
          process.stdout.write(
            `Shortlist: ${result.shortlist.length} apps (from ${result.funnel.final_candidates} candidates).\n`,
          );
          process.stdout.write(
            `Funnel: F1=${result.funnel.f1_post_durability} → rollup=${result.funnel.f1_post_rollup_app_store_pairs} → F5=${result.funnel.f5_post_market_spread} → meta-matched=${result.funnel.f1_post_rollup_app_store_pairs - result.funnel.dropped_no_meta - result.funnel.dropped_no_pub} → clonable=${result.funnel.final_candidates}\n`,
          );
          if (!noLlm) {
            process.stdout.write(
              `LLM: ${result.funnel.llm_kept} CLONE, ${result.funnel.llm_dropped} SKIP, ${result.funnel.llm_unparsed} unparsed.\n`,
            );
          }
          if (result.csvPath) {
            process.stdout.write(`Wrote ${result.csvPath}\n`);
            process.stdout.write(`Wrote ${result.jsonPath}\n`);
          }
          process.exit(0);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            formatError({
              code: "SHORTLIST_FAILED",
              message,
              cause: "buildShortlist threw before producing a shortlist.",
              fix: "Check the DB path, the metadata.jsonl path, and (if not --no-llm) your ANTHROPIC_API_KEY.",
              docs: "docs/runbooks/Runbook-Discovery.md § Stage 2",
            }),
          );
          process.exit(1);
        }
      },
    }),
    demo: defineCommand({
      meta: {
        name: "demo",
        description:
          "Run with cached snapshot data (zero config, no API key needed). ~30s magical moment.",
      },
      args: {
        format: {
          type: "string",
          description: "Output format: markdown | json",
          default: "markdown",
        },
      },
      async run({ args }) {
        if (args.format !== "markdown" && args.format !== "json") {
          console.error(
            formatError({
              code: "INVALID_FORMAT",
              message: `unknown --format value "${args.format}"`,
              cause: "--format accepts 'markdown' or 'json'",
              fix: "rerun with --format markdown (default) or --format json",
              docs: "https://github.com/apps-machine/selection-agent#commands",
            }),
          );
          process.exit(2);
        }
        await runDemo({ format: args.format });
      },
    }),
    scan: defineCommand({
      meta: {
        name: "scan",
        description:
          "Live dual-store scan (Apple App Store + Google Play). Requires ANTHROPIC_API_KEY unless --no-llm.",
      },
      args: {
        top: { type: "string", description: "Limit candidates returned", default: "30" },
        markets: {
          type: "string",
          description:
            "Comma-separated ISO alpha-2 market codes (default: bd,th,vn,my,id — tier-2 SEA cluster where the locGap thesis is empirically alive; see m7.5-thesis-validation.md)",
        },
        stores: {
          type: "string",
          description: "Comma-separated stores (default: apple,google)",
        },
        format: {
          type: "string",
          description: "Output format: markdown | json",
          default: "markdown",
        },
        llm: {
          type: "boolean",
          description:
            "Run LLM judges (default: true). Pass --no-llm to skip judges and run heuristics only.",
          default: true,
        },
        enrich: {
          type: "boolean",
          description:
            "Fetch full app-detail (description, ratings, screenshots) for every chart entry before scoring (default: true). Pass --no-enrich for a cheap chart-only sweep — composite scores will be heavily degraded since real chart entries have no description / ratings.",
          default: true,
        },
        db: {
          type: "string",
          description:
            "SQLite DB path (overrides $SELECTION_AGENT_DB; default ./.cache/selection-agent.sqlite)",
        },
        budget: {
          type: "string",
          description: "USD cost cap (overrides $SELECTION_AGENT_BUDGET_USD; default 20)",
        },
      },
      async run({ args }) {
        const rawTop = typeof args.top === "string" ? args.top : "30";
        const top = Number.parseInt(rawTop, 10);
        if (!Number.isFinite(top) || top <= 0) {
          console.error(
            formatError({
              code: "INVALID_TOP",
              message: `--top must be a positive integer, got "${rawTop}"`,
              cause: "Top-N truncation requires a positive count.",
              fix: "rerun with --top 30 (default)",
              docs: "https://github.com/apps-machine/selection-agent#commands",
            }),
          );
          process.exit(2);
        }
        if (args.format !== "markdown" && args.format !== "json") {
          console.error(
            formatError({
              code: "INVALID_FORMAT",
              message: `unknown --format value "${args.format}"`,
              cause: "--format accepts 'markdown' or 'json'",
              fix: "rerun with --format markdown (default) or --format json",
              docs: "https://github.com/apps-machine/selection-agent#commands",
            }),
          );
          process.exit(2);
        }
        let markets: string[] | undefined;
        let stores: ("apple" | "google")[] | undefined;
        try {
          markets = parseList(args.markets);
          stores = parseStores(args.stores);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            formatError({
              code: "INVALID_STORES",
              message,
              cause: "--stores must be a comma-separated list of apple,google.",
              fix: "rerun with --stores apple,google (default)",
              docs: "https://github.com/apps-machine/selection-agent#commands",
            }),
          );
          process.exit(2);
        }
        const noLlm = args.llm === false;
        const enrich = args.enrich !== false;
        const dbPath =
          (typeof args.db === "string" && args.db) ||
          process.env.SELECTION_AGENT_DB ||
          "./.cache/selection-agent.sqlite";
        const capRaw =
          (typeof args.budget === "string" && args.budget) ||
          process.env.SELECTION_AGENT_BUDGET_USD;
        const capUsd = capRaw ? Number.parseFloat(capRaw) : undefined;
        if (capUsd !== undefined && (!Number.isFinite(capUsd) || capUsd <= 0)) {
          console.error(
            formatError({
              code: "INVALID_BUDGET",
              message: `--budget must be a positive number, got "${capRaw}"`,
              cause: "Cost cap controls fail-fast on judge spend.",
              fix: "rerun with --budget 20 (default)",
              docs: "https://github.com/apps-machine/selection-agent#cost-budget",
            }),
          );
          process.exit(2);
        }

        if (!noLlm && !process.env.ANTHROPIC_API_KEY) {
          console.error(
            formatError({
              code: "MISSING_API_KEY",
              message: "ANTHROPIC_API_KEY is required for live scans",
              cause: "Live scans run text + vision judges via Anthropic.",
              fix: [
                "1. Get a key: https://console.anthropic.com/settings/keys",
                "2. Export it in your shell:",
                "     export ANTHROPIC_API_KEY=sk-ant-api03-...",
                "3. Re-run the scan:",
                "     npx @apps-machine/selection-agent scan",
                "",
                "Or skip judges entirely (heuristics only, much weaker scores):",
                "     npx @apps-machine/selection-agent scan --no-llm",
                "",
                "Tip: try `npx @apps-machine/selection-agent demo` first — zero config, no key.",
              ],
              docs: "https://github.com/apps-machine/selection-agent#environment",
            }),
          );
          process.exit(2);
        }

        try {
          const { runScan } = await import("../orchestrator/pipeline.ts");
          const { Cache } = await import("../storage/cache.ts");
          const { CostBudget } = await import("../judges/budget.ts");
          const { generateBrief } = await import("../reporting/briefs.ts");
          const { loadDefaultAppleClient } = await import("../scrapers/apple-store-client.ts");
          const { loadDefaultGoogleClient } = await import("../scrapers/google-play-client.ts");

          const cache = Cache.open(dbPath);
          try {
            const [apple, google] = await Promise.all([
              loadDefaultAppleClient(),
              loadDefaultGoogleClient(),
            ]);
            const { textClient, visionClient, fetchImage } = await buildJudgeClients(noLlm);

            const result = await runScan({
              cache,
              markets,
              stores,
              topN: top,
              noLlm,
              enrich,
              scrapers: { apple, google },
              textClient,
              visionClient,
              fetchImage,
              budget: new CostBudget({ capUsd }),
            });

            if (args.format === "json") {
              process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            } else {
              process.stdout.write(generateBrief(result));
            }
            process.exit(0);
          } finally {
            cache.close();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            formatError({
              code: "SCAN_FAILED",
              message,
              cause: "runScan threw before producing a result.",
              fix: "Check network access + ANTHROPIC_API_KEY, then rerun with --no-llm to isolate.",
              docs: "https://github.com/apps-machine/selection-agent#commands",
            }),
          );
          process.exit(1);
        }
      },
    }),
    snapshot: defineCommand({
      meta: {
        name: "snapshot",
        description:
          "Daily Track B snapshot writer. Scrapes top-grossing across the default tier-2 SEA cluster on both stores and persists one row per app per UTC day. Cron-friendly: scrape-only, no LLM calls.",
      },
      args: {
        limit: {
          type: "string",
          description: "Apps to capture per market+store",
          default: "100",
        },
        markets: {
          type: "string",
          description:
            "Comma-separated ISO alpha-2 market codes (default: bd,th,vn,my,id — tier-2 SEA cluster, matches scan default since v0.7.0)",
        },
        db: {
          type: "string",
          description:
            "SQLite DB path (overrides $SELECTION_AGENT_DB; defaults to ./.cache/selection-agent.sqlite)",
        },
      },
      async run({ args }) {
        const rawLimit = typeof args.limit === "string" ? args.limit : "100";
        const limit = Number.parseInt(rawLimit, 10);
        if (!Number.isFinite(limit) || limit <= 0) {
          console.error(
            formatError({
              code: "INVALID_LIMIT",
              message: `--limit must be a positive integer, got "${rawLimit}"`,
              cause: "Each chart is fetched up to --limit entries per market+store.",
              fix: "rerun with --limit 100 (default) or another positive integer",
              docs: "https://github.com/apps-machine/selection-agent#commands",
            }),
          );
          process.exit(2);
        }
        let markets: string[] | undefined;
        try {
          markets = parseList(args.markets);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            formatError({
              code: "INVALID_MARKETS",
              message,
              cause: "--markets must be a comma-separated list of ISO alpha-2 codes.",
              fix: "rerun with --markets bd,th,vn,my,id (default) or another cluster",
              docs: "https://github.com/apps-machine/selection-agent#commands",
            }),
          );
          process.exit(2);
        }
        const dbPath =
          (typeof args.db === "string" && args.db) ||
          process.env.SELECTION_AGENT_DB ||
          "./.cache/selection-agent.sqlite";
        try {
          const result = await runSnapshot({ dbPath, limit, markets });
          process.stdout.write(
            `Snapshot written for ${result.day}: ${result.written} new, ${result.skipped} already present.\n`,
          );
          if (result.failures > 0) {
            process.stderr.write(
              `Note: ${result.failures} chart job(s) failed (markets: ${result.failedMarkets.join(", ")}).\n`,
            );
          }
          process.exit(0);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            formatError({
              code: "SNAPSHOT_FAILED",
              message,
              cause: "Snapshot writer failed before any rows were written.",
              fix: "Check network access, then rerun. Use --db to point at an alternate cache path.",
              docs: "https://github.com/apps-machine/selection-agent#commands",
            }),
          );
          process.exit(1);
        }
      },
    }),
    report: defineCommand({
      meta: {
        name: "report",
        description: "Generate reports from accumulated scan data (e.g., judge comparison).",
      },
      args: {
        "compare-judges": {
          type: "boolean",
          description: "Show text vs vision judge divergence",
          default: false,
        },
        "run-id": {
          type: "string",
          description: "Run id to inspect (default: latest scan in the DB)",
        },
        db: {
          type: "string",
          description:
            "SQLite DB path (overrides $SELECTION_AGENT_DB; default ./.cache/selection-agent.sqlite)",
        },
      },
      async run({ args }) {
        if (args["compare-judges"] !== true) {
          console.error(
            formatError({
              code: "MISSING_REPORT_FLAG",
              message: "report requires a report selector (currently only --compare-judges)",
              cause: "report does nothing on its own.",
              fix: "rerun with --compare-judges",
              docs: "https://github.com/apps-machine/selection-agent#commands",
            }),
          );
          process.exit(2);
        }
        const dbPath =
          (typeof args.db === "string" && args.db) ||
          process.env.SELECTION_AGENT_DB ||
          "./.cache/selection-agent.sqlite";
        const { Cache } = await import("../storage/cache.ts");
        const { compareJudges, renderJudgeDivergenceMarkdown } = await import(
          "../reporting/compare-judges.ts"
        );
        const cache = Cache.open(dbPath);
        try {
          const store = cache.judgeResultStore();
          const runId =
            (typeof args["run-id"] === "string" && args["run-id"]) || store.latestRunId();
          if (!runId) {
            console.error(
              formatError({
                code: "NO_RUNS",
                message: "no scan runs found in the DB",
                cause: `${dbPath} has no rows in judge_result.`,
                fix: "Run `selection-agent scan` first, or pass --db to point at the right DB.",
                docs: "https://github.com/apps-machine/selection-agent#commands",
              }),
            );
            process.exit(2);
          }
          const rows = store.selectByRunId(runId);
          const md = renderJudgeDivergenceMarkdown(compareJudges(rows.map((r) => r.result)));
          process.stdout.write(`${md}\n`);
          process.exit(0);
        } finally {
          cache.close();
        }
      },
    }),
  },
});

/**
 * Print the branded banner once, before citty parses argv. Skipped when
 * stdout is in JSON mode so machine consumers get pure JSON. This means
 * the very first thing a `npx @apps-machine/selection-agent` user sees
 * — including the no-arg help screen — is the brand.
 */
function shouldShowBanner(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format=json") return false;
    if (a === "--format" && argv[i + 1] === "json") return false;
    // Hide banner on --internal as well; internal subcommands print
    // structured output (JSON or markdown) that downstream tools may parse.
    if (a === "--internal") return false;
  }
  return true;
}

/**
 * Gate internal subcommands behind --internal flag.
 *
 * Why a runtime gate instead of a citty subCommands group: the public CLI's
 * --help screen MUST NOT list backtest/winner-score/opportunity, because
 * (a) they don't ship to npm consumers and (b) accidental discovery would
 * lead users to error paths.
 *
 * The internal CLI module lives at `src/backtest/cli.ts`, which is NOT in
 * package.json `files:` whitelist (verified by
 * tests/cli/internal-publish-boundary.test.ts via npm pack --dry-run).
 * Dynamic import means the production npm tarball never even references
 * the path; the import only resolves in dev/founder runs where the full
 * source tree is present.
 */
async function maybeRunInternal(argv: string[]): Promise<boolean> {
  const internalIdx = argv.indexOf("--internal");
  if (internalIdx === -1) return false;
  // Strip --internal from argv so the inner runMain sees a clean argv where
  // the subcommand is the next positional.
  const innerArgv = [...argv.slice(0, internalIdx), ...argv.slice(internalIdx + 1)];
  const subName = innerArgv[0];
  if (typeof subName !== "string" || subName.length === 0) {
    process.stderr.write(
      `${formatError({
        code: "INTERNAL_SUBCOMMAND_REQUIRED",
        message: "--internal requires a subcommand",
        cause: "No subcommand was passed after --internal.",
        fix: "rerun with one of: --internal backtest, --internal winner-score, --internal opportunity",
        docs: "docs/planning/agent-v1-foundation.md § Internal CLI subcommands",
      })}\n`,
    );
    process.exit(2);
    return true;
  }
  let internalModule: typeof import("../backtest/cli.ts");
  try {
    internalModule = await import("../backtest/cli.ts");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${formatError({
        code: "INTERNAL_MODULE_MISSING",
        message: `failed to load internal CLI module: ${message}`,
        cause:
          "src/backtest/cli.ts is not present in the published npm tarball — internal subcommands are dev/founder-only.",
        fix: "Run from the apps-machine/studio source tree (not from the published @apps-machine/selection-agent package).",
        docs: "docs/planning/agent-v1-foundation.md § Internal CLI subcommands",
      })}\n`,
    );
    process.exit(1);
    return true;
  }
  const sub = internalModule.INTERNAL_SUBCOMMANDS[subName];
  if (!sub) {
    process.stderr.write(
      `${formatError({
        code: "UNKNOWN_INTERNAL_SUBCOMMAND",
        message: `unknown internal subcommand "${subName}"`,
        cause: "Subcommand not in INTERNAL_SUBCOMMANDS dispatch table.",
        fix: `accepted: ${Object.keys(internalModule.INTERNAL_SUBCOMMANDS).join(", ")}`,
        docs: "docs/planning/agent-v1-foundation.md § Internal CLI subcommands",
      })}\n`,
    );
    process.exit(2);
    return true;
  }
  // Build a wrapper command that nests the chosen subcommand. citty's runMain
  // expects a top-level command; nesting via subCommands gives consistent
  // arg parsing + --help text.
  const wrapper = defineCommand({
    meta: { name: "selection-agent --internal", version: VERSION },
    subCommands: { [subName]: sub },
  });
  // Override process.argv so citty parses just the inner subcommand line.
  const original = process.argv;
  process.argv = [original[0] ?? "bun", original[1] ?? "selection-agent", ...innerArgv];
  try {
    await runMain(wrapper);
  } finally {
    process.argv = original;
  }
  return true;
}

const argv = process.argv.slice(2);
if (shouldShowBanner(argv)) {
  process.stdout.write(renderBanner());
}

// Hot-path optimization + race avoidance: when --internal is NOT present,
// invoke runMain synchronously (it returns a Promise but citty installs its
// own process.exit handler so we don't need to await). When --internal IS
// present, we MUST await the dynamic import in maybeRunInternal before the
// dispatch can occur. The two paths intentionally diverge so the citty hot
// path stays exactly as it was before this gate was added — preserving the
// existing test suite's runtime behavior (including --help under spawnSync).
if (argv.includes("--internal")) {
  // Async path — top-level await keeps process alive for the dynamic import.
  await maybeRunInternal(argv);
} else {
  runMain(main);
}
