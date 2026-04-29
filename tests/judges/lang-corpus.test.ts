import { describe, expect, test } from "bun:test";
import corpus from "../../evals/fixtures/lang-corpus.json";
import targets from "../../evals/fixtures/lang-targets.json";

describe("lang-corpus.json", () => {
  test("has exactly 50 phrases (domain corpus)", () => {
    expect(corpus.phrases).toHaveLength(50);
  });

  test("phrases are non-empty strings", () => {
    for (const p of corpus.phrases) {
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
    }
  });

  test("source language is English", () => {
    expect(corpus.sourceLanguage).toBe("en");
  });

  test("phrases are unique", () => {
    const set = new Set(corpus.phrases);
    expect(set.size).toBe(corpus.phrases.length);
  });
});

describe("lang-targets.json", () => {
  test("includes 6 markets (founder-confirmed)", () => {
    expect(targets.targets).toHaveLength(6);
  });

  test("includes US, JP, DE, FR, BR, ES markets", () => {
    const markets = targets.targets.map((t) => t.market).sort();
    expect(markets).toEqual(["br", "de", "es", "fr", "jp", "us"]);
  });

  test("exactly one baseline entry", () => {
    const baselines = targets.targets.filter((t) => t.isBaseline);
    expect(baselines).toHaveLength(1);
    expect(baselines[0]?.market).toBe("us");
  });
});
