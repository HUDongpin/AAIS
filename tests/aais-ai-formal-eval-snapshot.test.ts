import { describe, expect, it, vi } from "vitest";
import {
  AaisFormalEvalError,
  runAaisFormalEval,
} from "../scripts/run-aais-ai-formal-eval";

const model = "qwen3.7-max-2026-06-08";
const endpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

describe("Qwen snapshot formal evaluation", () => {
  it("evaluates all A1-A4 contracts in both locales without retaining outputs", async () => {
    const rawOutput = "Short governed synthetic response.";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        model,
        choices: [{ finish_reason: "stop", message: { content: rawOutput } }],
      }),
    );

    const manifest = await runAaisFormalEval({
      model,
      endpoint,
      apiKey: "synthetic-key-not-a-secret",
      evalVersion: "aais-qwen37-snapshot-test-v1",
      now: new Date("2026-08-23T03:00:00.000Z"),
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      provider: "openai-compatible",
      providerFamily: "qwen",
      model,
      status: "passed",
      sampleCount: 8,
      blockedCount: 0,
      agentEvidence: {
        requiredAgents: ["A1", "A2", "A3", "A4"],
        coveredAgents: ["A1", "A2", "A3", "A4"],
        complete: true,
      },
      releaseEvidence: {
        runtimeContract: {
          requestedSnapshotModel: model,
          observationKind: "exact-provider-model-id",
        },
        localeCoverage: {
          requiredLocales: ["zh-CN", "en-US"],
          coveredLocales: ["zh-CN", "en-US"],
          complete: true,
        },
      },
      redaction: {
        prompts: "summarized",
        outputs: "omitted",
        secrets: "omitted",
        rawObservedModel: "omitted",
      },
    });
    expect(JSON.stringify(manifest)).not.toContain(rawOutput);
    for (const [, init] of fetchMock.mock.calls) {
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({
        model,
        enable_thinking: false,
        temperature: 0.2,
        max_tokens: expect.any(Number),
      });
    }
  });

  it("blocks the evaluation when the provider returns a different model id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: "qwen3.7-max",
        choices: [{ finish_reason: "stop", message: { content: "response" } }],
      }),
    );

    await expect(runAaisFormalEval({
      model,
      endpoint,
      apiKey: "synthetic-key-not-a-secret",
      evalVersion: "aais-qwen37-snapshot-test-v1",
      now: new Date("2026-08-23T03:00:00.000Z"),
      fetchImpl: fetchMock,
    })).rejects.toMatchObject({
      code: "AAIS_AI_FORMAL_EVAL_SAMPLE_CONTRACT_FAILED",
    } satisfies Partial<AaisFormalEvalError>);
  });
});
