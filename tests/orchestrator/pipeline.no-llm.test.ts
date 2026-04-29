import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runScan } from "../../src/orchestrator/pipeline.ts";
import { Cache } from "../../src/storage/cache.ts";
import { fakeScraperLib } from "./fakes.ts";

describe("runScan — no LLM", () => {
  let cache: Cache;
  beforeEach(() => {
    cache = Cache.open(":memory:");
  });
  afterEach(() => cache.close());

  test("noLlm: true → judges never called, candidates ranked by heuristics", async () => {
    let textCalls = 0;
    const apps = {
      us: [{ appId: "us.app1" }, { appId: "us.app2" }, { appId: "us.app3" }],
    };
    const result = await runScan({
      cache,
      markets: ["us"],
      stores: ["apple"],
      topN: 5,
      noLlm: true,
      scrapers: {
        apple: fakeScraperLib({ appsByMarket: apps }),
        google: fakeScraperLib({ appsByMarket: { us: [] } }),
      },
      textClient: {
        messages: {
          async create() {
            textCalls += 1;
            throw new Error("text judge must not be called when noLlm:true");
          },
        },
      },
      visionClient: {
        messages: {
          async create() {
            throw new Error("vision judge must not be called when noLlm:true");
          },
        },
      },
      fetchImage: async () => {
        throw new Error("fetchImage must not be called when noLlm:true");
      },
      now: () => Date.parse("2026-04-29T12:00:00.000Z"),
      runIdSeed: "no-llm",
    });

    expect(textCalls).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(result.candidates.every((c) => c.textJudge === null)).toBe(true);
    expect(result.candidates.every((c) => c.visionJudge === null)).toBe(true);
    expect(result.candidates.length).toBe(3);
    expect(result.judgeResults).toEqual([]);
  });
});
