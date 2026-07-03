import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAaisAiEvaluation } from "../scripts/run-ai-eval.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-ai-eval-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS AI evaluation runner", () => {
  it("writes a passing redacted manifest for the configured OpenAI-compatible provider", async () => {
    const outputPath = path.join(tempDir, "manifest.json");
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "Provider coaching reply that should never be stored verbatim.",
            },
          },
        ],
      }),
    );

    const manifest = await runAaisAiEvaluation({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key-that-must-not-leak",
      model: "enterprise-model",
      evalVersion: "eval-2026-06-30",
      releaseId: "aais-2026-06-30-rc1",
      outputPath,
      fetchImpl: fetchMock,
      now: new Date("2026-06-30T00:00:00.000Z"),
      samples: enterpriseSamples(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer secret-api-key-that-must-not-leak",
    });
    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const firstUserContent = JSON.parse(firstPayload.messages[1].content);
    expect(firstUserContent.caBackground).toMatchObject({
      framework: "Cognitive Apprenticeship",
      sequence: ["Modelling", "Coaching", "Scaffolding", "Articulation", "Reflection"],
    });
    expect(firstUserContent.agentContract).toMatchObject({
      agentId: "A1",
      responsibility: "frontend-guide-scaffolding",
      caModules: ["Scaffolding", "Fading"],
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      evalVersion: "eval-2026-06-30",
      provider: "openai-compatible",
      model: "enterprise-model",
      status: "passed",
      passedAt: "2026-06-30T00:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      sampleCount: 4,
      blockedCount: 0,
      agentEvidence: {
        contractVersion: "aais-a1-a4-ca-eval-v2",
        requiredAgents: ["A1", "A2", "A3", "A4"],
        coveredAgents: ["A1", "A2", "A3", "A4"],
        requiredCaModules: ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"],
        coveredCaModules: ["Scaffolding", "Fading", "Modelling", "Coaching", "Articulation", "Reflection"],
        caBackgroundIncluded: true,
        rawPromptsStored: false,
        rawOutputsStored: false,
        complete: true,
      },
      redaction: {
        prompts: "summarized",
        secrets: "omitted",
      },
    });

    const written = JSON.parse(await readFile(outputPath, "utf8"));
    expect(written).toEqual(manifest);
    const serialized = JSON.stringify(written);
    expect(serialized).not.toContain("secret-api-key-that-must-not-leak");
    expect(serialized).not.toContain("How should I begin this task?");
    expect(serialized).not.toContain("Provider coaching reply");
  });

  it("writes a compact inline manifest JSON value for serverless environment variables", async () => {
    const outputPath = path.join(tempDir, "manifest.json");
    const envJsonOutputPath = path.join(tempDir, "manifest.env.json");
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "Provider coaching reply that should never be stored verbatim.",
            },
          },
        ],
      }),
    );

    const manifest = await runAaisAiEvaluation({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key-that-must-not-leak",
      model: "enterprise-model",
      evalVersion: "eval-2026-06-30",
      outputPath,
      envJsonOutputPath,
      fetchImpl: fetchMock,
      now: new Date("2026-06-30T00:00:00.000Z"),
      samples: enterpriseSamples(),
    });

    expect(await readFile(outputPath, "utf8")).toContain("\n  ");
    const inlineText = await readFile(envJsonOutputPath, "utf8");
    expect(inlineText.endsWith("\n")).toBe(true);
    expect(inlineText.trim()).not.toContain("\n");
    expect(JSON.parse(inlineText)).toEqual(manifest);
    expect(inlineText).not.toContain("secret-api-key-that-must-not-leak");
    expect(inlineText).not.toContain("How should I begin this task?");
    expect(inlineText).not.toContain("Provider coaching reply");
  });

  it("loads provider configuration from an ignored env file without storing secret values", async () => {
    const outputPath = path.join(tempDir, "manifest.json");
    const envFilePath = path.join(tempDir, "private.env");
    await writeFile(envFilePath, [
      "AAIS_AI_ENDPOINT=https://ai.example.test/v1/chat/completions",
      "AAIS_AI_API_KEY=secret-api-key-from-env-file",
      "AAIS_AI_MODEL=enterprise-model-from-env",
      "AAIS_AI_EVAL_VERSION=eval-2026-07-01",
      "AAIS_RELEASE_ID=aais-2026-07-01-rc1",
      "AAIS_AI_THINKING_MODE=disabled",
      "",
    ].join("\n"), "utf8");
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "Provider coaching reply that should never be stored verbatim.",
            },
          },
        ],
      }),
    );

    const manifest = await runAaisAiEvaluation({
      envFilePath,
      outputPath,
      fetchImpl: fetchMock,
      now: new Date("2026-07-01T00:00:00.000Z"),
      samples: enterpriseSamples(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://ai.example.test/v1/chat/completions");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer secret-api-key-from-env-file",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "enterprise-model-from-env",
      thinking: { type: "disabled" },
    });
    expect(manifest).toMatchObject({
      evalVersion: "eval-2026-07-01",
      model: "enterprise-model-from-env",
      release: {
        id: "aais-2026-07-01-rc1",
      },
      status: "passed",
    });
    const serialized = await readFile(outputPath, "utf8");
    expect(serialized).not.toContain("secret-api-key-from-env-file");
    expect(serialized).not.toContain("Provider coaching reply");
  });

  it("can disable provider thinking during live AI evaluation without storing secrets", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "Provider coaching reply that should never be stored verbatim.",
            },
          },
        ],
      }),
    );

    const manifest = await runAaisAiEvaluation({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key-that-must-not-leak",
      model: "enterprise-model",
      evalVersion: "eval-2026-06-30",
      thinkingMode: "disabled",
      fetchImpl: fetchMock,
      now: new Date("2026-06-30T00:00:00.000Z"),
      samples: enterpriseSamples(),
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(manifest.status).toBe("passed");
    expect(JSON.stringify(manifest)).not.toContain("secret-api-key-that-must-not-leak");
  });

  it("marks the manifest failed when a provider output trips the safety guardrail", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "password=provider-leaked-secret",
            },
          },
        ],
      }),
    );

    const manifest = await runAaisAiEvaluation({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key-that-must-not-leak",
      model: "enterprise-model",
      evalVersion: "eval-2026-06-30",
      fetchImpl: fetchMock,
      now: new Date("2026-06-30T00:00:00.000Z"),
      samples: enterpriseSamples(),
    });

    expect(manifest).toMatchObject({
      status: "failed",
      sampleCount: 4,
      blockedCount: 4,
      redaction: {
        prompts: "summarized",
        secrets: "omitted",
      },
    });
    expect(JSON.stringify(manifest)).not.toContain("provider-leaked-secret");
  });
});

