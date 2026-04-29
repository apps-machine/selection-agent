#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { runDemo } from "../demo/run-demo.ts";
import { runSnapshot } from "../velocity/run-snapshot.ts";
import { formatError } from "./errors.ts";

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
        top: {
          type: "string",
          description: "Limit candidates returned",
          default: "30",
        },
        format: {
          type: "string",
          description: "Output format: markdown | json",
          default: "markdown",
        },
        "no-llm": {
          type: "boolean",
          description: "Run heuristics only, skip LLM judges",
          default: false,
        },
      },
      async run() {
        console.error(
          formatError({
            code: "NOT_IMPLEMENTED",
            message: "scan command lands in milestone M2",
            cause:
              "Selection Agent is currently scaffolded (M1). Live scrapers + scoring + judges arrive in M2-M6.",
            fix: "Run `selection-agent demo` to see the agent on cached data, or wait for M2.",
            docs: "https://github.com/apps-machine/selection-agent#milestones",
          }),
        );
        process.exit(2);
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
      },
      async run() {
        console.error(
          formatError({
            code: "NOT_IMPLEMENTED",
            message: "report command lands in milestone M6",
            cause: "Reports depend on judge results persisted in M4 + orchestrator pipeline in M6.",
            fix: "Wait for M6, or run `selection-agent demo` for the markdown brief preview.",
            docs: "https://github.com/apps-machine/selection-agent#milestones",
          }),
        );
        process.exit(2);
      },
    }),
  },
});

runMain(main);
