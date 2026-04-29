import { describe, test } from "bun:test";

const SHOULD_RUN =
  process.env.EVALS === "1" && typeof process.env.ANTHROPIC_API_KEY === "string";

describe.skipIf(!SHOULD_RUN)("vision-judge eval (live LLM, EVALS=1)", () => {
  test.todo(
    "wire real screenshot URLs from M2 fixtures + assert score ranges per case",
    () => {
      // Vision eval requires a curated screenshot fixture set: real binaries scraped
      // from the apps named in vision-judge-cases.json. Rather than ship synthetic
      // images that won't catch the regressions we care about (cultural adaptation,
      // text-in-language, freshness), this eval is wired up structurally and gated
      // on the founder providing the fixture binaries.
      //
      // To activate:
      //   1. Drop screenshot PNGs in evals/fixtures/screenshots/{case-id}/{1..5}.png
      //   2. Replace this todo with a forEach over vision-judge-cases.json that
      //      builds RawAppData with screenshotUrls = file:// paths
      //   3. Run EVALS=1 ANTHROPIC_API_KEY=… bun test evals/vision-judge.eval.ts
      //   4. Run WRITE_BASELINE=1 once to seed evals/baselines/vision-judge.json
    },
  );
});
