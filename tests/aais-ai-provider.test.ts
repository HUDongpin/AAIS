import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConfiguredAaisModelProvider,
  createOpenAiCompatibleAaisProvider,
} from "@/lib/ai/aais-ai-provider";
import { aaisCognitiveApprenticeshipBackground } from "@/data/aais";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("AAIS governed AI provider", () => {
  it("retries transient provider failures and returns redacted runtime metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        choices: [
          {
            message: {
              content: "受治理 provider 的导学回复",
            },
          },
        ],
      }));
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 1000,
      maxRetries: 1,
    });

    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(result.text).toBe("受治理 provider 的导学回复");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer secret-api-key",
    });
    expect(result.runtime).toMatchObject({
      provider: "openai-compatible",
      model: "enterprise-model",
      attempts: 2,
      status: "ok",
      redaction: {
        secrets: "omitted",
        prompt: "summarized",
      },
    });
    expect(JSON.stringify(result.runtime)).not.toContain("secret-api-key");
  });

  it("keeps production on deterministic fallback until model evaluation is approved", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "secret-api-key");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAaisModelProvider();
    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      text: "本地 fallback",
      runtime: {
        provider: "deterministic",
        status: "fallback",
      },
    });
  });

  it("blocks unsafe provider content and returns fallback without leaking the unsafe text", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "password=super-secret-value",
            },
          },
        ],
      }),
    );
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(result.text).toBe("本地 fallback");
    expect(result.runtime).toMatchObject({
      provider: "openai-compatible",
      status: "fallback",
      guardrail: {
        policy: "aais-age-appropriate-output-v1",
        status: "blocked",
        reasons: ["secret-like-content"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });

  it("sends an optional disabled-thinking payload for providers that require non-thinking chat output", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "受治理 provider 的导学回复",
            },
          },
        ],
      }),
    );
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 1000,
      maxRetries: 0,
      thinkingMode: "disabled",
    });

    await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("sends the Cognitive Apprenticeship background in the redacted model context", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "受治理 provider 的导学回复",
            },
          },
        ],
      }),
    );
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    await provider.generate({
      agentId: "A2",
      label: "专家智能体",
      role: "前端，与学生直接对话",
      mission: "两位专家共同完成一个任务，随后引导学生练习。",
      caModules: ["Modelling", "Coaching"],
      caBackground: aaisCognitiveApprenticeshipBackground,
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我想看专家怎么做。",
      workspaceState: {
        currentStep: "modelling",
      },
      fallbackText: "本地 fallback",
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const userContext = JSON.parse(payload.messages[1].content);
    expect(userContext.caBackground).toMatchObject({
      framework: "Cognitive Apprenticeship",
      sequence: ["Modelling", "Coaching", "Scaffolding", "Articulation", "Reflection"],
    });
    expect(userContext.caBackground.principles.map((principle: { id: string }) => principle.id)).toEqual([
      "modelling",
      "coaching",
      "scaffolding",
      "fading",
      "articulation",
      "reflection",
    ]);
    expect(JSON.stringify(payload)).not.toContain("secret-api-key");
  });
});
