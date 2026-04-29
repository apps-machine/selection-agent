import type { JudgeClient } from "../../src/judges/text-judge.ts";
import type { ImageFetcher, VisionJudgeClient } from "../../src/judges/vision-judge.ts";
import type {
  AppDetails,
  AppQuery,
  ChartEntry,
  ChartQuery,
  ScraperLib,
} from "../../src/scrapers/api.ts";

export interface FakeAppSpec {
  appId: string;
  title?: string;
  ratings?: number;
  score?: number;
  description?: string;
  screenshots?: string[];
  inAppPurchases?: boolean;
}

export function chartEntry(spec: FakeAppSpec): ChartEntry {
  return {
    appId: spec.appId,
    title: spec.title ?? spec.appId,
    developer: "FakeDev",
    primaryGenre: "Productivity",
    score: spec.score ?? 4.5,
    ratings: spec.ratings ?? 1_000,
    description: spec.description ?? "Fake description.",
    screenshots: spec.screenshots ?? [],
    inAppPurchases: spec.inAppPurchases ?? true,
  } as ChartEntry;
}

export interface FakeScraperLibOptions {
  /** Apps returned per market. Order = chart rank. */
  appsByMarket: Record<string, FakeAppSpec[]>;
  /** When set, every chart fetch throws. */
  chartError?: Error;
  /** When set, every detail fetch throws. */
  appError?: Error;
}

export function fakeScraperLib(opts: FakeScraperLibOptions): ScraperLib {
  return {
    async fetchChart(q: ChartQuery): Promise<ChartEntry[]> {
      if (opts.chartError) throw opts.chartError;
      return (opts.appsByMarket[q.market] ?? []).map(chartEntry);
    },
    async fetchApp(q: AppQuery): Promise<AppDetails> {
      if (opts.appError) throw opts.appError;
      const spec = (opts.appsByMarket[q.market] ?? []).find((a) => a.appId === q.appId);
      if (!spec) throw new Error(`fakeScraperLib: unknown app ${q.appId} in ${q.market}`);
      return chartEntry(spec) as AppDetails;
    },
  };
}

/** Always-throws scraper — used for the Apple-blocked test. */
export function blockedScraperLib(message = "blocked"): ScraperLib {
  return {
    async fetchChart() {
      throw new Error(message);
    },
    async fetchApp() {
      throw new Error(message);
    },
  };
}

export interface FakeJudgeOptions {
  forApp?: (name: string) => { score: number; confidence?: number };
  inputTokens?: number;
  outputTokens?: number;
  /** When set, the (calls > errorAfter)th call throws. */
  errorAfter?: number;
}

export function fakeTextClient(opts: FakeJudgeOptions = {}): JudgeClient {
  let calls = 0;
  return {
    messages: {
      async create(params) {
        calls += 1;
        if (opts.errorAfter !== undefined && calls > opts.errorAfter) {
          throw new Error("fakeTextClient: errorAfter exceeded");
        }
        const prompt = params.messages[0]?.content ?? "";
        const m = /Name: ([^\n]+)/.exec(prompt);
        const name = m?.[1] ?? "unknown";
        const score = opts.forApp?.(name).score ?? 5.0;
        const confidence = opts.forApp?.(name).confidence ?? 0.8;
        return {
          id: `msg-${calls}`,
          type: "message",
          role: "assistant",
          stop_reason: "tool_use",
          usage: {
            input_tokens: opts.inputTokens ?? 200,
            output_tokens: opts.outputTokens ?? 100,
          },
          content: [
            {
              type: "tool_use",
              id: `tu-${calls}`,
              name: "score_localization_gap",
              input: {
                locGapScore: score,
                reasoning: `fake reasoning for ${name}`,
                signals: {
                  hasNativeLanguage: false,
                  hasCulturalAdaptation: false,
                  hasLocalizedPaywall: false,
                  hasLocalPaymentMethod: false,
                },
                confidence,
              },
            },
          ],
        };
      },
    },
  };
}

export function fakeVisionClient(opts: FakeJudgeOptions = {}): VisionJudgeClient {
  let calls = 0;
  return {
    messages: {
      async create(params) {
        calls += 1;
        if (opts.errorAfter !== undefined && calls > opts.errorAfter) {
          throw new Error("fakeVisionClient: errorAfter exceeded");
        }
        const userBlocks = params.messages[0]?.content ?? [];
        const textBlock = userBlocks.find((b) => b.type === "text");
        const promptText = textBlock && textBlock.type === "text" ? textBlock.text : "";
        const m = /app "([^"]+)"/.exec(promptText);
        const name = m?.[1] ?? "unknown";
        const score = opts.forApp?.(name).score ?? 5.0;
        const confidence = opts.forApp?.(name).confidence ?? 0.7;
        return {
          id: `msg-${calls}`,
          type: "message",
          role: "assistant",
          stop_reason: "tool_use",
          usage: {
            input_tokens: opts.inputTokens ?? 500,
            output_tokens: opts.outputTokens ?? 100,
          },
          content: [
            {
              type: "tool_use",
              id: `tu-${calls}`,
              name: "score_cultural_fit",
              input: {
                culturalFitScore: score,
                reasoning: `fake vision reasoning for ${name}`,
                signals: {
                  screenshotsLocalized: false,
                  imagesCulturallyAdapted: false,
                  textInLanguage: false,
                  screenshotFreshness: "fresh",
                },
                confidence,
              },
            },
          ],
        };
      },
    },
  };
}

/** 1×1 transparent PNG in base64. Smallest valid image payload. */
const PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

export const fakeImageFetcher: ImageFetcher = async () => ({
  mediaType: "image/png",
  base64: PIXEL_PNG_B64,
});
