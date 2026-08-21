import { getAaisAiObservedRevisionSha256 } from "@/lib/ai/aais-ai-runtime-config";
import { describe, expect, it } from "vitest";
import {
  AaisFormalEvalError,
  runAaisFormalEval,
} from "../scripts/run-aais-ai-formal-eval";

const revision = "synthetic-deepseek-revision-v1";

describe("AAIS formal provider evaluation", () => {
  it("creates complete bilingual A1-A4 release evidence without raw output", async () => {
    const manifest = await runAaisFormalEval({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      endpoint: "https://api.deepseek.com/chat/completions",
      apiKey: "synthetic-test-key",
      evalVersion: "aais-deepseek-v4-flash-test-v1",
      fetchImpl: createProviderFetch(),
    });

    expect(manifest).toMatchObject({
      status: "passed",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      sampleCount: 8,
      blockedCount: 0,
      agentEvidence: {
        requiredAgents: ["A1", "A2", "A3", "A4"],
        coveredAgents: ["A1", "A2", "A3", "A4"],
        complete: true,
      },
      releaseEvidence: {
        runtimeContract: {
          thinkingMode: "disabled",
          temperature: 0.2,
          maxTokens: 600,
          observedRevisionSha256: getAaisAiObservedRevisionSha256(revision),
        },
        localeCoverage: {
          requiredLocales: ["zh-CN", "en-US"],
          coveredLocales: ["zh-CN", "en-US"],
          complete: true,
        },
      },
    });
    expect(manifest.results).toHaveLength(8);
    expect(manifest.results.every((result) => result.output === "omitted")).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain("synthetic-test-key");
    expect(JSON.stringify(manifest)).not.toContain(revision);
    for (const digest of [
      manifest.releaseEvidence.evalSuiteSha256,
      manifest.releaseEvidence.evalDataSha256,
      ...Object.values(manifest.releaseEvidence.agentPromptContractSha256),
      manifest.releaseEvidence.caBackgroundSha256,
      manifest.releaseEvidence.guardrailSha256,
    ]) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("fails closed when the provider omits an observed revision", async () => {
    await expect(runAaisFormalEval({
      provider: "qwen",
      model: "qwen3.8-max",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      apiKey: "synthetic-test-key",
      evalVersion: "aais-qwen38-test-v1",
      fetchImpl: createProviderFetch({ omitRevision: true }),
    })).rejects.toMatchObject({
      code: "AAIS_AI_FORMAL_EVAL_REVISION_MISSING",
    });
  });

  it("fails closed when the exact observed model does not match", async () => {
    let caught;
    try {
      await runAaisFormalEval({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        endpoint: "https://api.deepseek.com/chat/completions",
        apiKey: "synthetic-test-key",
        evalVersion: "aais-deepseek-v4-flash-test-v1",
        fetchImpl: createProviderFetch({ observedModel: "deepseek-other" }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AaisFormalEvalError);
    expect(caught).toMatchObject({
      code: "AAIS_AI_FORMAL_EVAL_PROVIDER_SAMPLE_FAILED",
    });
  });
});

function createProviderFetch(input: {
  omitRevision?: boolean;
  observedModel?: string;
} = {}): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({
      model: input.observedModel ?? body.model,
      ...(!input.omitRevision ? { system_fingerprint: revision } : {}),
      choices: [{
        finish_reason: "stop",
        message: { content: "OK." },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
