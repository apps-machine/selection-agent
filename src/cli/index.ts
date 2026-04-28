#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { formatError } from "./errors.ts";
import { runDemo } from "../demo/run-demo.ts";

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
        await runDemo({ format: args.format as "markdown" | "json" });
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
        console.error(formatError({
          code: "NOT_IMPLEMENTED",
          message: "scan command lands in milestone M2",
          cause: "Selection Agent is currently scaffolded (M1). Live scrapers + scoring + judges arrive in M2-M6.",
          fix: "Run `selection-agent demo` to see the agent on cached data, or wait for M2.",
          docs: "https://github.com/apps-machine/selection-agent#milestones",
        }));
        process.exit(2);
      },
    }),
    snapshot: defineCommand({
      meta: {
        name: "snapshot",
        description:
          "Daily Track B snapshot writer (velocity scaffolding, activates J14).",
      },
      async run() {
        console.error(formatError({
          code: "NOT_IMPLEMENTED",
          message: "snapshot command lands in milestone M5",
          cause: "Track B velocity scaffolding requires daily snapshots accumulated over 14 days.",
          fix: "Wait for M5, or run `selection-agent demo` for Track A preview.",
          docs: "https://github.com/apps-machine/selection-agent#milestones",
        }));
        process.exit(2);
      },
    }),
    report: defineCommand({
      meta: {
        name: "report",
        description:
          "Generate reports from accumulated scan data (e.g., judge comparison).",
      },
      args: {
        "compare-judges": {
          type: "boolean",
          description: "Show text vs vision judge divergence",
          default: false,
        },
      },
      async run() {
        console.error(formatError({
          code: "NOT_IMPLEMENTED",
          message: "report command lands in milestone M6",
          cause: "Reports depend on judge results persisted in M4 + orchestrator pipeline in M6.",
          fix: "Wait for M6, or run `selection-agent demo` for the markdown brief preview.",
          docs: "https://github.com/apps-machine/selection-agent#milestones",
        }));
        process.exit(2);
      },
    }),
  },
});

runMain(main);
