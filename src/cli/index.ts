#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { runDemo } from "../demo/run-demo.ts";
import type { JudgeClient } from "../judges/text-judge.ts";
import type { ImageFetcher, VisionJudgeClient } from "../judges/vision-judge.ts";
import { runSnapshot } from "../velocity/run-snapshot.ts";
import { formatError } from "./errors.ts";

function parseList(v: unknown): string[] | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
    version: "0.0.1",
    description:
      "Apps Machine Selection Agent — ranks app opportunities globally via dual-store scraping + Claude judges.",
  },
  subCommands: {
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
          description: "Comma-separated ISO alpha-2 market codes (default: us,jp,de,fr,br,es)",
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
              fix: "Export ANTHROPIC_API_KEY=... or rerun with --no-llm.",
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
          "Daily Track B snapshot writer. Scrapes top-grossing across the 6 Phase 0 markets on both stores and persists one row per app per UTC day. Cron-friendly: scrape-only, no LLM calls.",
      },
      args: {
        limit: {
          type: "string",
          description: "Apps to capture per market+store",
          default: "100",
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
        const dbPath =
          (typeof args.db === "string" && args.db) ||
          process.env.SELECTION_AGENT_DB ||
          "./.cache/selection-agent.sqlite";
        try {
          const result = await runSnapshot({ dbPath, limit });
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

runMain(main);