function enterpriseSamples() {
  return [
    {
      id: "guide",
      agentId: "A1",
      label: "导学智能体",
      phase: "training",
      taskId: "training_task_1",
      caModules: ["Scaffolding", "Fading"],
      responsibility: "frontend-guide-scaffolding",
      interactionMode: "direct-student-dialogue",
      learnerInput: "How should I begin this task?",
      fallbackText: "Fallback guide.",
    },
    {
      id: "expert",
      agentId: "A2",
      label: "专家智能体",
      phase: "training",
      taskId: "training_task_1",
      caModules: ["Modelling", "Coaching"],
      responsibility: "frontend-expert-modelling-coaching",
      interactionMode: "direct-student-dialogue",
      learnerInput: "Show expert modelling and then coach me.",
      fallbackText: "Fallback expert.",
    },
    {
      id: "supervise",
      agentId: "A3",
      label: "监督智能体",
      phase: "practice",
      taskId: "practice_task_1",
      caModules: ["Scaffolding"],
      responsibility: "backend-supervision-a1-signal",
      interactionMode: "backend-to-a1-signal",
      learnerInput: "Summarize a low-progress signal for A1.",
      fallbackText: "Fallback supervision signal.",
    },
    {
      id: "reflect",
      agentId: "A4",
      label: "反思智能体",
      phase: "practice",
      taskId: "practice_task_1",
      caModules: ["Articulation", "Reflection"],
      responsibility: "backend-reflection-articulation",
      interactionMode: "backend-to-a1-reflection",
      learnerInput: "Help me compare my process with the expert trace.",
      fallbackText: "Fallback reflection.",
    },
  ];
}
