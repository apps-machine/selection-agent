import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AppTweakMetadataRecord } from "../../src/ground-truth/apptweak-jsonl.ts";
import {
  apptweakLocGapPromptVersion,
  runApptweakLocGapJudge,
} from "../../src/judges/apptweak-loc-gap-runner.ts";
import type { JudgeClient } from "../../src/judges/text-judge.ts";
import { runMigrations } from "../../src/storage/schema.ts";

function openTestDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function makeMockClient(score: number): JudgeClient {
  return {
    messages: {
      create: async () => ({
        id: "msg_x",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "score_localization_gap",
            input: {
              locGapScore: score,
              reasoning: "test reasoning",
              signals: {
                hasNativeLanguage: true,
                hasCulturalAdaptation: false,
                hasLocalizedPaywall: false,
                hasLocalPaymentMethod: false,
              },
              confidence: 0.8,
            },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 30 },
      }),
    },
  };
}

const sampleRecord: AppTweakMetadataRecord = {
  app_id: "abc",
  market: "id",
  store: "apple",
  device: "iphone",
  language: "id",
  t0: 1746316800000,
  metadata: {
    title: "App",
    description: "Long description",
  },
};

describe("runApptweakLocGapJudge", () => {
  test("persists one signal_snapshots row per record", async () => {
    const db = openTestDb();
    const client = makeMockClient(7.5);
    const stats = await runApptweakLocGapJudge({
      db,
      records: [sampleRecord],
      client,
      concurrency: 1,
    });
    expect(stats.judged).toBe(1);
    expect(stats.skipped).toBe(0);
    const rows = db
      .prepare("SELECT app_id, signal_name, t, value, llm_prompt_version FROM signal_snapshots")
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      app_id: "abc",
      signal_name: "locGap",
      t: 1746316800000,
      value: 7.5,
      llm_prompt_version: apptweakLocGapPromptVersion("id"),
    });
    db.close();
  });

  test("same app in two markets gets two rows (market-aware persistence)", async () => {
    const db = openTestDb();
    const client = makeMockClient(7.5);
    const recordId: AppTweakMetadataRecord = { ...sampleRecord, app_id: "X", market: "id" };
    const recordVn: AppTweakMetadataRecord = { ...sampleRecord, app_id: "X", market: "vn" };
    const stats = await runApptweakLocGapJudge({
      db,
      records: [recordId, recordVn],
      client,
      concurrency: 1,
    });
    expect(stats.judged).toBe(2);
    expect(stats.skipped).toBe(0);
    const rows = db
      .prepare("SELECT app_id, llm_prompt_version FROM signal_snapshots WHERE signal_name='locGap'")
      .all() as { app_id: string; llm_prompt_version: string }[];
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.llm_prompt_version).sort()).toEqual([
      "v1.0.0-apptweak-id",
      "v1.0.0-apptweak-vn",
    ]);
    db.close();
  });

  test("re-running same records skips already-persisted (resumable)", async () => {
    const db = openTestDb();
    const client = makeMockClient(7.5);
    await runApptweakLocGapJudge({ db, records: [sampleRecord], client, concurrency: 1 });
    const stats2 = await runApptweakLocGapJudge({
      db,
      records: [sampleRecord],
      client,
      concurrency: 1,
    });
    expect(stats2.judged).toBe(0);
    expect(stats2.skipped).toBe(1);
    db.close();
  });

  test("metadata=null shortcut: locGap=10, no API call", async () => {
    const db = openTestDb();
    let calls = 0;
    const client: JudgeClient = {
      messages: {
        create: async () => {
          calls += 1;
          throw new Error("should not call API for null metadata");
        },
      },
    };
    const nullRecord: AppTweakMetadataRecord = { ...sampleRecord, metadata: null };
    const stats = await runApptweakLocGapJudge({
      db,
      records: [nullRecord],
      client,
      concurrency: 1,
    });
    expect(stats.judged).toBe(1);
    expect(stats.shortcuts).toBe(1);
    expect(calls).toBe(0);
    const row = db.prepare("SELECT value FROM signal_snapshots").get() as { value: number };
    expect(row.value).toBe(10);
    db.close();
  });

  test("budget abort: stops calling API once budgetUsd exceeded", async () => {
    const db = openTestDb();
    let calls = 0;
    const client: JudgeClient = {
      messages: {
        create: async () => {
          calls += 1;
          return {
            id: "msg_x",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "score_localization_gap",
                input: {
                  locGapScore: 5,
                  reasoning: "x",
                  signals: {
                    hasNativeLanguage: false,
                    hasCulturalAdaptation: false,
                    hasLocalizedPaywall: false,
                    hasLocalPaymentMethod: false,
                  },
                  confidence: 0.5,
                },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 100_000, output_tokens: 1000 },
          };
        },
      },
    };
    const records = Array.from({ length: 10 }, (_, i) => ({
      ...sampleRecord,
      app_id: `app${i}`,
    }));
    const stats = await runApptweakLocGapJudge({
      db,
      records,
      client,
      concurrency: 1,
      budgetUsd: 0.01,
    });
    expect(stats.budgetAborted).toBe(true);
    expect(calls).toBeLessThan(10);
    db.close();
  });
});
